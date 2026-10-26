import { watch, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, rmSync, type FSWatcher } from "node:fs";
import { basename, isAbsolute, join, resolve, relative, sep } from "node:path";
import { renderPage, snippetFor } from "./render";
import { daemonPath, dataDir, ensureDataDir, homeDir, listening, projectId, readComments, readProjects, readTunnelConfig, update, writeProjects, type Comment } from "./store";

const UI = join(import.meta.dir, "..", "ui");
const SKIP = new Set(["node_modules", ".git", ".cdesign", "dist"]);

export function listHtml(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listHtml(root, p, out);
    else if (name.endsWith(".html") && !name.startsWith("_")) out.push(relative(root, p).split(sep).join("/"));
  }
  return out.sort();
}

type Selection = { file: string; cdId: string; uses: string[]; selector: string; tag: string; text: string; snippet: string };
type Project = {
  id: string;
  root: string;
  clients: Set<ReadableStreamDefaultController>;
  tabOf: Map<ReadableStreamDefaultController, string>;
  tabs: Map<string, { file: string | null; at: number; selection: Selection | null }>; // viewer tabs: the most recently active one is "the page the user has open"
  on: boolean; // an agent is listening (cdesign wait)
  watchers: FSWatcher[];
};

export const DEFAULT_PORT = 4747;
const enc = new TextEncoder();
const json = (v: unknown, status = 200) => Response.json(v, { status });

