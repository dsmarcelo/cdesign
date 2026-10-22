import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// design/tokens.json uses the Claude Design shape:
//   color:  { themes, tokens: [{ name, value: { light, dark }, usage }] }
//   type:   { families: { sans, mono }, groups: [{ name, styles: [{ name, fontSize, lineHeight, fontWeight, usage }] }] }
//   other:  { note, tokens: [{ name, value, usage }] }   (spacing radius size shadow fontSize duration easing)

type Themed = { light: string; dark: string };
export type Tok = { name: string; value: string | Themed; usage?: string };
type Style = { name: string; family?: string; fontSize: string; lineHeight: string; fontWeight: number | string; letterSpacing?: string; usage?: string; sample?: string };
type Group = { name: string; family?: string; styles: Style[] };
export type Doc = {
  meta?: { note?: string };
  color?: { note?: string; themes?: unknown[]; tokens: Tok[] };
  type?: { note?: string; fonts?: unknown[]; families?: Record<string, string>; groups?: Group[] };
  [section: string]: any;
};

export const FLAT = ["spacing", "radius", "size", "shadow", "fontSize", "duration", "easing"] as const;
const PREFIX: Record<string, string> = { spacing: "space-", radius: "radius-", size: "size-", shadow: "shadow-", fontSize: "font-", duration: "duration-", easing: "ease-" };

export const tokensPath = (root: string) => join(root, "design", "tokens.json");
export const cssPath = (root: string) => join(root, "design", "tokens.css");

export function loadTokens(root: string): Doc | null {
  try { return JSON.parse(readFileSync(tokensPath(root), "utf8")); } catch { return null; }
}
const save = (root: string, doc: Doc) => {
  mkdirSync(dirname(tokensPath(root)), { recursive: true });
  writeFileSync(tokensPath(root), JSON.stringify(doc, null, 2) + "\n");
};

const isThemed = (v: unknown): v is Themed => typeof v === "object" && v !== null && "light" in v;
const fmt = (v: Tok["value"]) => (isThemed(v) ? `light ${v.light}  dark ${v.dark}` : String(v));
const varName = (section: string, name: string) => (section === "color" ? `--color-${name}` : `--${name}`);
const styles = (doc: Doc) => (doc.type?.groups ?? []).flatMap((g) => g.styles.map((s) => ({ ...s, group: g.name, family: s.family ?? g.family ?? "sans" })));

type Row = { section: string; name: string; value: string; usage: string };
function rows(doc: Doc): Row[] {
  const out: Row[] = [];
  if (doc.color) for (const t of doc.color.tokens) out.push({ section: "color", name: t.name, value: fmt(t.value), usage: t.usage ?? "" });
  for (const s of FLAT) for (const t of doc[s]?.tokens ?? []) out.push({ section: s, name: t.name, value: fmt(t.value), usage: t.usage ?? "" });
  for (const s of styles(doc)) out.push({ section: "type", name: s.name, value: `${s.family} ${s.fontSize}/${s.lineHeight} w${s.fontWeight}${s.letterSpacing ? ` ls ${s.letterSpacing}` : ""}`, usage: s.usage ?? "" });
  return out;
}
const line = (r: Row) => `${r.name}  ${r.value}${r.usage ? `  - ${r.usage}` : ""}`;

// ---------- digest: what `cdesign open` prints instead of the whole file ----------
function compact(names: string[]): string {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const i = n.indexOf("-");
    const seg = i < 0 ? n : n.slice(0, i);
    (groups.get(seg) ?? groups.set(seg, []).get(seg)!).push(i < 0 ? "" : n.slice(i + 1));
  }
  // segments that share the same set of suffixes print once: (danger|success)-{background,border}
  const byRest = new Map<string, string[]>();
  for (const [seg, rest] of groups) {
    const r = rest.filter(Boolean);
    const key = r.length ? (rest.includes("") ? ["", ...r] : r).join(",") : "";
    (byRest.get(key) ?? byRest.set(key, []).get(key)!).push(seg);
  }
  return [...byRest].map(([key, segs]) => (key === "" ? segs.join(" ") : `${segs.length > 1 ? `(${segs.join("|")})` : segs[0]}-{${key}}`)).join(" ");
}

