#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serveDaemon, listHtml, DEFAULT_PORT } from "./server";
import { screenshot } from "./shot";
import { componentIndex, previewOf, sourceOfPreview } from "./render";
import * as tk from "./tokens";
import { context, guidanceFiles, startup } from "./context";
import { beat, dataDir, ensureDataDir, daemonPath, projectId, readComments, readTunnelConfig, writeTunnelConfig, update, commentsPath, type Comment } from "./store";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i < 0 ? undefined : rest.splice(i, 2)[1];
};

// ---------- skills (bundled only: they explain how to use cdesign) ----------
function printSkills(name?: string) {
  const dir = join(import.meta.dir, "..", "skills");
  if (name && !readdirSync(dir).includes(name)) throw new Error(`Unknown skill: ${name}`);
  for (const d of readdirSync(dir)) {
    const f = join(dir, d, "SKILL.md");
    if (!existsSync(f)) continue;
    const body = readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    if (!name) {
      const description = readFileSync(f, "utf8").match(/^description:\s*(.+)$/m)?.[1] ?? d;
      console.log(`${d}: ${description}\n  Read: cdesign skills get ${d}`);
      continue;
    }
    if (d !== name) continue;
    console.log(`\n=== SKILL: ${d} ===\n\n${body}\n`);
  }
}

// ---------- project context ----------
function walk(dir: string, root: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 5) return acc;
  for (const n of readdirSync(dir)) {
    if (["node_modules", ".git", ".cdesign", "dist", ".next", ".astro", "build"].includes(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, root, acc, depth + 1);
    else acc.push(p.slice(root.length + 1));
  }
  return acc;
}

