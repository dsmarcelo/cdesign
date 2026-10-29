import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { previewOf } from "./render";
import { components as componentIndex, tsxInfo, directComponents } from "./modes";
import { readConfig } from "./project";
import { componentPreview } from "./previews";

type Entry = { id: string; title: string; file: string; body: string; kind: "doc" | "section" | "component" };
const SKIP = new Set(["node_modules", ".git", ".cdesign", "vendor", "reference", "references", "exported-ds", "previews"]);
const PAGE = 20, CHARS = 6000;
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const outside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);

/** Only maintained design guidance; imported references and runtimes are opt-in source reads. */
export function guidanceFiles(root: string): string[] {
  const out: string[] = [];
  const scan = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink() || SKIP.has(item.name)) continue;
      const p = join(dir, item.name);
      if (item.isDirectory()) scan(p);
      else if (item.name.endsWith(".md")) out.push(relative(root, p).split(sep).join("/"));
    }
  };
  scan(join(root, "design"));
  return out.sort((a, b) => Number(b === "design/design-system.md") - Number(a === "design/design-system.md") || a.localeCompare(b));
}

export function contract(root: string, file: string): string {
  const source = read(root, file);
  if (file.endsWith(".tsx")) {
    const info = tsxInfo(source, file);
    const dependencies = directComponents(root, file, componentIndex(root));
    const preview = componentPreview(root, file);
    return `Source: ${file}\nPreview: ${preview ? preview.file + (preview.inline ? " (named Preview export)" : "") : `${file} (missing named Preview export or ${previewOf(file)})`}\n${info.header || "No JSDoc contract; inspect source before changing behavior."}\nProps: ${info.props.join("\n") || "inspect source"}\nDefaults: ${info.defaults.join(", ") || "none"}\nChildren/named content: React props\nDependencies: ${dependencies.join(", ") || "none"}`;
  }
  const header = source.match(/^\s*((?:<!--[\s\S]*?-->\s*)+)/)?.[1]?.trim();
  const props = [...new Set([...source.matchAll(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g)].map(m => m[2] === undefined ? m[1] : `${m[1]}=${JSON.stringify(m[2])}`))];
  const slots = [...new Set([...source.matchAll(/<slot\b([^>]*)>/gi)].map(m => m[1].match(/\bname=["']([^"']+)["']/)?.[1] ?? "default"))];
  const deps = [...new Set([...source.matchAll(/<c-([\w-]+)/g)].map(m => m[1]))];
  return `Source: ${file}\nPreview: ${previewOf(file)}${existsSync(join(root, previewOf(file))) ? "" : " (missing)"}\n${header ? `Contract:\n${header}\n` : "No header contract; inspect source before changing behavior.\n"}Props/defaults: ${props.join(", ") || "none"}\nSlots: ${slots.join(", ") || "none"}\nDependencies: ${deps.join(", ") || "none"}`;
}

