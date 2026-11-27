import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import { parse, serialize } from "parse5";
import { projectFiles, readConfig, configPath } from "./project";
import { buildReact, tailwindCss } from "./react";
import { renderPage } from "./render";
import { ensureDataDir } from "./store";

export type WebsiteOptions = { name: string; start: string; pages?: string[]; locked?: boolean };
export type WebsiteManifest = WebsiteOptions & { routes: Record<string, string>; builtAt: string };
const forbidden = (file: string) => file.split(/[\\/]/).some(p => p.startsWith(".") || ["prototype", "prototypes", "previews", "node_modules"].includes(p));
export function websiteName(value: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error("Website name must use 1–63 lowercase letters, numbers or hyphens");
  return value;
}
export function websitePages(root: string) {
  return projectFiles(root, join(root, "design/pages")).filter(f => /\.(html|tsx)$/.test(f) && !forbidden(f) && !basename(f).startsWith("_") && !f.includes(".preview."));
}
export function websiteDefaults(root: string) {
  const pages = websitePages(root), saved = readConfig(root).website;
  return { pages, name: saved?.name ?? (basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "website"), start: saved?.start ?? pages[0], selected: saved?.pages ?? pages };
}
export function saveWebsite(root: string, options: WebsiteOptions) {
  writeFileSync(configPath(root), JSON.stringify({ ...readConfig(root), website: options }, null, 2) + "\n");
}
const safeJSON = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** Production-only compatibility for existing /p/<source> navigation. No viewer is needed. */
export function navigationRuntime(manifest: WebsiteManifest, file: string) {
  const storage = `for(const storage of [sessionStorage,localStorage]){const proto=Storage.prototype;const prefix='cdesign:${manifest.name}:';for(const method of ['getItem','setItem','removeItem'])Object.defineProperty(storage,method,{value:(key,...args)=>proto[method].call(storage,prefix+key,...args)});}`;
  // Locked (shared single screen): nothing may navigate away. Only in-page hash links work.
  if (manifest.locked) return `(()=>{window.__cdesign={pathname:'/p/'+${safeJSON(file)},url:()=>location.href,navigate:()=>{}};
${storage}
document.addEventListener('click',e=>{const a=e.target.closest?.('a[href],area[href]');if(a&&!(a.getAttribute('href')||'').startsWith('#'))e.preventDefault();},true);
document.addEventListener('submit',e=>e.preventDefault(),true);
window.open=()=>null;
})();`;
  return `(()=>{const routes=${safeJSON(manifest.routes)},base=${safeJSON('/' + manifest.name + '/')},file=${safeJSON(file)};
const url=value=>{const u=new URL(value,location.href);if(u.origin!==location.origin)return u.href;
const key=decodeURIComponent(u.pathname).replace(/^\\/p\\//,'').replace(/^\\//,'');
if(routes[key])return routes[key]+u.search+u.hash;
if(u.pathname.startsWith('/p/')||key.startsWith('design/pages/'))throw Error('Page is not included in this website: '+key);
if(u.pathname.startsWith(base))return u.href;
return new URL(base+u.pathname.replace(/^\\//,''),location.origin).href;};
window.__cdesign={pathname:'/p/'+file,url,navigate:(value,replace=false)=>replace?location.replace(url(value)):location.assign(url(value))};
${storage}
document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(!a||a.target||a.hasAttribute('download')||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||e.button)return;const raw=a.getAttribute('href');if(!raw||raw.startsWith('#')||/^(mailto:|tel:|javascript:)/i.test(raw))return;const dest=url(raw);if(dest!==a.href){e.preventDefault();location.assign(dest);}});
})();`;
}

