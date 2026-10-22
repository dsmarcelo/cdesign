#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve, listHtml } from "./server";
import { componentIndex } from "./render";
import * as tk from "./tokens";
import { dataDir, readComments, update, commentsPath, type Comment } from "./store";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i < 0 ? undefined : rest.splice(i, 2)[1];
};

// ---------- skills (bundled only: they explain how to use cdesign) ----------
function printSkills() {
  const dir = join(import.meta.dir, "..", "skills");
  for (const d of readdirSync(dir)) {
    const f = join(dir, d, "SKILL.md");
    if (!existsSync(f)) continue;
    const body = readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
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
  const comps = files.filter((f) => /(^|\/)components?\//i.test(f) && /\.(tsx|jsx|astro|vue|svelte|html)$/.test(f));
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
  show("Existing prototypes (.html)", listHtml(root));
}

// ---------- server lifecycle ----------
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readServer = (root: string) => {
  try {
    const s = JSON.parse(readFileSync(join(dataDir(root), "server.json"), "utf8"));
    return alive(s.pid) ? (s as { port: number; pid: number }) : null;
  } catch { return null; }
};

async function ensureServer(root: string, port?: string) {
  let s = readServer(root);
  if (s) return s;
  Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "serve", root, ...(port ? ["--port", port] : [])], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  for (let i = 0; i < 50 && !(s = readServer(root)); i++) await Bun.sleep(100);
  if (!s) throw new Error("server failed to start");
  return s;
}

const fmt = (c: Comment) =>
  `--- comment ${c.id} ---\nfile: ${c.file}${c.uses?.length ? `\nused in (component instance, innermost first): ${c.uses.join(" <- ")}\n(edit the component file to change every instance; edit the instance line to change just this one)` : ""}\nelement: data-cd-id="${c.cdId}" (line:col of its start tag in ${c.file})\nselector: ${c.selector}\nsource:\n${c.snippet}\n\nrequest: ${c.text}\n`;

// ---------- commands ----------
switch (cmd) {
  case "serve": {
    const port = flag("--port");
    const root = resolve(rest[0] ?? ".");
    const s = serve(root, port ? +port : 0);
    console.log(`cdesign viewer: http://localhost:${s.port}  (${root})`);
    break;
  }
  case "open": {
    const port = flag("--port");
    const quiet = rest.includes("--no-browser");
    const root = resolve(rest.find((a) => !a.startsWith("--")) ?? ".");
    const s = await ensureServer(root, port);
    const url = `http://localhost:${s.port}`;
    if (!quiet) Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    console.log(`cdesign viewer running: ${url}\nproject: ${root}\n`);
    printSkills();
    printContext(root);
    console.log(`=== LOOP ===
Write/edit prototypes as .html files in ${root} (the viewer live-reloads).
Then run \`cdesign wait\` (blocks until the user comments on an element), apply the change, run \`cdesign resolve <id>\`, and wait again.`);
    break;
  }
  case "wait": {
    const timeout = +(flag("--timeout") ?? 0) * 1000;
    const root = resolve(rest[0] ?? ".");
    const start = Date.now();
    for (;;) {
      const open = readComments(root).filter((c) => c.status === "open");
      if (open.length) {
        const ids = new Set(open.map((c) => c.id));
        update(root, (l) => l.forEach((c) => ids.has(c.id) && (c.status = "sent")));
        console.log(open.map(fmt).join("\n"));
        console.log(`When done: cdesign resolve ${open.map((c) => c.id).join(" ")}`);
        break;
      }
      if (timeout && Date.now() - start > timeout) { console.log("no new comments (timeout)"); break; }
      await Bun.sleep(500);
    }
    break;
  }
  case "comments": {
    const root = resolve(".");
    const l = readComments(root).filter((c) => rest.includes("--all") || c.status !== "done");
    console.log(l.length ? l.map((c) => `[${c.status}]\n${fmt(c)}`).join("\n") : "no pending comments");
    break;
  }
  case "resolve": {
    const root = resolve(".");
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

Source of truth for prototypes. Update it in the same edit as any token, style or component change.

## Tokens
Source of truth: \`design/tokens.json\` (query it with \`cdesign tokens search|show\`, change it with \`cdesign tokens set|rm\`). Do not list tokens here; document rules for using them.

## Typography and layout rules

## Components
Files in \`design/components/\`, used as \`<c-name prop="x">children</c-name>\`.
| Component | Props | Slots | Notes |
|---|---|---|---|

## Patterns and rules
`);
    if (existsSync(join(root, "design/tokens.json"))) console.log("exists  design/tokens.json");
    else console.log(tk.init(root));
    put("design/_head.html", `<!-- injected into every prototype's <head>: tokens, fonts, Tailwind, resets -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/design/tokens.css">
`);
    mkdirSync(join(root, "design/pages"), { recursive: true });
    mkdirSync(join(root, "design/preview"), { recursive: true });
    mkdirSync(join(root, "design/components"), { recursive: true });
    break;
  }
  case "check": {
    const root = resolve(rest[0] ?? ".");
    const dir = join(root, "design");
    const files = existsSync(dir) ? walk(dir, root).filter((f) => /\.(html|css)$/.test(f)) : [];
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    const mdPath = join(dir, "design-system.md");
    const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
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
    for (const v of defined) if (!hasTokens && md && !md.includes(v)) warnings.push(`${v} is defined but not documented in design-system.md`);
    const idx = componentIndex(root);
    for (const f of files.filter((f) => f.endsWith(".html")))
      for (const m of read(f).matchAll(/<c-([\w-]+)/g)) if (!idx.has(m[1])) problems.push(`<c-${m[1]}> used in ${f} has no component file`);
    const previews = new Set(files.filter((f) => /\/preview\/[^/]+\.html$/.test(f)).map((f) => f.split("/").pop()!.slice(0, -5)));
    for (const n of idx.keys()) if (!previews.has(n)) warnings.push(`component "${n}" has no design/preview/${n}.html`);
    for (const n of idx.keys()) if (md && !md.includes(`c-${n}`) && !md.includes(n)) warnings.push(`component "${n}" is not documented in design-system.md`);
    for (const p of problems) console.log("ERROR  " + p);
    for (const w of warnings) console.log("WARN   " + w);
    if (!problems.length && !warnings.length) console.log("design system in sync");
    process.exitCode = problems.length || warnings.length ? 1 : 0;
    break;
  }
  case "tokens": {
    const root = resolve(".");
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
  case "skills":
    printSkills();
    break;
  case "context":
    printContext(resolve(rest[0] ?? "."));
    break;
  default:
    console.log(`cdesign <command>
  open [dir] [--port n] [--no-browser]  start viewer, print skills + project context
  wait [--timeout s]                    block until an element comment arrives, print it
  resolve <id...>                       mark comments done
  comments [--all]                      list pending comments
  init [dir]                            scaffold design/ (design-system.md, tokens, _head, pages, components)
  check                                 verify tokens/components are defined and documented
  tokens <sub>                          query/change design/tokens.json, export css or tailwind (run: cdesign tokens)
  skills                                print the cdesign usage skill
  context [dir]                         print tokens/components/pages found in project
  serve [dir]                           run the viewer in the foreground`);
}
void commentsPath;