function entries(root: string): Entry[] {
  const out: Entry[] = [];
  for (const file of guidanceFiles(root)) {
    const body = read(root, file), id = file.replace(/^design\//, "").replace(/\.md$/, "");
    out.push({ id, title: body.match(/^#\s+(.+)$/m)?.[1] ?? id, file, body, kind: "doc" });
    const lines = body.split("\n"), headings: { line: number; title: string }[] = [];
    let fence = "";
    lines.forEach((line, i) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = ""; return; }
      if (!fence) { const m = line.match(/^#{2,6}\s+(.+?)\s*#*$/); if (m) headings.push({ line: i, title: m[1] }); }
    });
    out.push({ id: `${id}#overview`, title: "Overview", file, body: lines.slice(0, headings[0]?.line ?? lines.length).join("\n"), kind: "section" });
    const seen = new Map<string, number>([["overview", 1]]);
    headings.forEach((h, i) => {
      const base = slug(h.title), count = seen.get(base) ?? 0; seen.set(base, count + 1);
      out.push({ id: `${id}#${base}${count ? `-${count + 1}` : ""}`, title: h.title, file, body: lines.slice(h.line, headings[i + 1]?.line ?? lines.length).join("\n"), kind: "section" });
    });
  }
  for (const [name, file] of componentIndex(root)) {
    if (file.split("/").some(p => SKIP.has(p))) continue;
    out.push({ id: `component/${name}`, title: name, file, body: contract(root, file), kind: "component" });
  }
  return out;
}

export function context(root: string, action = "list", query = "", offset = 0): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  const all = entries(root);
  if (action === "get") {
    const entry = all.find(e => e.id === query);
    if (!entry) throw new Error(`Unknown context id: ${query}. Use context find <words>.`);
    return `${entry.id} (${entry.file})\n${entry.body.slice(offset, offset + CHARS)}${offset + CHARS < entry.body.length ? `\n[More text: cdesign context get "${entry.id}" --offset ${offset + CHARS}]` : ""}`;
  }
  if (action === "for") {
    const file = resolve(root, query), rel = relative(root, file);
    if (!query || outside(rel) || !existsSync(file) || !statSync(file).isFile() || outside(relative(realpathSync(root), realpathSync(file)))) throw new Error("Target must be a file inside this project");
    const source = readFileSync(file, "utf8");
    const names = new Set(file.endsWith(".tsx") ? directComponents(root, query, componentIndex(root)) : [...source.matchAll(/<c-([\w-]+)/g)].map(m => m[1]));
    const own = all.find(e => e.kind === "component" && resolve(root, e.file) === file);
    const related = all.filter(e => e.kind === "doc" && (dirname(e.file) === relative(root, dirname(file)).split(sep).join("/") || e.id === "design-system"));
    const rows = [...(own ? [`Contract: ${own.id}`] : []), ...[...names].map(n => `Dependency: component/${n}`), ...related.map(e => `Guidance: ${e.id}`)];
    return `${rel}\nShared setup: ${readConfig(root).mode === "react" ? "design/tailwind.css (Tailwind tokens/themes) or design/styles.css and design/tokens.css (plain CSS)" : "design/_head.html"}\n${list(rows, offset, `context for ${JSON.stringify(query)}`)}\nDependencies are references, not expanded source. Search for task-specific patterns with context find.`;
  }
  if (action !== "list" && action !== "find") throw new Error("Use context [list|find <words>|get <id>|for <path>] [--offset n]");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all.filter(e => action === "list" ? e.kind !== "section" : terms.every(t => `${e.id} ${e.title} ${e.body}`.toLowerCase().includes(t)));
  if (action === "find") {
    const score = (e: Entry) => terms.reduce((n, t) => n + (`${e.id} ${e.title}`.toLowerCase().includes(t) ? 10 : 0), e.kind === "doc" ? 0 : 1);
    hits.sort((a, b) => score(b) - score(a));
  }
  return `Context (${hits.length} matches). Read design-system#overview first; then relevant sections/contracts.\n${list(hits.map(e => `${e.id} — ${e.title} (${e.file})`), offset, action === "find" ? `context find ${JSON.stringify(query)}` : "context")}\nRead: cdesign context get <id>; tokens: cdesign tokens search <words>. Offsets count entries here, characters for get.`;
}

function list(rows: string[], offset: number, command: string): string {
  return (rows.slice(offset, offset + PAGE).join("\n") || "No matches.") + (offset + PAGE < rows.length ? `\n[More: cdesign ${command} --offset ${offset + PAGE}]` : "");
}

export function startup(): string {
  return `Reuse the project's identity, components and semantic tokens. In Tailwind mode, edit shared tokens/themes in design/tailwind.css, documenting purpose in preceding CSS comments and use utility classes with complete variant maps in TSX; do not create paired component CSS files. Before editing, read cdesign context get "design-system#overview", then find only relevant guidance with cdesign context find <words> or context for <path>. Read component contracts with context get component/<name>; token values with tokens search <words>.\nUsage: cdesign skills get cdesign. Building/maintaining a system: skills get cdesign-system. Reviewing UI: skills get cdesign-review. Converting HTML/React: skills get cdesign-convert.\nComments: run cdesign wait in a background shell when supported; otherwise review when the user sends comments. Apply the batch, then resolve <ids>.\nUpdate canonical guidance only when shared rules/contracts change; update affected component previews and run cdesign check. Full inventories: cdesign context --full (explicit opt-in).`;
}