/** Rewrite location operations structurally, preserving dynamic expressions and string contents. */
export function exportSource(source: string, file: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const locationObject = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === "location" || ts.isPropertyAccessExpression(n) && ["window", "document", "globalThis"].includes(n.expression.getText(ast)) && n.name.text === "location";
  const member = (n: ts.Node, key: string) => ts.isPropertyAccessExpression(n) && locationObject(n.expression) && n.name.text === key;
  const runtime = (key: string) => ts.factory.createPropertyAccessExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("window"), "__cdesign"), key);
  const transformed = ts.transform(ast, [ctx => node => {
    const visit: ts.Visitor = n => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (member(n.left, "href") || locationObject(n.left))) return ts.factory.createCallExpression(runtime("navigate"), undefined, [ts.visitNode(n.right, visit) as ts.Expression]);
      if (ts.isCallExpression(n) && (member(n.expression, "assign") || member(n.expression, "replace"))) return ts.factory.createCallExpression(runtime("navigate"), undefined, [...n.arguments.map(a => ts.visitNode(a, visit) as ts.Expression), member(n.expression, "replace") ? ts.factory.createTrue() : ts.factory.createFalse()]);
      if (member(n, "pathname")) return runtime("pathname");
      return ts.visitEachChild(n, visit, ctx);
    };
    return ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  try { return ts.createPrinter().printFile(transformed.transformed[0] as ts.SourceFile); } finally { transformed.dispose(); }
}