function printContext(root: string) {
  const files = walk(root, root);
  const css = files.filter((f) => /\.(css|scss)$/.test(f));
  const tokens: string[] = [];
  const hasTokens = tk.loadTokens(root) !== null;
  for (const f of css) {
    if (hasTokens && f === "design/tokens.css") continue; // generated; the digest below covers it
    const vars = [...readFileSync(join(root, f), "utf8").matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
    if (vars.length) tokens.push(`  ${f}: ${vars.length} custom properties (${vars.slice(0, 8).join(", ")}${vars.length > 8 ? ", …" : ""})`);
  }
  const tw = files.filter((f) => /tailwind\.config\.|@theme/.test(f));
  const comps = files.filter((f) => /(^|\/)(components?|features)\//i.test(f) && !/(^|\/)previews\//.test(f) && /\.(tsx|jsx|astro|vue|svelte|html)$/.test(f));
  const pages = files.filter((f) => /(^|\/)(pages|routes|app)\//.test(f) && /\.(tsx|jsx|astro|vue|svelte|html|mdx?)$/.test(f));
  const show = (t: string, l: string[], n = 25) => console.log(`${t} (${l.length})\n${l.slice(0, n).map((x) => (x.startsWith("  ") ? x : "  " + x)).join("\n") || "  none found"}${l.length > n ? `\n  … +${l.length - n}` : ""}\n`);
  const ds = join(root, "design", "design-system.md");
  console.log("=== DESIGN SYSTEM (design/design-system.md: source of truth, keep it in sync with every change) ===");
  console.log(existsSync(ds) ? readFileSync(ds, "utf8").trim() + "\n" : "missing. Run `cdesign init` to scaffold design/, then create the design system with the design-system skill.\n");
  const comps2 = [...componentIndex(root)].map(([n, p]) => `<c-${n}> -> ${p}`);
  show("Prototype components (use as <c-name prop=\"…\">children</c-name>)", comps2.map((x) => "  " + x));
  if (hasTokens) console.log(tk.digest(root));
  console.log("=== PROJECT CONTEXT (reuse these, do not invent new tokens/components) ===");
  show("Project CSS custom properties", tokens);
  show("Tailwind config", tw);
  show("Components", comps);
  show("Pages / routes", pages);
  show("Prototypes in progress (design/prototype/)", files.filter((f) => f.startsWith("design/prototype/") && f.endsWith(".html") && !f.includes("/_")));
  show("Existing prototypes (.html)", listHtml(root));
}

// ---------- daemon lifecycle (one viewer process for every project) ----------
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readDaemon = () => {
  try {
    const s = JSON.parse(readFileSync(daemonPath(), "utf8"));
    return alive(s.pid) ? (s as { port: number; pid: number }) : null;
  } catch { return null; }
};

/** readDaemon plus a real request: a recycled pid or a hung process must not look like the daemon. Stale files are removed. */
async function liveDaemon() {
  const s = readDaemon();
  if (!s) return null;
  try {
    if ((await fetch(`http://127.0.0.1:${s.port}/__cd/projects`, { signal: AbortSignal.timeout(1000) })).ok) return s;
  } catch { /* not answering */ }
  try { rmSync(daemonPath()); } catch { /* ignore */ }
  return null;
}

/** The running viewer predates the installed code (e.g. after `cdesign update` or a git pull): it must restart to pick up new features. */
const stale = (startedAt?: number) => {
  if (!startedAt) return false;
  try { return readdirSync(import.meta.dir).some((f) => f.endsWith(".ts") && statSync(join(import.meta.dir, f)).mtimeMs > startedAt); } catch { return false; }
};

async function ensureDaemon(port?: string) {
  let s = await liveDaemon();
  if (s) {
    const info = (() => { try { return JSON.parse(readFileSync(daemonPath(), "utf8")); } catch { return {}; } })();
    if (!stale(info.startedAt)) return s;
    await fetch(`http://127.0.0.1:${s.port}/__cd/shutdown`, { method: "POST" }).catch(() => {});
    for (let i = 0; i < 30 && alive(s.pid); i++) await Bun.sleep(100);
    s = null;
  }
  Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "daemon", ...(port ? ["--port", port] : [])], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  for (let i = 0; i < 50 && !(s = await liveDaemon()); i++) await Bun.sleep(100);
  if (!s) throw new Error("cdesign daemon failed to start");
  return s;
}

type Reg = { id: string; root: string; url: string; tabs: number };
/** Register a project with the daemon (starting it if needed). */
async function register(root: string, port?: string): Promise<Reg & { port: number }> {
  const s = await ensureDaemon(port);
  const r = await fetch(`http://127.0.0.1:${s.port}/__cd/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root }) });
  if (!r.ok) throw new Error(`could not register ${root}: ${await r.text()}`);
  return { ...((await r.json()) as Reg), port: s.port };
}

/** Expose the project through a cloudflared quick tunnel; prints the private link. */
async function tunnel(reg: { id: string; port: number }, stop = false) {
  const r = await fetch(`http://127.0.0.1:${reg.port}/__cd/projects/${reg.id}/tunnel${stop ? "/stop" : ""}`, { method: "POST" });
  const b = (await r.json()) as { url?: string; error?: string };
  if (!r.ok) throw new Error(b.error ?? "tunnel failed");
  console.log(stop ? "tunnel stopped" : `tunnel (anyone with this link can view and comment; it stops with the viewer or \`cdesign tunnel stop\`):\n${b.url}\n`);
}

/** The project an agent is working in: nearest parent with a design/ folder, else cwd. */
function findRoot(from = process.cwd()) {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, "design", "design-system.md"))) return d;
    if (dirname(d) === d) return resolve(from);
  }
}

