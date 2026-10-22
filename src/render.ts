import { parse, parseFragment, serialize } from "parse5";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

type N = any;
const SKIP = new Set(["node_modules", ".git", ".cdesign", "dist", ".next", ".astro", "build"]);
const isDoc = (s: string) => /<!doctype|<html[\s>]/i.test(s);
const attr = (n: N, name: string): string | undefined => n.attrs?.find((a: N) => a.name === name)?.value;
const setAttr = (n: N, name: string, value: string) => n.attrs.push({ name, value });

/** `<c-x />` is not valid HTML (the parser ignores the slash); turn it into `<c-x></c-x>`. */
export const normalize = (s: string) => s.replace(/<(c-[\w-]+)([^<>]*?)\s*\/>/g, "<$1$2></$1>");

function walk(n: N, fn: (n: N) => void) {
  fn(n);
  for (const c of n.childNodes ?? []) walk(c, fn);
}

/** component name -> project-relative path, for every .html under a `components/` folder */
export function componentIndex(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const scan = (dir: string, inside: boolean) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) scan(p, inside || name === "components");
      else if (inside && name.endsWith(".html") && !name.startsWith("_"))
        out.set(name.slice(0, -5), p.slice(root.length + 1).split(sep).join("/"));
    }
  };
  scan(root, false);
  return out;
}

/** every element gets data-cd-id="line:col" (its start tag in its own file) and data-cd-file */
function mark(tree: N, file: string) {
  walk(tree, (el) => {
    const loc = el.sourceCodeLocation;
    if (!el.tagName || !loc?.startTag) return;
    setAttr(el, "data-cd-id", `${loc.startLine}:${loc.startCol}`);
    setAttr(el, "data-cd-file", file);
  });
}

function subst(n: N, props: Record<string, string>) {
  const re = /\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g;
  const f = (s: string) => s.replace(re, (_, k, d) => props[k] ?? d ?? "");
  if (n.nodeName === "#text") n.value = f(n.value);
  for (const a of n.attrs ?? []) a.value = f(a.value);
  for (const c of n.childNodes ?? []) subst(c, props);
}

function fillSlots(frag: N, given: N[]) {
  const named = (n: N) => attr(n, "slot");
  const fill = (parent: N) => {
    const kids: N[] = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.tagName === "slot") {
        const want = attr(k, "name");
        const content = given.filter((g) => (want ? named(g) === want : !named(g)));
        const repl = content.length ? content : k.childNodes; // fallback content
        kids.splice(i, 1, ...repl);
        repl.forEach((r: N) => (r.parentNode = parent));
        i += repl.length - 1;
      } else if (k.childNodes) fill(k);
    }
  };
  fill(frag);
}

const placeholder = (msg: string) =>
  parseFragment(`<div style="padding:8px;border:1px dashed #dc2626;color:#dc2626;font:12px monospace">${msg}</div>`).childNodes;

type Styles = Map<string, N[]>; // component path -> its <style> nodes, hoisted into <head> once

function expand(parent: N, root: string, idx: Map<string, string>, stack: string[], styles: Styles) {
  const kids: N[] = parent.childNodes;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k.tagName) continue;
    expand(k, root, idx, stack, styles); // slot content first, so it keeps its own file ids
    if (!k.tagName.startsWith("c-")) continue;
    const name = k.tagName.slice(2);
    const rel = idx.get(name);
    let repl: N[];
    if (!rel) repl = placeholder(`Missing component: ${name}`);
    else if (stack.includes(rel)) repl = placeholder(`Component cycle: ${name}`);
    else {
      const src = normalize(readFileSync(join(root, rel), "utf8"));
      const frag = parseFragment(src, { sourceCodeLocationInfo: true }) as N;
      mark(frag, rel);
      const own = frag.childNodes.filter((n: N) => n.tagName === "style");
      frag.childNodes = frag.childNodes.filter((n: N) => n.tagName !== "style");
      if (!styles.has(rel)) styles.set(rel, own);
      const props: Record<string, string> = {};
      for (const a of k.attrs) if (!a.name.startsWith("data-cd-")) props[a.name] = a.value;
      subst(frag, props);
      expand(frag, root, idx, [...stack, rel], styles);
      fillSlots(frag, k.childNodes);
      const use = `${attr(k, "data-cd-file")}:${attr(k, "data-cd-id")}`;
      for (const n of frag.childNodes) {
        if (!n.tagName) continue;
        setAttr(n, "data-cd-use", use);
        if (props.class && !src.includes("{{class")) {
          const cls = n.attrs.find((a: N) => a.name === "class");
          if (cls) cls.value += " " + props.class;
          else setAttr(n, "class", props.class);
        }
      }
      repl = frag.childNodes;
    }
    kids.splice(i, 1, ...repl);
    repl.forEach((r: N) => (r.parentNode = parent));
    i += repl.length - 1;
  }
}

const headPartial = (root: string) => {
  for (const p of ["design/_head.html", "design/prototypes/_head.html"]) {
    const f = join(root, p);
    if (existsSync(f)) return readFileSync(f, "utf8");
  }
};

/** Fully rendered page: components expanded, ids stamped, shared head injected. */
export function renderPage(root: string, rel: string): string {
  const idx = componentIndex(root);
  const styles: Styles = new Map();
  const src = normalize(readFileSync(join(root, rel), "utf8"));
  const opts = { sourceCodeLocationInfo: true };
  let doc: N;
  if (isDoc(src)) {
    doc = parse(src, opts);
    mark(doc, rel);
    expand(doc, root, idx, [rel], styles);
  } else {
    // fragment file (a component opened on its own): wrap it in a document
    const frag = parseFragment(src, opts) as N;
    mark(frag, rel);
    if ([...idx.values()].includes(rel)) {
      subst(frag, {});
      fillSlots(frag, []);
    }
    expand(frag, root, idx, [rel], styles);
    doc = parse("<!doctype html><html><head></head><body></body></html>");
    let body: N;
    walk(doc, (n) => n.tagName === "body" && (body = n));
    body.childNodes = frag.childNodes;
    body.childNodes.forEach((c: N) => (c.parentNode = body));
  }
  // shared head partial first, then each used component's <style> once, then the page's own head
  const pre: N[] = [];
  const head = headPartial(root);
  if (head) pre.push(...(parseFragment(head).childNodes as N[]));
  for (const nodes of styles.values()) pre.push(...nodes);
  if (pre.length) {
    let h: N;
    walk(doc, (n) => n.tagName === "head" && !h && (h = n));
    if (h) {
      pre.forEach((n) => (n.parentNode = h));
      h.childNodes.unshift(...pre);
    }
  }
  return serialize(doc);
}

/** source text of the element starting at `id` ("line:col") in `file` */
export function snippetFor(src: string, id: string, max = 600): string {
  const s = normalize(src);
  const tree = (isDoc(s) ? parse(s, { sourceCodeLocationInfo: true }) : parseFragment(s, { sourceCodeLocationInfo: true })) as N;
  let out = "";
  walk(tree, (el) => {
    const l = el.sourceCodeLocation;
    if (!out && el.tagName && l?.startTag && `${l.startLine}:${l.startCol}` === id) out = s.slice(l.startOffset, l.endOffset);
  });
  return out.length > max ? out.slice(0, max) + "…" : out;
}
