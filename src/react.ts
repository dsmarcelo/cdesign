import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { compile } from "@tailwindcss/node";
import { instrument } from "./tsx";
import { projectFiles, readConfig } from "./project";
import { buildTailwind, loadTokens, hasTailwindTokens, tailwindPath } from "./tokens";
import { componentPreview, isReactComponent } from "./previews";
import { previewOf } from "./render";

const runtime = `import React from 'react';
export const Fragment = React.Fragment;
const Usage = React.createContext([]);
function Host({tag, ...props}) {
  const uses = React.useContext(Usage);
  if (uses.length) props['data-cd-uses'] = JSON.stringify(uses);
  return React.createElement(tag, props);
}
function Use({type, source, props}) {
  const parent = React.useContext(Usage);
  const uses = React.useMemo(() => source ? [source, ...parent] : parent, [source, parent]);
  return React.createElement(Usage.Provider, {value: uses}, React.createElement(type, props));
}
export function createElement(type, props, ...children) {
  props = {...props};
  const source = props.__cdSource; delete props.__cdSource;
  if (children.length) props.children = children.length === 1 ? children[0] : children;
  if (typeof type === 'string') return React.createElement(Host, {...props, tag: type});
  if (type === React.Fragment) return React.createElement(type, props);
  return React.createElement(Use, {key: props.key, type, source, props});
}
`;
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function errorDocument(error: unknown): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="__cd-error" style="white-space:pre-wrap;color:#b91c1c;padding:24px">${escape(String(error))}</pre></body></html>`;
}
const themeScript = `<script>try{var t=localStorage.getItem('cd-theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>`;

/** Build Tailwind locally; use complete source tokens (including arbitrary variants), never a CDN runtime. */
export async function tailwindCss(root: string, extraSources: string[] = [], extraCss = ""): Promise<string> {
  const sources = projectFiles(root, join(root, "design")).filter(f => /\.(tsx|ts|html|css)$/.test(f)).map(f => readFileSync(join(root, f), "utf8"));
  const tokens = loadTokens(root);
  const entry = hasTailwindTokens(root) ? readFileSync(tailwindPath(root), "utf8") : null;
  const compiler = await compile((entry ?? `@import "tailwindcss" source(none);\n${tokens ? buildTailwind(tokens) : '@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));'}`) + `\n${extraCss}`, { base: entry !== null ? join(root, "design") : import.meta.dir, customCssResolver: async (id) => id === "tailwindcss" ? Bun.resolveSync("tailwindcss/index.css", import.meta.dir) : undefined, onDependency() {} });
  return compiler.build([...new Set([...sources, ...extraSources].join("\n").split(/[\s"'`<>={}]+/))]);
}

type Bundle = { html: string; assets: Map<string, Blob> };
const cache = new Map<string, Map<string, Promise<Bundle>>>();
export function invalidateReact(root: string) { cache.delete(root); }
export async function reactAsset(root: string, path: string): Promise<Blob | undefined> {
  for (const bundle of cache.get(root)?.values() ?? []) {
    const asset = (await bundle).assets.get(path);
    if (asset) return asset;
  }
}

export function renderReact(root: string, file: string): Promise<Bundle> {
  let pages = cache.get(root);
  if (!pages) cache.set(root, pages = new Map());
  const key = JSON.stringify(readConfig(root)) + ":" + file;
  let result = pages.get(key);
  if (!result) {
    result = buildReact(root, file).catch(error => ({ html: errorDocument(error), assets: new Map() }));
    if (pages.size >= 30) pages.delete(pages.keys().next().value!);
    pages.set(key, result);
  }
  return result;
}

async function buildReact(root: string, file: string): Promise<Bundle> {
  const preview = isReactComponent(file) ? componentPreview(root, file) : { file, inline: false };
  if (!preview) return {
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="__cd-empty"><h1>No component preview yet</h1><p>Add a named <code>Preview</code> export to <code>${escape(file)}</code>, or create <code>${escape(previewOf(file))}</code> with a default export.</p><p>cdesign does not render reusable components without example props.</p></main><script>window.__cdReady=true;</script></body></html>`,
    assets: new Map(),
  };
  const config = readConfig(root), entry = resolve(root, preview.file), sources: string[] = [];
  const id = createHash("sha256").update(root + file + Date.now() + Math.random()).digest("hex").slice(0, 16);
  const prefix = `/__cd/react/${id}/`;
  const styles = existsSync(join(root, "design/styles.css")) ? `import ${JSON.stringify(join(root, "design/styles.css"))};` : "";
  const entrySource = `import React from 'react';
import {createRoot} from 'react-dom/client';
import ${preview.inline ? "{Preview as Page}" : "Page"} from ${JSON.stringify(entry)};
${styles}
class Boundary extends React.Component {
  state = {error: null};
  static getDerivedStateFromError(error) { return {error: String(error)}; }
  componentDidCatch() { window.__cdReady = true; }
  render() { return this.state.error ? React.createElement('pre', {id:'__cd-error', style:{whiteSpace:'pre-wrap',color:'#b91c1c'}}, this.state.error) : this.props.children; }
}
function Ready() { React.useEffect(() => {window.__cdReady = true;}, []); return React.createElement(Page); }
createRoot(document.getElementById('__cd-root')).render(React.createElement(Boundary, null, React.createElement(Ready)));
`;
  const build = await Bun.build({
    entrypoints: ["cdesign:entry"], target: "browser", publicPath: prefix,
    naming: { entry: "page.[ext]", asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "cdesign-react", setup(builder) {
      builder.onResolve({ filter: /^cdesign:/ }, args => ({ path: args.path, namespace: "cdesign" }));
      builder.onLoad({ filter: /.*/, namespace: "cdesign" }, args => ({ contents: args.path === "cdesign:entry" ? entrySource : runtime, loader: "js", resolveDir: root }));
      // Use cdesign's React consistently, including imports originating in the host project.
      builder.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => ({ path: Bun.resolveSync(args.path, import.meta.dir) }));
      builder.onLoad({ filter: /\.jsx$/ }, args => { throw new Error(`JSX files are not supported: ${args.path}. Use TSX.`); });
      builder.onLoad({ filter: /\.tsx$/ }, async args => {
        if (args.path.includes(`${sep}node_modules${sep}`)) return;
        const source = await Bun.file(args.path).text(); sources.push(source);
        return { contents: instrument(source, relative(root, args.path).split(sep).join("/")), loader: "js", resolveDir: dirname(args.path) };
      });
    } }],
  });
  if (!build.success) throw new Error(build.logs.map(l => l.message).join("\n"));
  const assets = new Map<string, Blob>();
  for (const output of build.outputs) assets.set(prefix + output.path.split(/[\\/]/).pop(), output);
  let css = [...assets.keys()].filter(p => p.endsWith(".css")).map(p => `<link rel="stylesheet" href="${p}">`).join("");
  if (config.tailwind) {
    const bundledCss = await Promise.all([...assets].filter(([p]) => p.endsWith(".css")).map(([, b]) => b.text()));
    assets.set(prefix + "tailwind.css", new Blob([await tailwindCss(root, sources, bundledCss.join("\n"))], { type: "text/css" }));
    css = `<link rel="stylesheet" href="${prefix}tailwind.css">`;
  }
  const tokens = !config.tailwind && existsSync(join(root, "design/tokens.css")) ? '<link rel="stylesheet" href="/design/tokens.css">' : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${themeScript}${tokens}${css}</head><body><div id="__cd-root"></div><script>window.__cdReady=false;function cdError(e){var p=document.getElementById('__cd-error')||document.createElement('pre');p.id='__cd-error';p.style.cssText='white-space:pre-wrap;color:#b91c1c;padding:24px';p.textContent=String(e);document.body.appendChild(p);window.__cdReady=true}window.addEventListener('error',e=>cdError(e.error||e.message));window.addEventListener('unhandledrejection',e=>cdError(e.reason));</script><script type="module" src="${prefix}page.js" onerror="cdError('Failed to load React preview')"></script></body></html>`;
  return { html, assets };
}