/** What the user has open in the viewer right now (last active tab), or null when the daemon or the project is not running. */
async function pageText(root: string, compact = false) {
  const s = await liveDaemon();
  if (!s) return null;
  const id = projectId(root);
  try {
    const known = ((await (await fetch(`http://127.0.0.1:${s.port}/__cd/projects`)).json()) as { projects: { id: string }[] }).projects;
    if (!known.some((p) => p.id === id)) return null;
    const base = `http://${id}.localhost:${s.port}`;
    const r = (await (await fetch(`http://127.0.0.1:${s.port}/__cd/page?project=${id}`)).json()) as {
      file: string | null;
      selection: { file: string; cdId: string; uses: string[]; selector: string; tag: string; text: string; snippet: string } | null;
    };
    if (!r.file) return `cdesign viewer is running (${base}/) but no page is open in it yet.`;
    let t = `Open in cdesign: ${r.file} (${base}/#${r.file})`;
    const e = r.selection;
    if (e) {
      if (compact) return `${t}\nSelected: <${e.tag}> data-cd-id="${e.cdId}" in ${e.file}\nUse cdesign page for its selector, source and instance chain.`;
      t += `
Selected element (picked by the user with the pointer tool; "this"/"here" refers to it): <${e.tag}> data-cd-id="${e.cdId}" in ${e.file}${e.uses.length ? `
  used in (component instance, innermost first): ${e.uses.join(" <- ")}` : ""}
  selector: ${e.selector}${e.text ? `
  text: ${e.text}` : ""}
  source:
${e.snippet}`;
    }
    return t;
  } catch { return null; }
}

const fmt = (c: Comment) =>
  `--- comment ${c.id} ---\nfile: ${c.file}${c.uses?.length ? `\nused in (component instance, innermost first): ${c.uses.join(" <- ")}\n(edit the component file to change every instance; edit the instance line to change just this one)` : ""}\nelement: data-cd-id="${c.cdId}" (line:col of its start tag in ${c.file})\nselector: ${c.selector}\nsource:\n${c.snippet}\n\nrequest: ${c.text}\n`;

const batchText = (batch: Comment[], again = false) =>
  `${batch.length} comment(s) from the user. Apply all of them, then run: cdesign resolve ${batch.map((c) => c.id).join(" ")}${again ? "\nThen start `cdesign wait` again in the background so the next batch reaches you." : ""}\n\n${batch.map(fmt).join("\n")}`;

