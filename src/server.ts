import { watch, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync, rmSync, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, resolve, relative, sep } from "node:path";
import { adapter, listPages, sourceSnippet, tailwindCss, errorDocument, insideProject } from "./modes";
import { readConfig, configure, type SetupOptions } from "./project";
import { invalidateReact, reactAsset } from "./react";
import { uiAsset } from "./ui";
import { daemonPath, dataDir, ensureDataDir, homeDir, listening, projectId, readComments, readProjects, readTunnelConfig, readTunnelRuntime, update, writeProjects, writeTunnelRuntime, type Comment } from "./store";

import { exportWebsite, previewWebsite, websiteDefaults, saveWebsite, type WebsiteOptions } from "./export";
import { publishWebsite, publishingStatus, shareScreen, listShares, deleteShare } from "./publish";
import { colorTokens, sizeTokens } from "./tokens";
import { applyEdit, editInfo } from "./edit";
import { contextChips } from "./chat-context";
import { listFlows, syncItems, markOutdated, markSynced, clearOutdated } from "./flows";
import { ProjectChat, ChatError, MAX_BODY, capabilitiesOf, commandsOf } from "./chat";
import { Updater, runtimeFingerprint } from "./updater";
import { PROVIDERS } from "./chat-registry";
const websitePreviews = new Map<string, ReturnType<typeof previewWebsite>>();
const websiteJobs = new Set<string>();
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

type Selection = { file: string; cdId: string; uses: string[]; selector: string; tag: string; text: string; snippet: string; size?: string };
type Project = {
  id: string;
  root: string;
  clients: Set<ReadableStreamDefaultController>;
  tabOf: Map<ReadableStreamDefaultController, string>;
  tabs: Map<string, { file: string | null; at: number; selection: Selection | null }>; // viewer tabs: the most recently active one is "the page the user has open"
  on: boolean; // an agent is listening (cdesign wait)
  undo: { file: string; before: string; after: string }[]; // direct style edits from the Select panel
  watchers: FSWatcher[];
};

export const DEFAULT_PORT = 4747;
export const DEFAULT_TUNNEL_PORT = 4748;
const enc = new TextEncoder();
const json = (v: unknown, status = 200) => Response.json(v, { status });
const alivePid = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tunnelConfigHash = (cfg: ReturnType<typeof readTunnelConfig>) => createHash("sha1").update(JSON.stringify(cfg ?? null)).digest("hex");

