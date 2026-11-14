// Direct style edits from the viewer's Select panel: rewrite one element's classes (Tailwind) or inline style in its source file.
// Elements are addressed like everywhere else: file + data-cd-id ("line:col" of the start tag in that file).
import ts from "typescript";
import postcss from "postcss";
import { parse, parseFragment } from "parse5";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "./project";
import { insideProject } from "./modes";
import { TAILWIND_SIZE_NAMES, sizeTokens } from "./tokens";

export type Prop = "color" | "background-color" | "border-color" | "font-size" | "font-weight";
/** `token`: a color token name, or a font-size token name; `value`: the raw CSS value (used when there is no token). */
export type Change = { prop: Prop; token?: string; value: string };
export type Scope = "element" | "instance";
type Target = { file: string; id: string };
type Result = { ok: boolean; text?: string; reason?: string };
type N = any;

const PROPS: Prop[] = ["color", "background-color", "border-color", "font-size", "font-weight"];
const CAMEL: Record<Prop, string> = { color: "color", "background-color": "backgroundColor", "border-color": "borderColor", "font-size": "fontSize", "font-weight": "fontWeight" };
const WEIGHTS: Record<string, string> = { "100": "thin", "200": "extralight", "300": "light", "400": "normal", "500": "medium", "600": "semibold", "700": "bold", "800": "extrabold", "900": "black" };
const fail = (reason: string): Result => ({ ok: false, reason });
const parseUse = (use: string): Target | null => { const m = use.match(/^(.*):(\d+:\d+)$/); return m ? { file: m[1], id: m[2] } : null; };