export function digest(root: string): string {
  const doc = loadTokens(root);
  if (!doc) return "";
  const size = Math.round(readFileSync(tokensPath(root)).length / 1024);
  const o = [`=== DESIGN TOKENS (design/tokens.json, ${size} KB: never read it directly, query it) ===`];
  o.push("cdesign tokens search <words>   find tokens by name/usage (returns value + usage)");
  o.push("cdesign tokens show <section> [prefix]   full lines for one section");
  o.push("cdesign tokens set|rm ...   change tokens (rebuilds design/tokens.css); cdesign tokens export css|tailwind for the real project");
  if (doc.meta?.note) o.push(`note: ${doc.meta.note}`);
  const note = (n?: string) => (n ? `\n  note: ${n}` : "");
  if (doc.color) o.push(`color (${doc.color.tokens.length}, light+dark) var --color-<name>: ${compact(doc.color.tokens.map((t) => t.name))}${note(doc.color.note)}`);
  for (const s of FLAT) if (doc[s]?.tokens?.length) o.push(`${s} (${doc[s].tokens.length}) var --<name>: ${doc[s].tokens.map((t: Tok) => t.name).join(" ")}${note(doc[s].note)}`);
  if (doc.type) {
    const fam = Object.keys(doc.type.families ?? {}).map((k) => `--font-${k}`).join(" ");
    o.push(`type: families ${fam}; classes .type-<name>${note(doc.type.note)}`);
    for (const g of doc.type.groups ?? []) o.push(`  ${g.name}: ${g.styles.map((s) => s.name).join(" ")}`);
  }
  return o.join("\n") + "\n";
}

// ---------- queries ----------
export function search(root: string, terms: string[], limit: number): string {
  const doc = loadTokens(root);
  if (!doc) return "no design/tokens.json (run `cdesign init`)";
  const all = rows(doc);
  const hit = all.filter((r) => terms.every((t) => `${r.section} ${r.name} ${r.value} ${r.usage}`.toLowerCase().includes(t.toLowerCase())));
  const shown = hit.slice(0, limit).map((r) => `[${r.section}] ${line(r)}`);
  return (shown.join("\n") || "no matches") + (hit.length > limit ? `\n… ${hit.length - limit} more (use --all)` : "");
}

export function show(root: string, section?: string, prefix?: string): string {
  const doc = loadTokens(root);
  if (!doc) return "no design/tokens.json (run `cdesign init`)";
  const all = rows(doc);
  if (!section) return [...new Set(all.map((r) => r.section))].map((s) => `${s} (${all.filter((r) => r.section === s).length})`).join("\n");
  const out = all.filter((r) => r.section === section && (!prefix || r.name.startsWith(prefix)));
  return out.map(line).join("\n") || `nothing in "${section}"${prefix ? ` with prefix "${prefix}"` : ""}`;
}

// ---------- writes ----------
export function set(root: string, target: string, f: Record<string, string>): string {
  const doc = loadTokens(root) ?? ({} as Doc);
  const [section, ...restPath] = target.split("/");
  let name = restPath.join("/");
  if (!section || !name) return "usage: cdesign tokens set <section>/<name> --value v [--light v --dark v] --usage text";

  if (section === "type") {
    doc.type ??= { families: {}, groups: [] };
    doc.type.groups ??= [];
    const all = doc.type.groups.flatMap((g) => g.styles);
    const cur = all.find((s) => s.name === name);
    const usage = f.usage ?? cur?.usage;
    if (!usage) return "new tokens need --usage (what is it for?)";
    if (cur) Object.assign(cur, { fontSize: f.size ?? cur.fontSize, lineHeight: f.line ?? cur.lineHeight, fontWeight: f.weight ? +f.weight : cur.fontWeight, usage, ...(f.family && { family: f.family }), ...(f.ls && { letterSpacing: f.ls }), ...(f.sample && { sample: f.sample }) });
    else {
      if (!f.size || !f.line || !f.weight) return "new type styles need --size --line --weight";
      const gname = f.group ?? "Other";
      let g = doc.type.groups.find((x) => x.name === gname);
      if (!g) doc.type.groups.push((g = { name: gname, family: "sans", styles: [] }));
      g.styles.push({ name, fontSize: f.size, lineHeight: f.line, fontWeight: +f.weight, usage, ...(f.family && { family: f.family }), ...(f.ls && { letterSpacing: f.ls }), ...(f.sample && { sample: f.sample }) });
    }
  } else if (section === "color" || (FLAT as readonly string[]).includes(section)) {
    if (section !== "color" && !name.startsWith(PREFIX[section])) name = PREFIX[section] + name;
    doc[section] ??= section === "color" ? { themes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }], tokens: [] } : { tokens: [] };
    const list: Tok[] = doc[section].tokens;
    const cur = list.find((t) => t.name === name);
    let value: Tok["value"] | undefined = cur?.value;
    if (section === "color") {
      const base = isThemed(cur?.value) ? cur!.value as Themed : undefined;
      const light = f.light ?? f.value ?? base?.light, dark = f.dark ?? f.value ?? base?.dark;
      if (!light || !dark) return "color tokens need --light and --dark (or --value for both)";
      value = { light, dark };
    } else if (f.value) value = f.value;
    const usage = f.usage ?? cur?.usage;
    if (value === undefined) return "missing --value";
    if (!usage) return "new tokens need --usage (what is it for?)";
    if (cur) Object.assign(cur, { value, usage });
    else list.push({ name, value, usage });
  } else return `unknown section "${section}". sections: color, type, ${FLAT.join(", ")}`;

  save(root, doc);
  writeFileSync(cssPath(root), buildCss(doc));
  return `saved ${target}; rebuilt design/tokens.css`;
}