// ---------- commands ----------
switch (cmd) {
  case "daemon":
  case "serve": {
    const port = flag("--port");
    const { server, addProject } = await serveDaemon(port ? +port : DEFAULT_PORT);
    if (cmd === "serve" && rest[0]) addProject(resolve(rest[0]));
    console.log(`cdesign viewer: http://localhost:${server.port}`);
    break;
  }
  case "open": {
    const port = flag("--port");
    const quiet = rest.includes("--no-browser");
    const dirArg = rest.find((a) => !a.startsWith("--"));
    const root = dirArg ? resolve(dirArg) : findRoot();
    const scaffolded = !existsSync(join(root, "design", "design-system.md"));
    const reg = await register(root, port); // scaffolds design/ when missing
    if (scaffolded) console.log("(design/ did not exist: scaffolded it. Create the design system next.)");
    try { rmSync(join(dataDir(root), "server.json")); } catch { /* legacy per-project server file */ }
    if (!quiet && !reg.tabs) {
      const opener = process.platform === "win32" ? ["cmd", "/c", "start", "", reg.url] : process.platform === "darwin" ? ["open", reg.url] : ["xdg-open", reg.url];
      try { Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] }).unref(); } catch { /* no browser opener available */ }
    }
    console.log(`cdesign viewer running: ${reg.url}\nproject: ${root}\n`);
    if (rest.includes("--tunnel")) await tunnel(reg).catch((e) => console.log(`tunnel not started: ${e.message}\n`));
    console.log(startup());
    const current = await pageText(root, true);
    if (current) console.log(`\n${current}`);
    if (rest.includes("--full")) { printSkills("cdesign"); printContext(root); }
    break;
  }
  case "tunnel": {
    if (["set", "unset", "show"].includes(rest[0])) {
      const sub = rest.shift();
      const cfg = readTunnelConfig();
      if (sub === "show") {
        console.log(cfg ? `fixed tunnel domain: https://${cfg.domain} (${cfg.provider}, local port ${cfg.port}, ${cfg.secret ? "link needs a secret" : "open: no secret"})` : "no fixed domain: `cdesign tunnel` uses a random cloudflared quick-tunnel URL. Set one with `cdesign tunnel set`.");
        break;
      }
      if (sub === "unset") { writeTunnelConfig(null); console.log("fixed domain removed; `cdesign tunnel` uses a random quick-tunnel URL again"); break; }
      const provider = flag("--provider") ?? "ngrok", domain = (flag("--domain") ?? flag("--hostname") ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
      const token = flag("--token"), port = +(flag("--port") ?? 4748), withSecret = rest.includes("--secret");
      const fail = (m: string): never => { console.error(m); process.exit(1); };
      if (provider !== "ngrok" && provider !== "cloudflare") fail("--provider must be ngrok or cloudflare");
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) fail("give the domain with --domain, e.g. --domain my-name.ngrok-free.dev");
      if (provider === "cloudflare" && !token) fail("--provider cloudflare needs --token <tunnel token> (Zero Trust > Networks > Tunnels)");
      if (!(port > 1023 && port < 65536)) fail("--port must be between 1024 and 65535");
      const secret = withSecret ? crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "") : undefined; // stable access secret (opt-in): the private link stays the same
      writeTunnelConfig(provider === "ngrok" ? { provider, domain, port, secret } : { provider, domain, token: token!, port, secret });
      console.log(`fixed tunnel domain saved: https://${domain} (${provider})
Run \`cdesign tunnel\` to share the viewer (all your open projects, switchable from the header) at it.${secret ? "\nThe link carries a ?t=… secret that stays the same until you run `tunnel set` again." : `\nNo secret: anyone who knows https://${domain} can view your open projects and send comments to your agent while the tunnel runs. Add --secret to require one.`}${provider === "cloudflare" ? `
In the Cloudflare dashboard the tunnel's public hostname must be ${domain} -> http://localhost:${port}.` : `
Needs ngrok installed and authenticated (\`ngrok config add-authtoken <token>\`); the free plan includes one static domain.`}`);
      break;
    }
    const stop = rest[0] === "stop";
    const root = stop ? findRoot(rest[1]) : findRoot(rest[0]);
    await tunnel(await register(root), stop).catch((e) => (console.error(e.message), process.exit(1)));
    break;
  }
  case "close": {
    const s = await liveDaemon();
    if (rest.includes("--all")) {
      if (!s) { console.log("cdesign viewer is not running"); break; }
      await fetch(`http://127.0.0.1:${s.port}/__cd/shutdown`, { method: "POST" }).catch(() => {});
      console.log("cdesign viewer stopped");
      break;
    }
    const root = resolve(rest[0] ?? ".");
    try { // a viewer from before the single-process daemon
      const old = JSON.parse(readFileSync(join(dataDir(root), "server.json"), "utf8"));
      if (alive(old.pid)) process.kill(old.pid);
      rmSync(join(dataDir(root), "server.json"));
    } catch { /* none */ }
    if (!s) { console.log("cdesign viewer is not running"); break; }
    const r = (await (await fetch(`http://127.0.0.1:${s.port}/__cd/projects/${projectId(root)}/remove`, { method: "POST" })).json()) as { remaining: number };
    console.log(`project closed${r.remaining ? ` (${r.remaining} other project(s) still open)` : "; no projects left, viewer stopped"}`);
    break;
  }
  case "page": {
    const root = findRoot();
    console.log((await pageText(root)) ?? "cdesign is not open for this project. Call `open` to start the viewer.");
    break;
  }
  case "review": {
    const root = findRoot();
    const batch = readComments(root).filter((c) => c.status === "queued" || c.status === "sent");
    if (!batch.length) {
      console.log("No comments sent. The user sends a batch with the Send button in the viewer; ask them to do that, then run `cdesign review` again.");
      break;
    }
    const ids = new Set(batch.map((c) => c.id));
    update(root, (l) => l.forEach((c) => ids.has(c.id) && (c.status = "sent")));
    console.log(batchText(batch));
    const now = await pageText(root);
    if (now) console.log(`
${now}`);
    break;
  }
  case "wait": {
    // Run in the background (Claude Code: Bash with run_in_background). It exits when the user sends a batch,
    // which wakes the agent. A heartbeat tells the viewer an agent is listening.
    const timeout = +(flag("--timeout") ?? 0) * 1000;
    const root = resolve(rest[0] ?? ".");
    const start = Date.now();
    const stop = () => (beat(root, false), process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    let last = 0;
    for (;;) {
      const queued = readComments(root).filter((c) => c.status === "queued");
      if (queued.length) {
        const ids = new Set(queued.map((c) => c.id));
        update(root, (l) => l.forEach((c) => ids.has(c.id) && (c.status = "sent")));
        beat(root, false);
        console.log(batchText(queued, true));
        break;
      }
      if (timeout && Date.now() - start > timeout) { beat(root, false); console.log("no new comments (timeout)"); break; }
      if (Date.now() - last > 2000) (beat(root, true), (last = Date.now()));
      await Bun.sleep(500);
    }
    break;
  }
  case "shot": {
    // cdesign shot [page.html] [--selector css | --selected] [--width 1280] [--theme light|dark] [--format webp|jpeg|png] [--full] [--y n] [--out file] [--json]
    const bool = (n: string) => { const i = rest.indexOf(n); if (i >= 0) rest.splice(i, 1); return i >= 0; };
    const selected = bool("--selected"), full = bool("--full"), asJson = bool("--json");
    const selector = flag("--selector"), width = +(flag("--width") ?? 1280), theme = flag("--theme") as "light" | "dark" | undefined;
    const format = (flag("--format") ?? "webp") as "webp" | "jpeg" | "png", y = +(flag("--y") ?? 0), out = flag("--out");
    const fail = (m: string): never => { console.error(m); process.exit(1); };
    if (!["webp", "jpeg", "png"].includes(format)) fail("--format must be webp, jpeg or png");
    if (theme && theme !== "light" && theme !== "dark") fail("--theme must be light or dark");
    if (!(width >= 200 && width <= 4000)) fail("--width must be between 200 and 4000");
    const root = findRoot();
    const reg = await register(root);
    let file = rest.find((a) => !a.startsWith("--"));
    let sel = selector;
    if (!file || selected) {
      const cur = (await (await fetch(`http://127.0.0.1:${reg.port}/__cd/page?project=${reg.id}`)).json()) as {
        file: string | null; selection: { file: string; cdId: string } | null;
      };
      if (selected) {
        if (!cur.selection) fail("No element is selected in the viewer. Ask the user to pick one with the pointer tool, or pass --selector.");
        if (file && file !== cur.file) fail(`The selected element is on ${cur.file}, not ${file}.`);
        sel = `[data-cd-id="${cur.selection!.cdId}"][data-cd-file="${cur.selection!.file}"]`;
      }
      file ??= cur.file ?? undefined;
    }
    if (!file) fail("No page given and none open in the viewer. Pass a page, e.g. `cdesign shot design/prototype/home.html`.");
    const url = `http://${reg.id}.localhost:${reg.port}/p/${encodeURI(file!)}?raw=1`;
    let shot;
    try {
      shot = await screenshot({ url, selector: sel, width, theme, format, maxEdge: 1568, maxHeight: full ? 0 : 1600, y });
    } catch (e) { fail((e as Error).message); }
    const dir = join(ensureDataDir(root), "shots");
    mkdirSync(dir, { recursive: true });
    const path = out ? resolve(out) : join(dir, `${Date.now()}.${format === "jpeg" ? "jpg" : format}`);
    writeFileSync(path, shot!.data);
    if (!out) for (const old of readdirSync(dir).sort().slice(0, -20)) rmSync(join(dir, old), { force: true }); // keep the last 20
    const info = { path, mime: shot!.mime, width: shot!.width, height: shot!.height, bytes: shot!.data.length, note: shot!.note, page: file, selector: sel ?? null };
    console.log(asJson ? JSON.stringify(info) : `${path}\n${info.width}x${info.height} ${info.mime}, ${(info.bytes / 1024).toFixed(1)} KB${info.note ? `\n${info.note}` : ""}`);
    break;
  }
  case "comments": {
    const root = findRoot();
    const l = readComments(root).filter((c) => rest.includes("--all") || c.status !== "done");
    console.log(l.length ? l.map((c) => `[${c.status}]\n${fmt(c)}`).join("\n") : "no pending comments");
    break;
  }
  case "resolve": {
    const root = findRoot();
    const ids = new Set(rest);
    update(root, (l) => l.forEach((c) => ids.has(c.id) && (c.status = "done")));
    console.log(`resolved: ${rest.join(", ")}`);
    break;
  }
  case "init": {
    const root = resolve(rest[0] ?? ".");
    const put = (rel: string, body: string) => {
      const f = join(root, rel);
      if (existsSync(f)) return console.log(`exists  ${rel}`);
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, body);
      console.log(`created ${rel}`);
    };
    put("design/design-system.md", `# Design system

Entry point for the project's design guidance. Keep this overview short: identity, essential constraints, and source authority. Read relevant topics with \`cdesign context find|get\`.

Describe the audience, visual identity, language and universal constraints here. Link existing product documentation instead of duplicating it.

## Tokens
Source of truth: \`design/tokens.json\` (query it with \`cdesign tokens search|show\`, change it with \`cdesign tokens set|rm\`). Do not list tokens here; document rules for using them.

## Guidance
Add focused documents under \`design/foundations/\` or \`design/patterns/\` when needed, and link them here. Keep related rules together. Label preferred examples, alternatives, work in progress and imported references explicitly; record authority and freshness when sources disagree.

## Components
Files in \`design/components/<ui|shared|layout>/\` and \`design/features/<feature>/\`, each with a \`previews/<name>.preview.html\` in a \`previews/\` folder beside it. Used as \`<c-name prop="x">children</c-name>\`.
Document short contracts in leading HTML comments: purpose, props/defaults, slots, states and dependencies. \`cdesign context get component/<name>\` returns the contract without CSS or page source. Put longer family guidance beside related components only when needed; link shared rules rather than repeating them.

## Prototypes
Work in progress lives in \`design/prototype/\`. When one is done, ask the user whether to move it to \`components/\`, \`features/\` or \`pages/\`.

## Maintenance
Update the canonical topic when a shared rule or contract changes; update affected component previews in the same edit. Local copy or page composition changes do not require updating this overview. Query token values rather than copying them into prose. Run \`cdesign check\`.
`);
    if (existsSync(join(root, "design/tokens.json"))) console.log("exists  design/tokens.json");
    else console.log(tk.init(root));
    put("design/_head.html", `<!-- injected into every prototype's <head>: tokens, fonts, Tailwind, resets -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/design/tokens.css">
`);
    mkdirSync(join(root, "design/pages"), { recursive: true });
    for (const d of ["components/ui", "components/shared", "components/layout", "features", "prototype"]) mkdirSync(join(root, "design", d), { recursive: true });
    break;
  }
  case "check": {
    const fix = rest.includes("--fix");
    const root = resolve(rest.filter((a) => a !== "--fix")[0] ?? ".");
    const dir = join(root, "design");
    if (fix && existsSync(dir))
      for (const f of walk(dir, root).filter((f) => f.endsWith(".preview.html") && !/(^|\/)previews\//.test(f))) {
        const to = previewOf(f.replace(/\.preview\.html$/, ".html"));
        if (existsSync(join(root, to))) continue;
        mkdirSync(dirname(join(root, to)), { recursive: true });
        renameSync(join(root, f), join(root, to));
        console.log(`moved   ${f} -> ${to}`);
      }
    const files = existsSync(dir) ? walk(dir, root).filter((f) => /\.(html|css)$/.test(f)) : [];
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    const mdPath = join(dir, "design-system.md");
    const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    const docs = guidanceFiles(root).map(f => ({ file: f, text: read(f) }));
    const documented = docs.map(d => d.text).join("\n");
    const problems: string[] = [], warnings: string[] = [];
    if (!md) problems.push("design/design-system.md is missing");
    const defined = new Set<string>(), used = new Map<string, string>();
    for (const f of files) {
      const t = read(f);
      for (const m of t.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
      for (const m of t.matchAll(/var\(\s*(--[\w-]+)/g)) used.set(m[1], f);
    }
    for (const [v, f] of used) if (!defined.has(v)) problems.push(`${v} used in ${f} but never defined`);
    const hasTokens = tk.loadTokens(root) !== null;
    if (hasTokens) {
      warnings.push(...tk.tokenWarnings(root));
      for (const f of files.filter((f) => f.endsWith(".html"))) warnings.push(...tk.hardcoded(f, read(f)));
    }
    for (const v of defined) if (!hasTokens && md && !documented.includes(v)) warnings.push(`${v} is defined but not documented in design guidance`);
    const dups: string[] = [];
    const idx = componentIndex(root, dups);
    for (const n of new Set(dups)) warnings.push(`component name "${n}" is used by more than one file`);
    for (const f of files) {
      if (!f.endsWith(".preview.html")) continue;
      if (!/(^|\/)previews\//.test(f)) warnings.push(`${f} must live in a previews/ folder (run \`cdesign check --fix\`)`);
      else if (!existsSync(join(root, sourceOfPreview(f)))) warnings.push(`${f} has no ${sourceOfPreview(f)}`);
    }
    for (const f of files.filter((f) => f.endsWith(".html")))
      for (const m of read(f).matchAll(/<c-([\w-]+)/g)) if (!idx.has(m[1])) problems.push(`<c-${m[1]}> used in ${f} has no component file`);
    for (const [n, rel] of idx) if (!existsSync(join(root, previewOf(rel)))) warnings.push(`component "${n}" has no ${previewOf(rel)}`);
    for (const [n, file] of idx) {
      const hasContract = /^\s*<!--[\s\S]*?\b(?:props|slots|purpose|contract)\s*:/i.test(read(file));
      if (md && !documented.includes(n) && !hasContract) warnings.push(`component "${n}" needs a header contract or design guidance`);
    }
    for (const doc of docs) {
      const prose = doc.text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, "").replace(/`[^`\n]*`/g, "");
      for (const match of prose.matchAll(/\[[^\]]*\]\((<[^>]*>|[^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const target = match[1].replace(/^<|>$/g, "").split("#")[0];
        if (!target || /^(?:[a-z][\w+.-]*:|\/)/i.test(target)) continue;
        let decoded: string;
        try { decoded = decodeURIComponent(target); } catch { warnings.push(`${doc.file}: invalid link ${target}`); continue; }
        if (!existsSync(resolve(dirname(join(root, doc.file)), decoded))) warnings.push(`${doc.file}: broken guidance link ${target}`);
      }
    }
    for (const p of problems) console.log("ERROR  " + p);
    for (const w of warnings) console.log("WARN   " + w);
    if (!problems.length && !warnings.length) console.log("design system in sync");
    process.exitCode = problems.length || warnings.length ? 1 : 0;
    break;
  }
  case "tokens": {
    const root = findRoot();
    const [sub, ...args] = rest;
    const opts: Record<string, string> = {};
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-o") opts.o = args[++i];
      else if (args[i].startsWith("--")) opts[args[i].slice(2)] = /^--/.test(args[i + 1] ?? "--") ? "true" : args[++i];
      else pos.push(args[i]);
    }
    if (sub === "search") console.log(tk.search(root, pos, opts.all ? 1e9 : 25));
    else if (sub === "show") console.log(tk.show(root, pos[0], pos[1]));
    else if (sub === "set") console.log(tk.set(root, pos[0] ?? "", opts));
    else if (sub === "rm") console.log(tk.remove(root, pos[0] ?? ""));
    else if (sub === "build") { const d = tk.loadTokens(root); if (d) { writeFileSync(tk.cssPath(root), tk.buildCss(d)); console.log("wrote design/tokens.css"); } else console.log("no design/tokens.json"); }
    else if (sub === "export") console.log(tk.exportTokens(root, pos[0] ?? "", opts.o ? resolve(opts.o) : undefined));
    else console.log(`cdesign tokens search <words> [--all] | show [section] [prefix] | set <section>/<name> --value v [--light v --dark v] --usage text | rm <section>/<name> | build | export <css|tailwind> [-o path]
sections: color, type, ${tk.FLAT.join(", ")}
type styles: set type/<name> --group G --size 14px --line 20px --weight 500 [--family sans --ls 0 --sample text] --usage text`);
    break;
  }
  case "mcp": {
    const { startMcp } = await import("./mcp");
    await startMcp();
    break;
  }
  case "install-mcp":
  case "uninstall-mcp": {
    const { installMcp } = await import("./install");
    process.exitCode = installMcp(cmd === "uninstall-mcp", rest);
    break;
  }
  case "update": {
    const base = `https://raw.githubusercontent.com/${process.env.CDESIGN_REPO ?? "dsmarcelo/cdesign"}/${process.env.CDESIGN_REF ?? "main"}`;
    const cmdline = process.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${base}/install.ps1 | iex`]
      : ["bash", "-c", `curl -fsSL ${base}/install.sh | bash`];
    const p = Bun.spawnSync(cmdline, { stdio: ["inherit", "inherit", "inherit"] });
    process.exitCode = p.exitCode;
    break;
  }
  case "skills":
    printSkills(rest[0] === "get" ? rest[1] : undefined);
    break;
  case "context": {
    const offset = Number(flag("--offset") ?? 0);
    if (rest.includes("--full")) printContext(findRoot());
    else try { console.log(context(findRoot(), rest[0] ?? "list", rest.slice(1).join(" "), offset)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    break;
  }
  default:
    console.log(`cdesign <command>
  open [dir] [--port n] [--no-browser] [--tunnel] [--full]  open the viewer with compact agent directions; --full opts into the old guide/inventories
  tunnel [dir] | tunnel stop [dir]      share the project (random link with a secret): fixed domain if set, else a random cloudflared quick tunnel
  tunnel set --provider ngrok --domain <name.ngrok-free.dev> | --provider cloudflare --hostname <h> --token <t> [--port n] [--secret]
                                        use a fixed domain; tunnel show | tunnel unset
  close [dir] [--all]                   close the project in the viewer; --all stops the viewer for every project
  page                                  what the user has open in the viewer (page + selected element)
  shot [page] [--selected|--selector css] [--width n] [--theme light|dark] [--format webp|jpeg|png] [--full] [--y n] [--out file]
                                        screenshot a page or one element (headless Chrome) as a small image file
  review                                print the comments the user sent from the viewer
  wait [--timeout s]                    run in the background: exits with the batch when the user presses Send
  resolve <id...>                       mark comments done
  comments [--all]                      list pending comments
  init [dir]                            scaffold design/ (design-system.md, tokens, _head, pages, components, features, prototype)
  check                                 verify tokens/components are defined and documented
  tokens <sub>                          query/change design/tokens.json, export css or tailwind (run: cdesign tokens)
  mcp                                   MCP server (stdio): tells agents how to use cdesign
  install-mcp [claude|codex|agy|all]    register the MCP server with agents found on this machine
  uninstall-mcp [claude|codex|agy|all]  remove it again
  update                                reinstall the latest version from GitHub
  skills [get <name>]                    list bundled skills, or read one
  context [list|find <words>|get <id>|for <path>] [--offset n]
                                        discover guidance/contracts; --full prints legacy inventories
  serve [dir] [--port n]                run the viewer in the foreground (it normally starts by itself)`);
}
void commentsPath;