export async function exportWebsite(root: string, options: WebsiteOptions, destination?: string) {
  root = realpathSync(root); websiteName(options.name);
  const available = websitePages(root), pages = options.pages ?? available;
  if (!pages.length || new Set(pages).size !== pages.length || pages.some(p => !available.includes(p))) throw new Error("Select existing pages from design/pages (without duplicates)");
  if (!pages.includes(options.start)) throw new Error("Starting page must be one of the selected pages");
  const routes: Record<string, string> = {}, seen = new Set<string>();
  for (const file of pages) {
    const slug = file.slice("design/pages/".length).replace(/\.(tsx|html)$/, "");
    if (!slug.split('/').every(p => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(p))) throw new Error(`Unsupported page route: ${file}`);
    const route = `/${options.name}/${slug}/`;
    if (seen.has(route.toLowerCase())) throw new Error(`Duplicate website route: ${slug}`);
    seen.add(route.toLowerCase()); routes[file] = route;
  }
  const manifest: WebsiteManifest = { ...options, pages, routes, builtAt: new Date().toISOString() };
  ensureDataDir(root);
  const target = resolve(destination ?? join(root, ".cdesign/export"));
  // Never allow export to overwrite source directories or ancestors.
  if (target === root || root.startsWith(target + sep) || !relative(root, target).startsWith("..") && !target.startsWith(join(root, ".cdesign") + sep)) throw new Error("Output must be outside the project or inside .cdesign");
  if (existsSync(target) && (!existsSync(join(target, "website.json")) || realpathSync(target) !== target)) throw new Error("Output directory already exists and is not a cdesign export");
  const staging = target + ".tmp-" + randomUUID();
  const put = async (url: string, body: string | Blob) => { const out = join(staging, url.replace(/^\//, "")); mkdirSync(dirname(out), {recursive: true}); await Bun.write(out, body); };
  const validate = (path: string) => {
    const rel = relative(root, realpathSync(path));
    if (rel.startsWith("..") && !path.includes(`${sep}node_modules${sep}`)) throw new Error(`Export dependency is outside the project: ${path}`);
    if (rel.split(sep).some(p => ["prototype", "prototypes", "previews", ".cdesign"].includes(p))) throw new Error(`Excluded export dependency: ${rel}`);
  };
  const copied = new Map<string, string>();
  const asset = async (value: string, from: string): Promise<string> => {
    if (!value || /^(?:[a-z]+:|\/\/|#|\?)/i.test(value)) return value;
    if (value === "/") return `/${options.name}/`;
    if (value.startsWith(`/${options.name}/`)) return value;
    const split = value.search(/[?#]/), path = split < 0 ? value : value.slice(0,split), suffix = split < 0 ? "" : value.slice(split);
    const key = path.replace(/^\/p\//, "").replace(/^\//, "");
    const page = routes[key] ? key : relative(root, resolve(root, dirname(from), path)).split(sep).join("/");
    if (routes[page]) return routes[page] + suffix;
    if (/\.(html|tsx)$/.test(path)) { if (options.locked) return "#"; throw new Error(`Link references an unselected page: ${value} in ${from}`); }
    const abs = path.startsWith("/") ? resolve(root, key) : resolve(root, dirname(from), path);
    if (!existsSync(abs)) throw new Error(`Missing export asset: ${value} in ${from}`);
    const real = realpathSync(abs), rel = relative(root, real).split(sep).join("/");
    if (!real.startsWith(root + sep) || forbidden(rel) || !/\.(css|js|mjs|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)$/i.test(real)) throw new Error(`Unsupported or excluded export asset: ${rel}`);
    if (copied.has(real)) return copied.get(real)! + suffix;
    const url = `/${options.name}/assets/${createHash('sha256').update(rel).digest('hex').slice(0,12)}${extname(real)}`; copied.set(real, url);
    let content: string | Blob = Bun.file(real);
    if (real.endsWith(".css")) content = await cssAssets(readFileSync(real, "utf8"), rel);
    if (/\.[cm]?js$/.test(real)) content = await scriptAssets(readFileSync(real, "utf8"), rel);
    await put(url, content); return url + suffix;
  };
  const scriptAssets = async (source: string, from: string) => {
    const ast = ts.createSourceFile(from,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const edits: {start:number;end:number;value:string}[] = [];
    const visit = async (node: ts.Node): Promise<void> => {
      let literal: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal=node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind===ts.SyntaxKind.ImportKeyword) literal=node.arguments[0];
      if (literal && ts.isStringLiteral(literal)) edits.push({start:literal.getStart(ast),end:literal.end,value:JSON.stringify(await asset(literal.text,from))});
      const children:ts.Node[]=[];node.forEachChild(c=>{children.push(c);});for(const child of children)await visit(child);
    };
    await visit(ast);
    for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.value+source.slice(edit.end);
    return exportSource(source,from);
  };
  const cssAssets = async (css: string, from: string) => {
    const matches = [...css.matchAll(/url\(\s*['"]?([^'"()\s]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g)];
    for (const m of matches.reverse()) { const value = m[1] ?? m[2]; const dest = await asset(value, from); css = css.slice(0,m.index) + m[0].replace(value,dest) + css.slice(m.index!+m[0].length); }
    return css;
  };
  try {
    for (const file of pages) {
      let html: string;
      if (file.endsWith(".tsx")) {
        const prefix = `/${options.name}/assets/${createHash('sha256').update(file).digest('hex').slice(0,12)}/`;
        const transform = async (source: string, sourceFile: string) => {
          const ast = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, sourceFile.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
          const edits: {start:number;end:number;value:string}[] = [];
          const visit = async (n: ts.Node): Promise<void> => {
            if (ts.isJsxAttribute(n) && ['src','href','poster'].includes(n.name.getText(ast)) && n.initializer) {
              const value = ts.isStringLiteral(n.initializer) ? n.initializer : ts.isJsxExpression(n.initializer) && n.initializer.expression && ts.isStringLiteral(n.initializer.expression) ? n.initializer.expression : undefined;
              if (value) edits.push({start:value.getStart(ast),end:value.end,value:JSON.stringify(await asset(value.text,sourceFile))});
            }
            const children: ts.Node[] = []; n.forEachChild(c=>{children.push(c);});
            for (const c of children) await visit(c);
          };
          await visit(ast);
          for (const e of edits.sort((a,b)=>b.start-a.start)) source=source.slice(0,e.start)+e.value+source.slice(e.end);
          return exportSource(source,sourceFile);
        };
        const bundle = await buildReact(root, file, {prefix, transform, validate}); html = bundle.html;
        for (const [url, blob] of bundle.assets) await put(url, url.endsWith('.css') ? await cssAssets(await blob.text(), file) : blob);
      } else {
        html = renderPage(root, file, true);
        if (/<div[^>]*style="padding:8px;border:1px dashed #dc2626[^>]*>(Missing component:|Component cycle:)/.test(html)) throw new Error(`Cannot export ${file}: missing or cyclic HTML component`);
        if (readConfig(root).tailwind) {
          const url = `/${options.name}/assets/tailwind.css`; await put(url, await cssAssets(await tailwindCss(root, [], "", true), "design/tailwind.css"));
          html = html.replace('</head>', `<link rel="stylesheet" href="${url}"></head>`);
        }
      }
      const doc: any = parse(html);
      const walk = async (n: any): Promise<void> => {
        const source = n.attrs?.find((a: any) => a.name === 'data-cd-file')?.value ?? file;
        if (forbidden(source)) throw new Error(`Excluded export dependency: ${source}`);
        for (const a of n.attrs ?? []) {
          if (["src", "href", "poster"].includes(a.name) && !a.value.startsWith(`/${options.name}/assets/`)) a.value = await asset(a.value, source);
          if (a.name === "srcset" && !a.value.includes('data:')) a.value = (await Promise.all(a.value.split(',').map(async (part: string) => { const [url,...descriptor]=part.trim().split(/\s+/); return [await asset(url,source),...descriptor].join(' '); }))).join(', ');
          if (a.name === "style") a.value = await cssAssets(a.value, source);
          if (a.name.startsWith('on')) a.value = exportSource(a.value, 'handler.js');
        }
        if (n.tagName === 'script' && !n.attrs?.some((a: any) => a.name === 'src' || a.name === 'type' && !['module','text/javascript'].includes(a.value))) for (const c of n.childNodes ?? []) if (c.nodeName === '#text') c.value = await scriptAssets(c.value, source);
        if (n.tagName === 'style') for (const c of n.childNodes ?? []) if (c.nodeName === '#text') c.value = await cssAssets(c.value, source);
        if (n.attrs) n.attrs = n.attrs.filter((a: any) => !a.name.startsWith('data-cd-'));
        for (const c of n.childNodes ?? []) await walk(c);
      };
      await walk(doc);
      html = serialize(doc).replace('<head>', `<head>${options.locked ? '<meta name="robots" content="noindex,nofollow">' : ''}<script>${navigationRuntime(manifest, file)}</script>`);
      await put(routes[file] + 'index.html', html);
      if (file === options.start) await put(`/${options.name}/index.html`, html);
    }
    await put('/website.json', JSON.stringify(manifest, null, 2));
    const backup = target + '.previous-' + randomUUID();
    if (existsSync(target)) renameSync(target, backup);
    try { mkdirSync(dirname(target), {recursive:true}); renameSync(staging, target); } catch (e) { if (existsSync(backup)) renameSync(backup,target); throw e; }
    rmSync(backup, {recursive:true,force:true});
    return { directory: target, manifest };
  } catch (e) { rmSync(staging, {recursive:true,force:true}); throw e; }
}

export function previewWebsite(directory: string, port = 0) {
  const root = realpathSync(directory);
  return Bun.serve({hostname:'127.0.0.1', port, async fetch(req) {
    const url = new URL(req.url), path = decodeURIComponent(url.pathname), file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) return new Response('Not found', {status:404});
    let target = file;
    if (!extname(path)) {
      if (!path.endsWith('/')) return Response.redirect(new URL(path+'/' + url.search, url), 308);
      target = join(file, 'index.html');
    }
    if (!existsSync(target) || !realpathSync(target).startsWith(root + sep) || target === join(root,'website.json')) return new Response('Not found',{status:404});
    return new Response(Bun.file(target));
  }});
}