export function remove(root: string, target: string): string {
  const doc = loadTokens(root);
  if (!doc) return "no design/tokens.json";
  const [section, ...p] = target.split("/");
  let name = p.join("/");
  let n = 0;
  if (section === "type") for (const g of doc.type?.groups ?? []) { const b = g.styles.length; g.styles = g.styles.filter((s) => s.name !== name); n += b - g.styles.length; }
  else if (doc[section]?.tokens) {
    if (section !== "color" && !name.startsWith(PREFIX[section] ?? "")) name = (PREFIX[section] ?? "") + name;
    const b = doc[section].tokens.length;
    doc[section].tokens = doc[section].tokens.filter((t: Tok) => t.name !== name);
    n = b - doc[section].tokens.length;
  }
  if (!n) return `no token ${target}`;
  save(root, doc);
  writeFileSync(cssPath(root), buildCss(doc));
  return `removed ${target}; rebuilt design/tokens.css`;
}

// ---------- generators ----------
const HEADER = "Generated from design/tokens.json by `cdesign tokens`. Do not edit by hand.";
const decls = (pairs: [string, string][], indent = "  ") => pairs.map(([k, v]) => `${indent}${k}: ${v};`).join("\n");
const darkPairs = (doc: Doc): [string, string][] => (doc.color?.tokens ?? []).filter((t) => isThemed(t.value)).map((t) => [`--color-${t.name}`, (t.value as Themed).dark]);
const lightPairs = (doc: Doc): [string, string][] => (doc.color?.tokens ?? []).map((t) => [`--color-${t.name}`, isThemed(t.value) ? t.value.light : String(t.value)]);
const typeDecls = (s: Style & { family: string }, fam: (f: string) => string) =>
  `font-family: ${fam(s.family)}; font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ""}`;

function darkBlocks(doc: Doc): string {
  const d = darkPairs(doc);
  if (!d.length) return "";
  return `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${decls(d, "    ")}\n    color-scheme: dark;\n  }\n}\n:root[data-theme="dark"] {\n${decls(d)}\n  color-scheme: dark;\n}\n:root[data-theme="light"] { color-scheme: light; }\n`;
}

/** Plain CSS: custom properties (light, dark via media query and [data-theme]) and .type-* classes. */
export function buildCss(doc: Doc): string {
  const flat: [string, string][] = [];
  for (const s of FLAT) for (const t of doc[s]?.tokens ?? []) flat.push([varName(s, t.name), String(t.value)]);
  for (const [k, v] of Object.entries(doc.type?.families ?? {})) flat.push([`--font-${k}`, v]);
  const cls = styles(doc).map((s) => `.type-${s.name} { ${typeDecls(s, (f) => `var(--font-${f})`)} }`).join("\n");
  return `/* ${HEADER} */\n:root {\n${decls([...lightPairs(doc), ...flat])}\n  color-scheme: light dark;\n}\n${darkBlocks(doc)}${cls ? "\n" + cls + "\n" : ""}`;
}