// ---------- Tailwind classes ----------
/** Which edited property a utility class sets (plain utilities only: variants like hover:/dark:/md: are left alone). */
export function classGroup(cls: string, sizeNames: Set<string>): Prop | null {
  if (cls.includes(":")) return null;
  const c = cls.replace(/^!|!$/g, "");
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^text-(.+)$/))) {
    const v = m[1].split("/")[0];
    if (/^(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/.test(v)) return null;
    if (sizeNames.has(v) || /^\[(length:|[\d.]|calc\(|clamp\(|min\(|max\()/.test(v) || /^\(length:/.test(v)) return "font-size";
    return "color";
  }
  if ((m = c.match(/^bg-(.+)$/))) {
    if (/^(none|fixed|local|scroll|cover|contain|auto|repeat|repeat-.*|no-repeat|space|round|center|top|bottom|left|right|(top|bottom|left|right)-.*|clip-.*|origin-.*|blend-.*|gradient-.*|linear-.*|radial.*|conic.*|size-.*|position-.*|\[url.*|\[image:.*|\(image:.*)$/.test(m[1])) return null;
    return "background-color";
  }
  if ((m = c.match(/^border-(.+)$/))) {
    if (/^(x|y|t|r|b|l|s|e|bs|be)(-|$)/.test(m[1]) || /^(\d+|\[[\d.].*|\(length:.*|\[length:.*|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing.*)$/.test(m[1])) return null;
    return "border-color";
  }
  if (/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\])$/.test(c)) return "font-weight";
  return null;
}
const arbitrary = (v: string) => `[${v.trim().replace(/\s+/g, "_")}]`;
function utility(ch: Change, important: boolean): string {
  let c: string;
  if (ch.prop === "font-weight") c = WEIGHTS[ch.value] ? `font-${WEIGHTS[ch.value]}` : `font-${arbitrary(ch.value)}`;
  else if (ch.prop === "font-size") c = `text-${ch.token ?? arbitrary(ch.value)}`;
  else c = `${{ color: "text", "background-color": "bg", "border-color": "border" }[ch.prop]}-${ch.token ?? arbitrary(ch.value)}`;
  return important ? c + "!" : c;
}
/** Drop the classes these changes replace; returns the remaining list. */
const strip = (list: string, props: Set<Prop>, sizes: Set<string>) => list.split(/\s+/).filter((c) => c && !props.has(classGroup(c, sizes)!));
const conflicts = (list: string, props: Set<Prop>, sizes: Set<string>) => list.split(/\s+/).some((c) => c && props.has(classGroup(c, sizes)!));

// ---------- inline style ----------
const cssValue = (ch: Change) => (ch.token ? (ch.prop === "font-size" ? ch.token : `var(--color-${ch.token})`) : ch.value);
function editStyleText(style: string, changes: Change[]): string {
  const root = postcss.parse(style);
  for (const ch of changes) {
    const v = cssValue(ch);
    let found = false;
    root.walkDecls(ch.prop, (d) => { if (!found) { d.value = v; found = true; } else d.remove(); });
    if (!found) root.append({ prop: ch.prop, value: v });
  }
  root.raws.semicolon = true;
  return root.toString().replace(/\s*\n\s*/g, " ").trim();
}

type Ctx = { tailwind: boolean; sizes: Set<string>; important: boolean; fontVars: Map<string, string> };
const resolveChange = (ch: Change, ctx: Ctx): Change => (ch.prop === "font-size" && ch.token && !ctx.tailwind ? { ...ch, token: `var(${ctx.fontVars.get(ch.token) ?? `--${ch.token}`})` } : ch);

// ---------- TSX ----------
const sf = (text: string, file: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function jsxAt(src: ts.SourceFile, id: string): ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined {
  let found: ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const p = src.getLineAndCharacterOfPosition(n.getStart(src));
      if (`${p.line + 1}:${p.character + 1}` === id) { found = n; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return found;
}
const jsxAttr = (el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) =>
  el.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === name);
type Edit = { start: number; end: number; text: string };
const applyEdits = (text: string, edits: Edit[]) => edits.sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

function tsxClassEdits(src: ts.SourceFile, el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, changes: Change[], ctx: Ctx): Edit[] | string {
  const props = new Set(changes.map((c) => c.prop)), add = changes.map((c) => utility(c, ctx.important));
  const attr = jsxAttr(el, "className");
  const quote = (s: string) => JSON.stringify(s);
  if (!attr) return [{ start: el.attributes.end, end: el.attributes.end, text: ` className=${quote(add.join(" "))}` }];
  let init: ts.Node | undefined = attr.initializer;
  if (init && ts.isJsxExpression(init)) init = init.expression;
  if (!init) return "className has no value";
  const literal = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  if (literal(init)) {
    const lit = init as ts.StringLiteral;
    const next = [...strip(lit.text, props, ctx.sizes), ...add].join(" ");
    return [{ start: lit.getStart(src), end: lit.end, text: ts.isNoSubstitutionTemplateLiteral(lit) ? "`" + next + "`" : quote(next) }];
  }
  if (ts.isTemplateExpression(init)) {
    const edits: Edit[] = [];
    const parts: ts.Node[] = [init.head, ...init.templateSpans.map((s) => s.literal)];
    parts.forEach((p, i) => {
      const raw = (p as ts.TemplateLiteralLikeNode).rawText ?? "";
      if (!conflicts(raw, props, ctx.sizes) && i) return;
      const lead = raw.match(/^\s*/)![0], trail = raw.match(/\s*$/)![0];
      let body = strip(raw, props, ctx.sizes);
      if (!i) body = [...body, ...add];
      const text = body.length ? lead + body.join(" ") + (trail || (!i && init!.templateSpans.length ? " " : "")) : lead || trail;
      const start = p.getStart(src) + 1, end = p.end - (p.kind === ts.SyntaxKind.TemplateTail ? 1 : 2); // inside ` / } and ${ / `
      edits.push({ start, end, text });
    });
    return edits;
  }
  if (ts.isCallExpression(init)) {
    // cn("...", cond && "...", className): edit the plain string arguments
    const lits = init.arguments.filter((a) => literal(a)) as (ts.StringLiteral | ts.NoSubstitutionTemplateLiteral)[];
    const others = init.arguments.filter((a) => !literal(a)).map((a) => a.getText(src)).join(" ");
    if (others && conflicts(others.replace(/[^\w\s:/[\]#.!-]/g, " "), props, ctx.sizes) && !ctx.important) return "className sets these styles conditionally in code";
    if (!lits.length) return [{ start: init.arguments.pos, end: init.arguments.pos, text: quote(add.join(" ")) + (init.arguments.length ? ", " : "") }];
    const edits: Edit[] = [];
    lits.forEach((l, i) => {
      const keep = strip(l.text, props, ctx.sizes), body = i ? keep : [...keep, ...add];
      if (i && !conflicts(l.text, props, ctx.sizes)) return;
      edits.push({ start: l.getStart(src), end: l.end, text: ts.isNoSubstitutionTemplateLiteral(l) ? "`" + body.join(" ") + "`" : quote(body.join(" ")) });
    });
    return edits;
  }
  return "className is computed in code";
}

function tsxStyleEdits(src: ts.SourceFile, el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, changes: Change[]): Edit[] | string {
  const pairs = changes.map((c) => `${CAMEL[c.prop]}: ${JSON.stringify(cssValue(c))}`);
  const attr = jsxAttr(el, "style");
  if (!attr) return [{ start: el.attributes.end, end: el.attributes.end, text: ` style={{ ${pairs.join(", ")} }}` }];
  const init = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
  if (!init || !ts.isObjectLiteralExpression(init)) return "style is computed in code";
  const edits: Edit[] = [], append: string[] = [];
  changes.forEach((c, i) => {
    const p = init.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && [CAMEL[c.prop], c.prop].includes(p.name.text));
    if (p) edits.push({ start: p.initializer.getStart(src), end: p.initializer.end, text: JSON.stringify(cssValue(c)) });
    else append.push(pairs[i]);
  });
  if (append.length) {
    const last = init.properties[init.properties.length - 1];
    edits.push(last ? { start: last.end, end: last.end, text: ", " + append.join(", ") } : { start: init.getStart(src) + 1, end: init.end - 1, text: ` ${append.join(", ")} ` });
  }
  return edits;
}

function editTsx(text: string, file: string, id: string, changes: Change[], ctx: Ctx): Result {
  const src = sf(text, file), el = jsxAt(src, id);
  if (!el) return fail(`element ${id} not found in ${file}`);
  const edits = ctx.tailwind ? tsxClassEdits(src, el, changes, ctx) : tsxStyleEdits(src, el, changes);
  if (typeof edits === "string") return fail(edits);
  const out = applyEdits(text, edits);
  if ((sf(out, file) as any).parseDiagnostics?.length) return fail("the edit would break the file");
  return { ok: true, text: out };
}

// ---------- HTML ----------
// The renderer parses `<c-x />` as `<c-x></c-x>`; edit that normalized text but map offsets back to the original.
function normalizeMapped(s: string) {
  const shifts: { at: number; delta: number }[] = [];
  let out = "", last = 0;
  for (const m of s.matchAll(/<(c-[\w-]+)([^<>]*?)\s*\/>/g)) {
    const rep = `<${m[1]}${m[2]}></${m[1]}>`;
    out += s.slice(last, m.index) + rep;
    last = m.index! + m[0].length;
    shifts.push({ at: out.length, delta: rep.length - m[0].length });
  }
  out += s.slice(last);
  return { text: out, toOriginal: (o: number) => o - shifts.filter((x) => x.at <= o).reduce((a, x) => a + x.delta, 0) };
}
const isDoc = (s: string) => /<!doctype|<html[\s>]/i.test(s);
function htmlAt(norm: string, id: string): { el: N; top: boolean } | null {
  const tree: N = isDoc(norm) ? parse(norm, { sourceCodeLocationInfo: true }) : parseFragment(norm, { sourceCodeLocationInfo: true });
  let hit: { el: N; top: boolean } | null = null;
  const walk = (n: N) => {
    const l = n.sourceCodeLocation;
    if (!hit && n.tagName && l?.startTag && `${l.startLine}:${l.startCol}` === id) hit = { el: n, top: n.parentNode === tree };
    for (const c of n.childNodes ?? []) if (!hit) walk(c);
  };
  walk(tree);
  return hit;
}
const escAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
function editHtml(text: string, id: string, changes: Change[], ctx: Ctx): Result {
  const { text: norm, toOriginal } = normalizeMapped(text);
  const hit = htmlAt(norm, id);
  if (!hit) return fail(`element ${id} not found`);
  const { el } = hit, loc = el.sourceCodeLocation;
  const name = ctx.tailwind ? "class" : "style";
  const cur: string | undefined = el.attrs.find((a: N) => a.name === name)?.value;
  let next: string;
  if (ctx.tailwind) next = [...strip(cur ?? "", new Set(changes.map((c) => c.prop)), ctx.sizes), ...changes.map((c) => utility(c, ctx.important))].join(" ");
  else {
    try { next = editStyleText(cur ?? "", changes); } catch { return fail("the style attribute could not be parsed"); }
  }
  const at = loc.startTag.attrs?.[name];
  const edit: Edit = at ? { start: toOriginal(at.startOffset), end: toOriginal(at.endOffset), text: `${name}="${escAttr(next)}"` }
    : (() => { // before the closing > (or />) of the start tag, after the last attribute
      let o = loc.startTag.endOffset - 1;
      if (norm[o - 1] === "/") o--;
      while (/\s/.test(norm[o - 1])) o--;
      return { start: toOriginal(o), end: toOriginal(o), text: ` ${name}="${escAttr(next)}"` };
    })();
  return { ok: true, text: applyEdits(text, [edit]) };
}

// ---------- scopes ----------
function context(root: string, important: boolean): Ctx {
  const sizes = sizeTokens(root);
  return { tailwind: readConfig(root).tailwind, important, sizes: new Set([...TAILWIND_SIZE_NAMES, ...sizes.map((s) => s.name)]), fontVars: new Map(sizes.map((s) => [s.name, s.var])) };
}
const read = (root: string, file: string) => {
  if (!/\.(tsx|html)$/.test(file) || !insideProject(root, file)) throw new Error(`cannot edit ${file}`);
  return readFileSync(resolve(root, file), "utf8");
};
const componentName = (file: string) => file.split("/").pop()!.replace(/\.(tsx|html)$/, "");
const posOf = (id: string) => id.split(":").map(Number) as [number, number];
const before = (a: string, b: string) => { const [x, y] = posOf(a), [u, v] = posOf(b); return x < u || (x === u && y < v); };

/** Does the instance tag's class/style reach the picked element? (it must be the component's root and pass className/style through) */
function forwards(root: string, el: Target, tailwind: boolean): string | null {
  const text = read(root, el.file);
  if (el.file.endsWith(".tsx")) {
    const src = sf(text, el.file), node = jsxAt(src, el.id);
    if (!node) return "element not found";
    const name = tailwind ? "className" : "style";
    const spread = node.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a));
    const attr = jsxAttr(node, name)?.initializer?.getText(src) ?? "";
    if (spread || new RegExp(`\\b${name}\\b`).test(attr)) return null;
    return `${componentName(el.file)} doesn't pass ${name} through to this element`;
  }
  const { text: norm } = normalizeMapped(text), hit = htmlAt(norm, el.id);
  if (!hit) return "element not found";
  const name = tailwind ? "class" : "style", own = hit.el.attrs.find((a: N) => a.name === name)?.value ?? "";
  if (own.includes(`{{${name}`) || (hit.top && !text.includes(`{{${name}`))) return null;
  return `only the component's outer element takes a ${name} from the instance`;
}

export type EditInfo = {
  element: { ok: boolean; reason?: string; file: string };
  /** set when the element belongs to a shared component */
  instance: { ok: boolean; reason?: string; file: string; where: string; component: string } | null;
};
export function editInfo(root: string, file: string, id: string, uses: string[] = []): EditInfo {
  const ctx = context(root, false);
  const probe = (t: Target, important: boolean) => plan(root, t, [{ prop: "color", value: "#000" }], { ...ctx, important });
  const el = probe({ file, id }, false);
  const info: EditInfo = { element: { ok: el.ok, reason: el.ok ? undefined : el.reason, file }, instance: null };
  const use = uses[0] ? parseUse(uses[0]) : null;
  if (!use) return info;
  // content passed into a component from the same file (children/slots) is not shared
  if (use.file === file && !before(id, use.id)) {
    const text = read(root, file);
    if (file.endsWith(".tsx")) {
      const src = sf(text, file), tag = jsxAt(src, use.id);
      const elStart = jsxAt(src, id)?.getStart(src) ?? -1, parent = tag && ts.isJsxOpeningElement(tag) ? tag.parent : tag;
      if (parent && elStart > parent.getStart(src) && elStart < parent.end) return info;
    } else return info;
  }
  const reason = forwards(root, { file, id }, ctx.tailwind) ?? (() => { const r = probe(use, true); return r.ok ? null : r.reason; })();
  info.instance = { ok: !reason, reason: reason ?? undefined, file: use.file, where: `${use.file}:${use.id.split(":")[0]}`, component: componentName(file) };
  return info;
}

function plan(root: string, t: Target, changes: Change[], ctx: Ctx): Result {
  let text: string;
  try { text = read(root, t.file); } catch (e) { return fail(String((e as Error).message)); }
  const resolved = changes.filter((c) => PROPS.includes(c.prop)).map((c) => resolveChange(c, ctx));
  return t.file.endsWith(".tsx") ? editTsx(text, t.file, t.id, resolved, ctx) : editHtml(text, t.id, resolved, ctx);
}

export type Applied = { ok: true; file: string; before: string; after: string } | { ok: false; reason: string };
export function applyEdit(root: string, req: { file: string; cdId: string; uses?: string[]; scope?: Scope; changes: Change[] }): Applied {
  if (!req.changes?.length) return { ok: false, reason: "nothing to change" };
  let target: Target = { file: req.file, id: req.cdId }, important = false;
  if (req.scope === "instance") {
    const info = editInfo(root, req.file, req.cdId, req.uses);
    if (!info.instance) return { ok: false, reason: "this element is not inside a component instance" };
    if (!info.instance.ok) return { ok: false, reason: info.instance.reason! };
    target = parseUse(req.uses![0])!;
    important = true; // the instance's classes must beat the component's own ones
  }
  const ctx = context(root, important);
  const r = plan(root, target, req.changes, ctx);
  if (!r.ok) return { ok: false, reason: r.reason! };
  const path = resolve(root, target.file), prev = readFileSync(path, "utf8");
  if (prev !== r.text) writeFileSync(path, r.text!);
  return { ok: true, file: target.file, before: prev, after: r.text! };
}