/** One process serves every registered project. A request's project comes from its Host (`<id>.localhost`), or `?project=<id>` on the bare host (used by the CLI). */
export async function serveDaemon(preferred = DEFAULT_PORT) {
  const projects = new Map<string, Project>();
  const idleMs = +(process.env.CDESIGN_IDLE_SECONDS ?? 120) * 1000;
  let lastActive = Date.now();
  let server: ReturnType<typeof Bun.serve>;

  const push = (p: Project, ev: string) => {
    for (const c of p.clients) {
      try {
        c.enqueue(enc.encode(`data: ${ev}\n\n`));
      } catch {
        drop(p, c);
      }
    }
  };
  const drop = (p: Project, c: ReadableStreamDefaultController) => {
    p.clients.delete(c);
    const id = p.tabOf.get(c);
    p.tabOf.delete(c);
    if (id) p.tabs.delete(id); // closed tab: the previous one becomes current again
  };
  const presence = (p: Project) => {
    const now = listening(p.root);
    if (now !== p.on) ((p.on = now), push(p, "agent"));
  };

  function addProject(root: string): Project {
    const old = projects.get(projectId(root));
    if (old) return old;
    const p: Project = { id: projectId(root), root, clients: new Set(), tabOf: new Map(), tabs: new Map(), on: false, watchers: [] };
    ensureDataDir(root);
    let ct: Timer | undefined, t: Timer | undefined;
    const quiet = (w: FSWatcher) => (w.on("error", () => {}), w);
    p.watchers.push(quiet(watch(dataDir(root), (_e, f) => {
      if (f === "agent.json") return presence(p);
      if (f !== "comments.json") return; // CLI edits (wait/resolve) reach the viewer too
      clearTimeout(ct);
      ct = setTimeout(() => push(p, "comments"), 50);
    })));
    p.watchers.push(quiet(watch(root, { recursive: true }, (_e, f) => {
      if (!f || f.split(sep).some((s) => SKIP.has(s))) return;
      clearTimeout(t);
      t = setTimeout(() => push(p, "reload"), 80);
    })));
    projects.set(p.id, p);
    persist();
    return p;
  }
  function removeProject(p: Project) {
    for (const w of p.watchers) w.close();
    for (const c of p.clients) try { c.close(); } catch { /* already closed */ }
    projects.delete(p.id);
    persist();
  }
  const persist = () => writeProjects([...projects.values()].map((p) => p.root));
  const list = (current: Project | null) => ({
    current: current?.id ?? null,
    projects: [...projects.values()].map((p) => ({ id: p.id, root: p.root, name: basename(p.root), url: `http://${p.id}.localhost:${server.port}/`, tabs: p.clients.size })),
  });

  // ----- tunnel: a second listener for the whole viewer (every project, switchable in the UI), exposed by `cloudflared` quick tunnel (random URL + secret) or the fixed domain from `tunnel set` -----
  type Tunnel = { token: string; url: string; proc: ReturnType<typeof Bun.spawn>; srv: ReturnType<typeof Bun.serve> };
  let tunnel: Tunnel | null = null;
  let tunnelHome = ""; // project a visitor lands on until they pick another (cookie)
  const stopTunnel = () => {
    const t = tunnel;
    if (!t) return;
    tunnel = null;
    try { t.proc.kill(); } catch { /* already gone */ }
    t.srv.stop(true);
  };
  async function startTunnel(): Promise<Tunnel> {
    if (tunnel) return tunnel;
    const cfg = readTunnelConfig(); // fixed domain, else a random quick tunnel
    const token = cfg ? cfg.secret ?? "" : crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""); // "" = open fixed domain, no secret
    const srv = Bun.serve({
      port: cfg?.port ?? 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch(req) {
        const url = new URL(req.url);
        const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/);
        const cookie = (n: string) => cookies.find((c) => c.startsWith(n + "="))?.slice(n.length + 1);
        const set: string[] = [];
        if (token && url.searchParams.get("t") === token) { url.searchParams.delete("t"); set.push(`cd_t=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`); }
        else if (token && cookie("cd_t") !== token) return new Response("unauthorized: open the full link printed by cdesign", { status: 401 });
        const pick = url.searchParams.get("project"); // the project switcher: remember the choice in a cookie
        if (pick && projects.has(pick)) { url.searchParams.delete("project"); set.push(`cd_p=${pick}; Path=/; HttpOnly; SameSite=Lax`); }
        if (set.length) {
          const h = new Headers({ location: url.pathname + url.search });
          for (const c of set) h.append("set-cookie", c);
          return new Response(null, { status: 302, headers: h });
        }
        const project = projects.get(cookie("cd_p") ?? "") ?? projects.get(tunnelHome) ?? [...projects.values()][0];
        if (!project) return new Response("no project is open in cdesign", { status: 404 });
        return fetchHandler(req, project, true);
      },
    });
    const bin = cfg?.provider === "ngrok" ? "ngrok" : "cloudflared";
    const args =
      cfg?.provider === "ngrok" ? ["http", `--url=https://${cfg.domain}`, "--log=stdout", "--log-format=json", String(srv.port)]
      : cfg?.provider === "cloudflare" ? ["tunnel", "--no-autoupdate", "run", "--token", cfg.token]
      : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${srv.port}`];
    // what the tool prints when the tunnel is up (quick tunnels also print their random URL)
    const ready = cfg?.provider === "ngrok" ? /started tunnel|obj=tunnels/ : cfg?.provider === "cloudflare" ? /Registered tunnel connection/ : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], { stdout: bin === "ngrok" ? "pipe" : "ignore", stderr: "pipe" });
    } catch {
      srv.stop(true);
      throw new Error(bin === "ngrok" ? "ngrok not found. Install it: https://ngrok.com/download (then `ngrok config add-authtoken <token>`)" : "cloudflared not found. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    }
    const url = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`${bin} did not report a tunnel within 30s${tail ? `: ${tail.trim().slice(-300)}` : ""}`)), 30000);
      let tail = "";
      proc.exited.then(() => (clearTimeout(timer), fail(new Error(`${bin} exited before the tunnel was ready${tail ? `: ${tail.trim().slice(-300)}` : ""}`))));
      const watch = async (stream: ReadableStream<Uint8Array>) => {
        let seen = "";
        for await (const chunk of stream) { // keep draining so the pipe never blocks
          const text = new TextDecoder().decode(chunk);
          tail = (tail + text).slice(-2000);
          seen = (seen + text).slice(-2000);
          const m = seen.match(ready);
          if (m) { clearTimeout(timer); ok(cfg ? `https://${cfg.domain}` : m[0]); seen = ""; }
        }
      };
      watch(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
      if (bin === "ngrok") watch(proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
    }).catch((e) => {
      try { proc.kill(); } catch { /* ignore */ }
      srv.stop(true);
      throw e;
    });
    const t = { token, url, proc, srv };
    tunnel = t;
    proc.exited.then(() => tunnel === t && stopTunnel());
    return t;
  }

  const shutdown = () => {
    stopTunnel();
    try { rmSync(daemonPath()); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  setInterval(() => { for (const p of projects.values()) push(p, "ping"); }, 5000); // keep SSE connections alive
  setInterval(() => { for (const p of projects.values()) presence(p); }, 3000); // a killed `wait` stops beating: notice it going stale
  // nothing left to serve (no viewer tab, no listening agent) for a while: exit, so no process is left behind
  setInterval(() => {
    if ([...projects.values()].some((p) => p.clients.size || listening(p.root))) lastActive = Date.now();
    else if (Date.now() - lastActive > idleMs) shutdown();
  }, Math.min(5000, Math.max(200, idleMs / 4)));

  /** `via` is set for requests that came through a tunnel: pinned to that project (the visitor switches with the project cookie); only the project list is readable, no other daemon-level routes. */
  const fetchHandler = async (req: Request, via?: Project, remote = false): Promise<Response> => {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname);
    const hostHeader = req.headers.get("host") ?? "";
    const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
    let project: Project | null = via ?? null;
    if (via) { /* host was checked by the tunnel */ }
    else if (host.endsWith(".localhost")) {
      project = projects.get(host.slice(0, -".localhost".length)) ?? null;
      if (!project) return new Response("unknown cdesign project", { status: 404 });
    } else if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return new Response("forbidden", { status: 403 }); // DNS rebinding
    else if (url.searchParams.has("project")) project = projects.get(url.searchParams.get("project")!) ?? null;

    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (origin && origin !== "null" && new URL(origin).host !== hostHeader) return new Response("forbidden", { status: 403 }); // cross-site write
      if (origin === "null") return new Response("forbidden", { status: 403 });
    }

    if (p === "/__cd/overlay.js") return new Response(Bun.file(join(UI, "overlay.js")));
    if (p === "/") return new Response(Bun.file(join(UI, "index.html")));

    // ----- daemon-level API -----
    if (p === "/__cd/projects" && req.method === "GET") return json(remote ? { current: via!.id, remote: true, projects: [...projects.values()].map((q) => ({ id: q.id, name: basename(q.root), url: `/?project=${q.id}`, tabs: q.clients.size })) } : list(project));
    if (via && (p.startsWith("/__cd/projects") || p === "/__cd/shutdown")) return new Response("forbidden", { status: 403 });
    if (p === "/__cd/projects" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { root?: string };
      const root = b.root ? resolve(b.root) : "";
      if (!root || !isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) return json({ error: "root must be an existing folder" }, 400);
      if (!existsSync(join(root, "design", "design-system.md")))
        Bun.spawnSync([process.execPath, join(import.meta.dir, "cli.ts"), "init", root], { stdio: ["ignore", "ignore", "ignore"] });
      const a = addProject(root);
      lastActive = Date.now();
      return json({ id: a.id, root: a.root, url: `http://${a.id}.localhost:${server.port}/`, tabs: a.clients.size });
    }
    const rm = p.match(/^\/__cd\/projects\/([^/]+)\/remove$/);
    if (rm && req.method === "POST") {
      const a = projects.get(rm[1]);
      if (a) removeProject(a);
      if (!projects.size) setTimeout(shutdown, 200); // last project closed: nothing left to serve
      return json({ ok: true, remaining: projects.size });
    }
    const tn = p.match(/^\/__cd\/projects\/([^/]+)\/tunnel(\/stop)?$/);
    if (tn && req.method === "POST") {
      const a = projects.get(tn[1]);
      if (!a) return json({ error: "unknown project" }, 404);
      if (tn[2]) return (stopTunnel(), json({ ok: true }));
      try {
        const t = await startTunnel();
        tunnelHome = a.id;
        lastActive = Date.now();
        return json({ url: `${t.url}/?project=${a.id}${t.token ? `&t=${t.token}` : ""}` });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }
    if (p === "/__cd/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 100);
      return json({ ok: true });
    }

    if (!project) return json({ error: "no project: open one via its <id>.localhost address or pass ?project=<id>" }, 404);
    const { root } = project;
    lastActive = Date.now();
    const tab = (id: string) => project!.tabs.get(id) ?? (project!.tabs.set(id, { file: null, at: 0, selection: null }), project!.tabs.get(id)!);
    const current = () => [...project!.tabs.values()].filter((t) => t.file).sort((a, b) => b.at - a.at)[0] ?? null;

    if (p === "/__cd/files") return json(listHtml(root));

    if (p === "/__cd/events") {
      let ctrl!: ReadableStreamDefaultController;
      const tabId = url.searchParams.get("tab");
      const pr = project;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          pr.clients.add(c);
          if (tabId) pr.tabOf.set(c, tabId);
          c.enqueue(enc.encode(": hi\n\n"));
        },
        cancel() {
          drop(pr, ctrl);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }

    if (p === "/__cd/page" && req.method === "GET") {
      const t = url.searchParams.has("tab") ? project.tabs.get(url.searchParams.get("tab")!) ?? null : current();
      return json({ file: t?.file ?? null, selection: t?.selection ?? null });
    }

    if (p === "/__cd/page" && req.method === "POST") {
      const b = (await req.json()) as { tabId?: string; file?: string | null };
      if (!b.tabId) return json({ error: "tabId required" }, 400);
      const t = tab(b.tabId);
      if (t.file !== (b.file ?? null)) t.selection = null; // a selection belongs to one page
      t.file = b.file ?? null;
      t.at = Date.now();
      return json({ ok: true });
    }

    if (p === "/__cd/selection" && req.method === "POST") {
      const b = (await req.json()) as { tabId?: string; selection?: Omit<Selection, "snippet"> | null };
      if (!b.tabId) return json({ error: "tabId required" }, 400);
      const t = tab(b.tabId);
      t.at = Date.now();
      if (!b.selection) {
        t.selection = null;
        return json({ ok: true });
      }
      let snippet = "";
      try {
        snippet = snippetFor(await Bun.file(join(root, b.selection.file)).text(), b.selection.cdId);
      } catch {}
      t.selection = { ...b.selection, uses: b.selection.uses ?? [], snippet };
      return json({ ok: true });
    }

    if (p === "/__cd/agent") return json({ listening: listening(root) });

    if (p === "/__cd/comments" && req.method === "GET") return json(readComments(root));

    if (p === "/__cd/comments" && req.method === "POST") {
      const b = (await req.json()) as Pick<Comment, "file" | "cdId" | "selector" | "text"> & { uses?: string[] };
      if (!b.file || !b.cdId || !b.text?.trim()) return json({ error: "file, cdId, text required" }, 400);
      let snippet = "";
      try {
        snippet = snippetFor(await Bun.file(join(root, b.file)).text(), b.cdId);
      } catch {}
      const c: Comment = {
        id: Math.random().toString(36).slice(2, 8),
        file: b.file,
        cdId: b.cdId,
        uses: b.uses ?? [],
        selector: b.selector ?? "",
        snippet,
        text: b.text.trim(),
        status: "draft",
        createdAt: new Date().toISOString(),
      };
      update(root, (l) => l.push(c));
      push(project, "comments");
      return json(c, 201);
    }

    if (p === "/__cd/send" && req.method === "POST") {
      let n = 0;
      update(root, (l) => l.forEach((c) => c.status === "draft" && ((c.status = "queued"), n++)));
      push(project, "comments");
      return json({ queued: n });
    }

    const m = p.match(/^\/__cd\/comments\/([^/]+)\/(done|open|delete)$/);
    if (m && req.method === "POST") {
      update(root, (l) => {
        const i = l.findIndex((c) => c.id === m[1]);
        if (i < 0) return;
        if (m[2] === "delete") l.splice(i, 1);
        else l[i].status = m[2] === "open" ? "draft" : "done";
      });
      push(project, "comments");
      return json({ ok: true });
    }

    // project files (previews live under /p/, bare paths work for absolute asset urls)
    const rel = p.startsWith("/p/") ? p.slice(3) : p.slice(1);
    const abs = resolve(root, rel);
    if (!abs.startsWith(root + sep) && abs !== root) return new Response("forbidden", { status: 403 });
    const f = Bun.file(abs);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    if (abs.endsWith(".html") && p.startsWith("/p/")) {
      const html = renderPage(root, rel);
      const tag = url.searchParams.has("raw") ? "" : `<script src="/__cd/overlay.js"></script>`; // raw: screenshots, no commenting overlay
      const body = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + "</body>") : html + tag;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(f, { headers: { "cache-control": "no-store" } });
  };

  const bind = (port: number) => Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => fetchHandler(req) });
  try {
    server = bind(preferred);
  } catch (e) {
    // the default port is busy: another daemon already runs (then we are redundant) or something else holds it
    try {
      if ((await fetch(`http://127.0.0.1:${preferred}/__cd/projects`, { signal: AbortSignal.timeout(1000) })).ok) process.exit(0);
    } catch { /* not a cdesign daemon */ }
    server = bind(0);
  }
  for (const root of readProjects()) addProject(root);
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(daemonPath(), JSON.stringify({ port: server.port, pid: process.pid, startedAt: Date.now() }));
  return { server, addProject };
}