/** Tailwind v4 (CSS-first). Import it after `@import "tailwindcss";`. */
export function buildTailwind(doc: Doc): string {
  const strip = (n: string, p: string) => (n.startsWith(p) ? n.slice(p.length) : n);
  const theme: [string, string][] = [...lightPairs(doc)];
  const plain: [string, string][] = [];
  for (const [k, v] of Object.entries(doc.type?.families ?? {})) theme.push([`--font-${k}`, v]);
  for (const t of doc.fontSize?.tokens ?? []) theme.push([`--text-${strip(t.name, "font-")}`, String(t.value)]);
  for (const t of doc.radius?.tokens ?? []) theme.push([`--radius-${strip(t.name, "radius-")}`, String(t.value)]);
  for (const t of doc.shadow?.tokens ?? []) theme.push([`--shadow-${strip(t.name, "shadow-")}`, String(t.value)]);
  for (const t of doc.easing?.tokens ?? []) theme.push([`--ease-${strip(t.name, "ease-")}`, String(t.value)]);
  for (const t of doc.size?.tokens ?? []) theme.push([`--spacing-${strip(t.name, "size-")}`, String(t.value)]);
  for (const t of doc.spacing?.tokens ?? []) plain.push([`--${t.name}`, String(t.value)]);
  for (const t of doc.duration?.tokens ?? []) plain.push([`--${t.name}`, String(t.value)]);
  const utils = styles(doc).map((s) => `@utility type-${s.name} {\n  ${typeDecls(s, (f) => `var(--font-${f})`)}\n}`).join("\n");
  return `/* ${HEADER}
 * Tailwind v4. Use after \`@import "tailwindcss";\`
 *   colors   bg-background-primary text-foreground-primary border-border-default ...
 *   radius   rounded-md  | shadow  shadow-sm | easing  ease-standard | font  font-sans
 *   text     text-14 (font size only) and type-<style> for full text styles (type-page-title)
 *   size     h-touch w-xs size-md ... (size-* tokens live in the spacing scale; default p-4 = 16px is untouched)
 *   spacing  4px grid = Tailwind's default unit (space-16 = p-4, space-2 = p-0.5); also --space-N vars
 *   motion   duration-(--duration-fast)
 * Dark mode: [data-theme="dark"] or prefers-color-scheme; use the dark: variant (data-theme based).
 */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme static {
${decls(theme)}
}

:root {
${decls(plain)}
}
${darkBlocks(doc)}${utils ? "\n" + utils + "\n" : ""}`;
}

export function exportTokens(root: string, kind: string, out?: string): string {
  const doc = loadTokens(root);
  if (!doc) return "no design/tokens.json (run `cdesign init`)";
  if (kind !== "css" && kind !== "tailwind") return "usage: cdesign tokens export <css|tailwind> [-o path]";
  const text = kind === "css" ? buildCss(doc) : buildTailwind(doc);
  if (!out) return text;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return `wrote ${out} (${kind})`;
}

// ---------- checks ----------
export function tokenWarnings(root: string): string[] {
  const doc = loadTokens(root);
  if (!doc) return [];
  const w: string[] = [];
  for (const r of rows(doc)) if (!r.usage.trim()) w.push(`token ${r.section}/${r.name} has no usage`);
  if (existsSync(cssPath(root)) && readFileSync(cssPath(root), "utf8") !== buildCss(doc)) w.push("design/tokens.css is out of date: run `cdesign tokens build`");
  return w;
}

export function hardcoded(file: string, text: string): string[] {
  const out: string[] = [];
  const hex = [...text.matchAll(/(?<![&\w])#[0-9a-fA-F]{3,8}\b(?![-\w])/g)].map((m) => m[0]).filter((h) => [4, 5, 7, 9].includes(h.length));
  if (hex.length) out.push(`${file}: hardcoded colors ${[...new Set(hex)].slice(0, 5).join(", ")}: use color tokens (var(--color-…))`);
  const px = [...text.matchAll(/(font-size|border-radius)\s*:\s*\d+px/g)].map((m) => m[1]);
  if (px.length) out.push(`${file}: hardcoded ${[...new Set(px)].join(", ")} in px: use font-*/radius-* tokens`);
  return out;
}

export function init(root: string): string {
  const doc: Doc = {
    meta: { note: "Source of truth for design tokens. Edit with `cdesign tokens set`, never by hand." },
    color: { themes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }], tokens: [] },
    type: { families: { sans: '"Inter", system-ui, sans-serif', mono: "ui-monospace, Menlo, monospace" }, groups: [] },
    spacing: { note: "4px grid.", tokens: [] },
    radius: { tokens: [] },
    size: { tokens: [] },
    shadow: { tokens: [] },
    fontSize: { tokens: [] },
    duration: { tokens: [] },
    easing: { tokens: [] },
  };
  save(root, doc);
  writeFileSync(cssPath(root), buildCss(doc));
  return "created design/tokens.json and design/tokens.css";
}