/** One process serves every registered project. A request's project comes from its Host (`<id>.localhost`), or `?project=<id>` on the bare host (used by the CLI). */
export async function serveDaemon(preferred = DEFAULT_PORT) {
  const projects = new Map<string, Project>();
  const chats = new Map<string, ProjectChat>(); // private per-project chat: its own streams, never `push`ed to preview clients
  const chatOf = (p: Project) => chats.get(p.id) ?? (chats.set(p.id, new ProjectChat(p.root)), chats.get(p.id)!);
  const idleMs = +(process.env.CDESIGN_IDLE_SECONDS ?? 120) * 1000;
  const tunnelIdleMs = +(process.env.CDESIGN_TUNNEL_IDLE_SECONDS ?? 43200) * 1000; // 12h while a tunnel is active
  const updater = new Updater();
  const instance = crypto.randomUUID();
  const startedAt = Date.now();
  const fingerprint = runtimeFingerprint();
  let updating = false;
  let shuttingDown = false;
  let pendingChatStarts = 0;
  let lastActive = Date.now();
  let server!: ReturnType<typeof Bun.serve>;

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
    const p: Project = { id: projectId(root), root, clients: new Set(), tabOf: new Map(), tabs: new Map(), on: false, watchers: [], undo: [] };
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
      invalidateReact(root);
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
    chats.get(p.id)?.close();
    chats.delete(p.id);
    invalidateReact(p.root);
    projects.delete(p.id);
    persist();
  }
  const persist = () => writeProjects([...projects.values()].map((p) => p.root));
  const list = (current: Project | null) => ({
    current: current?.id ?? null,
    instance,
    projects: [...projects.values()].map((p) => ({ id: p.id, root: p.root, name: basename(p.root), url: `http://${p.id}.localhost:${server.port}/`, tabs: p.clients.size })),
  });

  // ----- tunnel: a second listener for the whole viewer (every project, switchable in the UI), exposed by `cloudflared` quick tunnel (random URL) or the fixed domain from `tunnel set`; no auth: whoever has the link can open it -----
  type Tunnel = { url: string; pid: number; port: number; srv: ReturnType<typeof Bun.serve>; proc?: ReturnType<typeof Bun.spawn> };
  let tunnel: Tunnel | null = null;
  let tunnelStarting: Promise<Tunnel> | null = null;
  let tunnelError = "";
  let tunnelHome = ""; // project a visitor lands on until they pick another (cookie)

  const createTunnelServer = (port: number) => Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const cookies = (req.headers.get("cookie") ?? "").split(/;\s*/);
      const cookie = (n: string) => cookies.find((c) => c.startsWith(n + "="))?.slice(n.length + 1);
      const set: string[] = [];
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

  async function bindTunnelPort(port: number, allowRandomFallback: boolean) {
    if (port === 0) return createTunnelServer(0);
    for (let i = 0; i < 20; i++) {
      try { return createTunnelServer(port); }
      catch (e) { if (i === 19) { if (allowRandomFallback) return createTunnelServer(0); throw e; } await Bun.sleep(50); }
    }
    return createTunnelServer(0);
  }

  const stopTunnel = (preserveProcess = false) => {
    const t = tunnel;
    if (!t) return;
    tunnel = null;
    t.srv.stop(true);
    if (preserveProcess) {
      const cfg = readTunnelConfig();
      writeTunnelRuntime({ pid: t.pid, url: t.url, port: t.port, home: tunnelHome, configHash: tunnelConfigHash(cfg) });
      return;
    }
    try { process.kill(t.pid); } catch { /* already gone */ }
    writeTunnelRuntime(null);
  };

  async function adoptTunnel() {
    const saved = readTunnelRuntime();
    if (!saved) return;
    const cfg = readTunnelConfig();
    if (!alivePid(saved.pid) || saved.configHash !== tunnelConfigHash(cfg)) {
      if (alivePid(saved.pid)) try { process.kill(saved.pid); } catch { /* ignore */ }
      writeTunnelRuntime(null);
      return;
    }
    try {
      const srv = await bindTunnelPort(saved.port, false);
      tunnelHome = saved.home ?? "";
      tunnel = { url: saved.url, pid: saved.pid, port: srv.port!, srv };
    } catch {
      try { process.kill(saved.pid); } catch { /* ignore */ }
      writeTunnelRuntime(null);
    }
  }

  async function startTunnel(): Promise<Tunnel> {
    if (tunnel) return tunnel;
    const cfg = readTunnelConfig(); // fixed domain, else a random quick tunnel
    const srv = await bindTunnelPort(cfg?.port ?? DEFAULT_TUNNEL_PORT, !cfg);
    const bin = cfg?.provider === "ngrok" ? "ngrok" : "cloudflared";
    const args =
      cfg?.provider === "ngrok" ? ["http", `--url=https://${cfg.domain}`, "--log=stdout", "--log-format=json", String(srv.port)]
      : cfg?.provider === "cloudflare" ? ["tunnel", "--no-autoupdate", "run", "--token", cfg.token]
      : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${srv.port}`];
    // what the tool prints when the tunnel is up (quick tunnels also print their random URL)
    const ready = cfg?.provider === "ngrok" ? /started tunnel|obj=tunnels/ : cfg?.provider === "cloudflare" ? /Registered tunnel connection/ : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: bin === "ngrok" ? "pipe" : "ignore", stderr: "pipe", detached: true });
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
    proc.unref();
    const t: Tunnel = { url, pid: proc.pid, port: srv.port!, srv, proc };
    tunnel = t;
    writeTunnelRuntime({ pid: t.pid, url: t.url, port: t.port, home: tunnelHome, configHash: tunnelConfigHash(cfg) });
    proc.exited.then(() => tunnel === t && stopTunnel());
    return t;
  }

  function ensureTunnel(): Promise<Tunnel> {
    if (tunnel && !alivePid(tunnel.pid)) stopTunnel();
    if (tunnel) return Promise.resolve(tunnel);
    if (!tunnelStarting) {
      tunnelError = "";
      tunnelStarting = startTunnel().catch((e) => { tunnelError = (e as Error).message; throw e; }).finally(() => { tunnelStarting = null; });
    }
    return tunnelStarting;
  }

  const shutdown = (options?: { preserveTunnel?: boolean }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server?.stop(true); } catch { /* already stopped */ }
    stopTunnel(Boolean(options?.preserveTunnel));
    for (const c of chats.values()) c.close(); // no agent keeps running after the daemon
    try {
      const current = JSON.parse(readFileSync(daemonPath(), "utf8")) as { pid?: number };
      if (current.pid === process.pid) rmSync(daemonPath(), { force: true });
    } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown());
  process.on("SIGINT", () => shutdown());

  setInterval(() => { for (const p of projects.values()) push(p, "ping"); }, 5000); // keep SSE connections alive
  setInterval(() => {
    for (const p of projects.values()) presence(p);
    if (tunnel && !alivePid(tunnel.pid)) stopTunnel();
  }, 3000); // a killed `wait` stops beating: notice it going stale
  // nothing left to serve (no viewer tab, no listening agent) for a while: exit, so no process is left behind
  setInterval(() => {
    if (updating || [...projects.values()].some((p) => p.clients.size || listening(p.root) || chats.get(p.id)?.busy)) lastActive = Date.now();
    else if (Date.now() - lastActive > (tunnel ? tunnelIdleMs : idleMs)) shutdown();
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
      if (origin) {
        try {
          if (new URL(origin).host !== hostHeader) return new Response("forbidden", { status: 403 });
        } catch { return new Response("forbidden", { status: 403 }); }
      }
    }

    if (p === "/__cd/overlay.js") return new Response(Bun.file(join(UI, "overlay.js")), { headers: { "cache-control": "no-store" } });
    if (p.startsWith("/__cd/app/")) {
      const asset = await uiAsset(UI, p.slice("/__cd/app/".length));
      if (!asset) return new Response("not found", { status: 404 });
      return new Response(asset, { headers: { "cache-control": "no-store" } });
    }
    if (p === "/manifest.webmanifest") return new Response(Bun.file(join(UI, "manifest.webmanifest")), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-store" } });
    if (p === "/sw.js") return new Response(Bun.file(join(UI, "sw.js")), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "service-worker-allowed": "/" } });
    if (p === "/__cd/icon.svg" || p === "/favicon.ico") return new Response(Bun.file(join(UI, "icon.svg")), { headers: { "content-type": "image/svg+xml", "cache-control": "no-cache" } });
    if (p === "/__cd/icon-192.png" || p === "/__cd/icon-512.png" || p === "/__cd/apple-touch-icon.png") return new Response(Bun.file(join(UI, p.slice(6))), { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
    if (p === "/") return new Response(Bun.file(join(UI, "index.html")), { headers: { "cache-control": "no-store" } });

    // ----- daemon-level API -----
    if (!via && p === "/__cd/health" && req.method === "GET") {
      return json({ ok: true, pid: process.pid, port: server.port, startedAt, instance, fingerprint, tunnel: tunnel?.url ?? null, projects: projects.size });
    }
    if (p === "/__cd/update") {
      if (remote) return json({ error: "Updates are available only in the local viewer." }, 403);
      if (req.method === "GET") return json({ ...(updating ? { available: true } : updater.status()), instance, updating });
      if (req.method === "POST") {
        if (req.headers.get("origin") !== `http://${hostHeader}`) return json({ error: "Use the local viewer to update cdesign." }, 403);
        if (!updater.supported) return json({ error: "This installation does not support viewer updates." }, 409);
        if (updating) return json({ error: "An update is already running." }, 409);
        if (pendingChatStarts || websiteJobs.size || [...chats.values()].some((chat) => chat.busy)) {
          return json({ error: "Wait for the agent turn or website job to finish, then try updating again." }, 409);
        }
        updating = true;
        try {
          await updater.apply();
          if (updater.linked) await updater.verifyRuntime();
          Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "daemon", "--port", String(server.port)], {
            env: { ...process.env, CDESIGN_RESTART_PID: String(process.pid) },
            cwd: homeDir(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
          }).unref();
          setTimeout(() => shutdown({ preserveTunnel: true }), 150);
          return json({ instance });
        } catch (error) {
          updating = false;
          return json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
    }
    if (p === "/__cd/projects" && req.method === "GET") return json(remote ? { current: via!.id, instance, remote: true, projects: [...projects.values()].map((q) => ({ id: q.id, name: basename(q.root), url: `/?project=${q.id}`, tabs: q.clients.size })) } : list(project));
    if (!via && p === "/__cd/tunnel" && req.method === "GET") {
      lastActive = Date.now(); // The project picker has no event stream but is still an open viewer.
      return json({ url: tunnel?.url ?? null, starting: !!tunnelStarting, error: tunnelError });
    }
    if (!via && p === "/__cd/tunnel" && req.method === "POST") {
      try { return json({ url: (await ensureTunnel()).url }); }
      catch (e) { return json({ error: (e as Error).message }, 500); }
    }
    if (!via && p === "/__cd/tunnel/stop" && req.method === "POST") {
      stopTunnel();
      return json({ ok: true });
    }
    if (!via && p === "/__cd/tunnel/restart" && req.method === "POST") {
      stopTunnel();
      try { return json({ url: (await ensureTunnel()).url }); }
      catch (e) { return json({ error: (e as Error).message }, 500); }
    }
    if (via && (p.startsWith("/__cd/projects") || p === "/__cd/shutdown" || p === "/__cd/setup")) return new Response("forbidden", { status: 403 });
    if (p === "/__cd/setup" && req.method === "GET") {
      const root = url.searchParams.get("root") ?? "";
      if (!isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) return json({ error: "root must be an existing absolute folder" }, 400);
      try {
        const config = readConfig(root);
        return json({ config, existing: existsSync(join(root, "design/cdesign.json")) || existsSync(join(root, "design/design-system.md")) || config.mode === "html" });
      } catch (e) { return json({ error: String(e) }, 400); }
    }
    if (p === "/__cd/projects" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { root?: string; mode?: SetupOptions["mode"]; tailwind?: boolean };
      const root = b.root ? resolve(b.root) : "";
      if (!root || !isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) return json({ error: "root must be an existing folder" }, 400);
      try {
        configure(root, { ...(b.mode === undefined ? {} : { mode: b.mode }), ...(b.tailwind === undefined ? {} : { tailwind: b.tailwind }) });
        if (!existsSync(join(root, "design", "design-system.md"))) {
          const init = Bun.spawnSync([process.execPath, join(import.meta.dir, "cli.ts"), "init", root], { stdio: ["ignore", "pipe", "pipe"] });
          if (init.exitCode) throw new Error(init.stderr.toString());
        }
      } catch (e) { return json({ error: String(e) }, 400); }
      const a = addProject(root);
      lastActive = Date.now();
      return json({ id: a.id, root: a.root, url: `http://${a.id}.localhost:${server.port}/`, tabs: a.clients.size });
    }
    const rm = p.match(/^\/__cd\/projects\/([^/]+)\/remove$/);
    if (rm && req.method === "POST") {
      const a = projects.get(rm[1]);
      if (a) {
        removeProject(a);
        if (!projects.size) stopTunnel();
      }
      return json({ ok: true, remaining: projects.size });
    }
    const tn = p.match(/^\/__cd\/projects\/([^/]+)\/tunnel(\/stop)?$/);
    if (tn && req.method === "POST") {
      const a = projects.get(tn[1]);
      if (!a) return json({ error: "unknown project" }, 404);
      if (tn[2]) return (stopTunnel(), json({ ok: true }));
      try {
        const t = await ensureTunnel();
        tunnelHome = a.id;
        lastActive = Date.now();
        return json({ url: `${t.url}/?project=${a.id}` });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    }
    if (p === "/__cd/shutdown" && req.method === "POST") {
      const force = url.searchParams.get("force") === "1";
      const preserveTunnel = url.searchParams.get("preserveTunnel") === "1";
      if (updating && !force) return json({ error: "cdesign is updating." }, 409);
      setTimeout(() => shutdown({ preserveTunnel }), 20);
      return json({ ok: true });
    }

    if (!project) return json({ error: "no project: open one via its <id>.localhost address or pass ?project=<id>" }, 404);
    const { root } = project;
    lastActive = Date.now();
    const tab = (id: string) => project!.tabs.get(id) ?? (project!.tabs.set(id, { file: null, at: 0, selection: null }), project!.tabs.get(id)!);
    const current = () => [...project!.tabs.values()].filter((t) => t.file).sort((a, b) => b.at - a.at)[0] ?? null;

    if (p === "/__cd/chat" || p.startsWith("/__cd/chat/")) {
      if (via || remote) return json({ error: "Chat is available only in the local viewer" }, 403);
      const origin = req.headers.get("origin");
      if (origin && (origin === "null" || new URL(origin).host !== hostHeader)) return new Response("forbidden", { status: 403 });
      const chat = chatOf(project);
      try {
        if (p === "/__cd/chat" && req.method === "GET") return json(chat.snapshot(url.searchParams.get("c")), 200);
        if (p === "/__cd/chat/providers" && req.method === "GET") return json({ root, providers: await Promise.all(Object.values(PROVIDERS).map(async (x) => ({ ...(await x.discover()), capabilities: await capabilitiesOf(x.id) }))) });
        if (p === "/__cd/chat/commands" && req.method === "GET") { // what `/` offers in the composer: the agent's own commands and skills
          const id = url.searchParams.get("provider") ?? "";
          if (!PROVIDERS[id]) return json({ error: "Unknown agent" }, 400);
          return json({ provider: id, commands: await commandsOf(id, root) });
        }
        if (p === "/__cd/chat/context" && req.method === "GET") { // the chips for one viewer tab of this project; an unknown tab simply has none
          const t = project.tabs.get(url.searchParams.get("tab") ?? "") ?? null;
          return json(contextChips(root, t && { file: t.file, selection: t.selection }));
        }
        if (p === "/__cd/chat/events" && req.method === "GET") {
          const after = +(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0) || 0;
          let ctrl!: ReadableStreamDefaultController;
          return new Response(new ReadableStream({
            start(c) { ctrl = c; c.enqueue(enc.encode(": hi\n\n")); chat.subscribe(c, after, url.searchParams.get("epoch")); },
            cancel() { chat.unsubscribe(ctrl); },
          }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
        if ((p === "/__cd/chat/send" || p === "/__cd/chat/stop" || p === "/__cd/chat/approve" || p === "/__cd/chat/settings" || p === "/__cd/chat/rename" || p === "/__cd/chat/delete") && req.method === "POST") {
          if (+(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new ChatError(413, "Request too large");
          const raw = await req.text();
          if (raw.length > MAX_BODY) throw new ChatError(413, "Request too large");
          let body: unknown;
          try { body = JSON.parse(raw); } catch { throw new ChatError(400, "Invalid JSON"); }
          if (p.endsWith("/send")) {
            if (updating) return json({ error: "Wait for cdesign to finish updating." }, 409);
            pendingChatStarts++;
            try { return json(await chat.send(body), 202); }
            finally { pendingChatStarts--; }
          }
          if (p.endsWith("/settings")) return json(await chat.setSettings(body));
          if (p.endsWith("/rename")) return json(chat.rename(body));
          if (p.endsWith("/delete")) { chat.remove(body); return json({ ok: true }); }
          if (p.endsWith("/approve")) { chat.approve(body); return json({ ok: true }, 202); }
          chat.stop(body);
          return json({ ok: true }, 202);
        }
      } catch (e) {
        if (e instanceof ChatError) return json({ error: e.message, ...e.extra }, e.status);
        throw e;
      }
      return json({ error: "Not found" }, 404);
    }

    if (p === "/__cd/website" || p === "/__cd/website/export" || p === "/__cd/website/publish") {
      if (via || remote) return json({error:"Website publishing is available only in the local viewer"},403);
      if (p === "/__cd/website" && req.method === "GET") return json({...websiteDefaults(root), publishing:publishingStatus(root)});
      if (req.method !== "POST") return json({error:"Method not allowed"},405);
      if (updating) return json({ error: "Wait for cdesign to finish updating." }, 409);
      if (websiteJobs.has(root)) return json({error:"An export or publication is already running for this project"},409);
      websiteJobs.add(root);
      try {
        const b = await req.json() as WebsiteOptions;
        if (typeof b.name !== 'string' || typeof b.start !== 'string' || b.pages !== undefined && (!Array.isArray(b.pages) || b.pages.some(x=>typeof x!=='string'))) return json({error:"Invalid website options"},400);
        const options = {name:b.name,start:b.start,pages:b.pages};
        if (p.endsWith("/publish")) return json(await publishWebsite(root,options));
        const result = await exportWebsite(root,options); saveWebsite(root,options);
        let server = websitePreviews.get(root);
        if (!server) {server=previewWebsite(result.directory);websitePreviews.set(root,server);}
        return json({directory:result.directory,url:`http://127.0.0.1:${server.port}/${options.name}/`});
      } catch (e) {return json({error:e instanceof Error ? e.message : String(e)},400);} finally {websiteJobs.delete(root);}
    }
    if (p === "/__cd/shares" || p === "/__cd/shares/delete") {
      if (via || remote) return json({error:"Sharing is available only in the local viewer"},403);
      if (p === "/__cd/shares" && req.method === "GET") { const status = publishingStatus(root); return json({configured:status.configured, origin:status.origin, setup:status.setup, shares:listShares(root)}); }
      if (req.method !== "POST") return json({error:"Method not allowed"},405);
      if (updating) return json({ error: "Wait for cdesign to finish updating." }, 409);
      if (websiteJobs.has(root)) return json({error:"An export or publication is already running for this project"},409);
      websiteJobs.add(root);
      try {
        const b = await req.json() as {page?: unknown; name?: unknown};
        if (p.endsWith("/delete")) { if (typeof b.name !== "string") return json({error:"Invalid share"},400); await deleteShare(root, b.name); return json({ok:true}); }
        if (typeof b.page !== "string") return json({error:"Invalid page"},400);
        return json(await shareScreen(root, b.page));
      } catch (e) {return json({error:e instanceof Error ? e.message : String(e)},400);} finally {websiteJobs.delete(root);}
    }
    if (p === "/__cd/files") return json(listPages(root));
    if (p === "/__cd/config") return json(readConfig(root));
    if (p === "/__cd/flows" && req.method === "GET") {
      const flows = listFlows(root);
      return json({ flows, sync: syncItems(root, flows) });
    }
    if (p === "/__cd/sync" && req.method === "POST") {
      const b = (await req.json()) as { action?: string; file?: unknown; note?: unknown };
      if (typeof b.file !== "string") return json({ error: "file required" }, 400);
      try {
        if (b.action === "outdated") markOutdated(root, b.file, typeof b.note === "string" ? b.note : undefined);
        else if (b.action === "done") markSynced(root, b.file);
        else if (b.action === "clear") clearOutdated(root, b.file);
        else return json({ error: "action must be outdated, done or clear" }, 400);
        return json({ ok: true, sync: syncItems(root) });
      } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (p === "/__cd/style-options") {
      const safe = <T,>(f: () => T[]) => { try { return f(); } catch { return []; } };
      return json({ tailwind: readConfig(root).tailwind, colors: safe(() => colorTokens(root)), sizes: safe(() => sizeTokens(root)) });
    }
    if (p === "/__cd/edit/info" && req.method === "POST") {
      const b = (await req.json()) as { file: string; cdId: string; uses?: string[] };
      try { return json(editInfo(root, b.file, b.cdId, b.uses)); } catch (e) { return json({ error: String((e as Error).message) }, 400); }
    }
    if (p === "/__cd/edit" && req.method === "POST") {
      let r;
      try { r = applyEdit(root, await req.json()); } catch (e) { r = { ok: false as const, reason: String((e as Error).message) }; }
      if (!r.ok) return json(r, 422);
      if (r.before !== r.after) { project.undo.push({ file: r.file, before: r.before, after: r.after }); if (project.undo.length > 50) project.undo.shift(); }
      return json({ ok: true, file: r.file, undo: project.undo.length });
    }
    if (p === "/__cd/edit/undo" && req.method === "POST") {
      const last = project.undo.pop();
      if (!last) return json({ ok: false, reason: "nothing to undo" }, 422);
      const path = resolve(root, last.file);
      if (!insideProject(root, last.file)) return json({ ok: false, reason: "outside the project" }, 422);
      if (await Bun.file(path).text() !== last.after) return json({ ok: false, reason: `${last.file} changed since that edit` }, 409);
      writeFileSync(path, last.before);
      return json({ ok: true, file: last.file, undo: project.undo.length });
    }
    if (p.startsWith("/__cd/react/")) {
      const asset = await reactAsset(root, p);
      return asset ? new Response(asset, { headers: { "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
    }
    if (p === "/__cd/tailwind.css") {
      try { return new Response(await tailwindCss(root), { headers: { "content-type": "text/css", "cache-control": "no-store" } }); }
      catch (e) { return new Response(String(e), { status: 500 }); }
    }

    if (p === "/__cd/preview-heartbeat" && req.method === "GET") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (p === "/__cd/events") {
      let ctrl!: ReadableStreamDefaultController;
      const tabId = url.searchParams.get("tab");
      const pr = project;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          pr.clients.add(c);
          if (tabId) pr.tabOf.set(c, tabId);
          c.enqueue(enc.encode(`: hi\n\ndata: instance:${instance}\n\n`));
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
        snippet = sourceSnippet(root, b.selection.file, b.selection.cdId);
      } catch {}
      /** a pick on the map's previews belongs to that preview's page, not the page open in the viewer */
      const page = (b.selection as { page?: unknown }).page;
      if (typeof page === "string" && page && page !== t.file && insideProject(root, page)) t.file = page;
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
        snippet = sourceSnippet(root, b.file, b.cdId);
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
    if (!insideProject(root, rel)) return new Response("forbidden", { status: 403 });
    if (/\.(html|tsx)$/.test(abs) && p.startsWith("/p/")) {
      if (!listPages(root).includes(rel)) return new Response("not a preview entry for this mode", { status: 404 });
      let html: string;
      try { html = await adapter(root).render(root, rel); } catch (e) { html = errorDocument(e); }
      let tag = "";
      if (!url.searchParams.has("raw")) {
        if (url.searchParams.has("full")) {
          const href = "/#" + rel.split("/").map(encodeURIComponent).join("/");
          tag = `<style>
            #__cd-return{all:initial;box-sizing:border-box;position:fixed;z-index:2147483647;
              left:calc(8px + env(safe-area-inset-left));bottom:calc(8px + env(safe-area-inset-bottom));
              width:24px;height:24px;display:grid;place-items:center;background:#171717;color:#fafafa;
              border:1px solid #737373;border-radius:5px;cursor:pointer;touch-action:manipulation}
            #__cd-return:focus-visible{outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #171717}
          </style><a id="__cd-return" href="${href}" aria-label="Return to cdesign" title="Return to cdesign"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 3v10"/></svg></a>
          <script>
            (function() {
              var timer = 0, stopped = false;
              addEventListener("pagehide", function() { stopped = true; clearTimeout(timer); });
              async function heartbeat() {
                if (stopped) return;
                // Keep the daemon available without a persistent connection or automatic navigation.
                try { await fetch("/__cd/preview-heartbeat", { keepalive: true, cache: "no-store" }); } catch {}
                if (!stopped) timer = setTimeout(heartbeat, ${Math.max(100, Math.min(30000, Math.floor(idleMs / 3) || 30000))});
              }
              heartbeat();
            })();
            try {
              document.documentElement.dataset.theme = localStorage.getItem("cd-theme") ||
                (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
            } catch {}
          </script>`;
        } else {
          tag = `<script src="/__cd/overlay.js"></script>`;
        }
      }
      const body = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => tag + "</body>") : html + tag;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response(f, { headers: { "cache-control": "no-store" } });
  };

  const bind = (port: number) => Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => fetchHandler(req) });
  let bound = false;
  if (preferred !== 0) {
    for (let i = 0; i < 15; i++) {
      try { server = bind(preferred); bound = true; break; }
      catch {
        // the default port is busy: another daemon already runs (then we are redundant) or the previous daemon is still releasing it
        try {
          if ((await fetch(`http://127.0.0.1:${preferred}/__cd/projects`, { signal: AbortSignal.timeout(500) })).ok) process.exit(0);
        } catch { /* not answering: likely releasing the port */ }
        await Bun.sleep(50);
      }
    }
  }
  if (!bound) server = bind(0);
  for (const root of readProjects()) addProject(root);
  await adoptTunnel();
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(daemonPath(), JSON.stringify({ port: server.port, pid: process.pid, startedAt, instance, fingerprint }));
  return { server, addProject };
}
