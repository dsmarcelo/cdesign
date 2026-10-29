import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { componentIndex, renderPage, snippetFor } from "./render";
import { projectFiles, readConfig } from "./project";
import { errorDocument, renderReact, tailwindCss } from "./react";
import { jsxSnippet, tsxInfo, directComponents } from "./tsx";
import { componentPreview, isReactComponent } from "./previews";

export function insideProject(root: string, file: string): boolean {
  try { const real = realpathSync(resolve(root, file)); return real.startsWith(realpathSync(root) + sep); } catch { return false; }
}
export type RenderAdapter = {
  pages(root: string): string[];
  components(root: string, duplicates?: string[]): Map<string, string>;
  render(root: string, file: string): Promise<string>;
  snippet(source: string, id: string): string;
  diagnostics(root: string): Promise<string[]>;
};
const html: RenderAdapter = {
  pages: root => projectFiles(root).filter(f => f.endsWith(".html") && !f.split("/").pop()!.startsWith("_")),
  components: componentIndex,
  async render(root, file) {
    let content = renderPage(root, file);
    if (readConfig(root).tailwind) content = content.replace(/<\/head>/i, '<link rel="stylesheet" href="/__cd/tailwind.css"></head>');
    return content;
  },
  snippet: snippetFor,
  async diagnostics(root) {
    const errors: string[] = [];
    for (const file of html.pages(root)) try { renderPage(root, file); } catch (e) { errors.push(`${file}: ${e}`); }
    return errors;
  },
};
const react: RenderAdapter = {
  pages: root => projectFiles(root, join(root, "design")).filter(f => f.endsWith(".tsx") && !f.split("/").pop()!.startsWith("_") && (/^design\/(pages|prototype)\//.test(f) || /\/previews\/[^/]+\.preview\.tsx$/.test(f) || isReactComponent(f))),
  components(root, duplicates = []) {
    const index = new Map<string, string>();
    for (const file of projectFiles(root, join(root, "design"))) {
      if (!isReactComponent(file)) continue;
      const name = file.split("/").pop()!.slice(0, -4);
      if (index.has(name)) duplicates.push(name);
      index.set(name, file);
    }
    return index;
  },
  async render(root, file) { return (await renderReact(root, file)).html; },
  snippet: jsxSnippet,
  async diagnostics(root) {
    const errors = projectFiles(root, join(root, "design")).filter(f => f.endsWith(".jsx")).map(f => `${f}: React mode supports TSX only`);
    const checked = new Set<string>();
    for (const file of react.pages(root)) {
      const entry = isReactComponent(file) ? componentPreview(root, file)?.file : file;
      if (!entry || checked.has(entry)) continue;
      checked.add(entry);
      const doc = await react.render(root, file);
      if (doc.includes('<pre id="__cd-error"')) errors.push(`${file}: ${doc.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "build failed"}`);
    }
    return errors;
  },
};
export const adapter = (root: string): RenderAdapter => readConfig(root).mode === "react" ? react : html;
export const listPages = (root: string) => adapter(root).pages(root);
export const components = (root: string, dups?: string[]) => adapter(root).components(root, dups);
export const sourceSnippet = (root: string, file: string, id: string) => insideProject(root, file) ? (file.endsWith(".tsx") ? jsxSnippet : snippetFor)(readFileSync(resolve(root, file), "utf8"), id) : "";
export { tsxInfo, directComponents, tailwindCss, errorDocument };
