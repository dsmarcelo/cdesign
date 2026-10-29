import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configure, readConfig } from "../src/project";
import { adapter, components, listPages, sourceSnippet } from "../src/modes";
import { context } from "../src/context";
import { invalidateReact, renderReact } from "../src/react";

const roots: string[] = [];
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cdesign-react-")); roots.push(root);
  const put = (file: string, body: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), body); invalidateReact(root); };
  return { root, put };
}
afterEach(() => { for (const root of roots.splice(0)) { invalidateReact(root); rmSync(root, { recursive: true, force: true }); } });
const cli = join(import.meta.dir, "../src/cli.ts");
const run = (root: string, ...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });

test("new setup defaults to React and Tailwind, reuses settings, and preserves legacy HTML", () => {
  const {root} = fixture();
  expect(run(root, "init").exitCode).toBe(0);
  expect(readConfig(root)).toEqual({version: 1, mode: "react", tailwind: true});
  expect(readFileSync(join(root, "design/design-system.md"), "utf8")).toContain("TSX only");
  expect(run(root, "init", "--no-tailwind").exitCode).toBe(0);
  expect(readConfig(root).tailwind).toBe(false);
  run(root, "init"); expect(readConfig(root).tailwind).toBe(false);
  expect(run(root, "init", "--mode", "jsx").exitCode).not.toBe(0);
  const legacy = fixture(); legacy.put("design/pages/home.html", "<h1>Legacy</h1>");
  run(legacy.root, "init"); expect(readConfig(legacy.root).mode).toBe("html");
  const explicit = fixture(); run(explicit.root, "init", "--mode", "html", "--no-tailwind");
  expect(readConfig(explicit.root)).toEqual({version: 1, mode: "html", tailwind: false});
});

test("React discovers explicit entries only, with contracts, imports and JSX snippets", () => {
  const {root, put} = fixture(); configure(root);
  put("design/design-system.md", "# Example");
  const source = '/** Purpose: Button. States: idle and pressed. */\nexport interface ButtonProps { label?: string }\nexport default function Button({label = "Save"}: ButtonProps) { return <button>{label}</button>; }';
  put("design/components/ui/Button.tsx", source);
  put("design/components/ui/previews/Button.preview.tsx", 'import Button from "../Button"; export default function Preview(){return <Button/>}');
  put("design/pages/Home.tsx", 'import Button from "../components/ui/Button"; export default function Home(){return <Button/>}');
  put("design/pages/Ignore.jsx", "export default () => <div/>");
  expect(listPages(root)).toEqual(["design/components/ui/previews/Button.preview.tsx", "design/pages/Home.tsx"]);
  expect(components(root).get("Button")).toBe("design/components/ui/Button.tsx");
  expect(context(root, "get", "component/Button")).toContain('label = "Save"');
  expect(context(root, "get", "component/Button")).toContain("ButtonProps");
  expect(context(root, "for", "design/pages/Home.tsx")).toContain("Dependency: component/Button");
  const column = source.split("\n")[2].indexOf("<button>") + 1;
  expect(sourceSnippet(root, "design/components/ui/Button.tsx", `3:${column}`)).toBe("<button>{label}</button>");
});

test("bundles hooks, assets and CSS without host dependencies; rebuilds imports; reports and recovers from errors", async () => {
  const {root, put} = fixture(); configure(root, {tailwind: false});
  put("design/components/ui/Label.tsx", 'export default function Label(){return <strong>First</strong>}');
  put("design/pages/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put("design/pages/home.css", ".sample { color: rgb(1, 2, 3); }");
  put("design/pages/Home.tsx", 'import {useState} from "react"; import Label from "../components/ui/Label"; import "./home.css"; import icon from "./icon.svg"; export default function Home(){ const [n,setN]=useState(0);return <main><Label/><img src={icon}/><button onClick={()=>setN(n+1)}>{n}</button></main>}');
  let bundle = await renderReact(root, "design/pages/Home.tsx");
  expect(bundle.html).not.toContain('<pre id="__cd-error"');
  const js = await [...bundle.assets.values()].find(b => /javascript/.test(b.type))!.text();
  expect(js).toContain("First"); expect(js).toContain("data-cd-file");
  expect([...bundle.assets.keys()].some(p => p.endsWith(".svg"))).toBe(true);
  expect([...bundle.assets.keys()].some(p => p.endsWith(".css"))).toBe(true);
  put("design/components/ui/Label.tsx", 'export default function Label(){return <strong>Second</strong>}');
  bundle = await renderReact(root, "design/pages/Home.tsx");
  expect(await [...bundle.assets.values()].find(b => /javascript/.test(b.type))!.text()).toContain("Second");
  put("design/pages/Home.tsx", 'import Missing from "./Missing"; export default Missing;');
  expect(await adapter(root).diagnostics(root)).not.toEqual([]);
  expect((await renderReact(root, "design/pages/Home.tsx")).html).toContain('__cd-error');
  put("design/pages/Home.tsx", 'export default function Home(){return <h1>Recovered</h1>}');
  expect(await adapter(root).diagnostics(root)).toEqual([]);
});

test("Tailwind compiles utilities, variants and exported semantic tokens locally", async () => {
  const {root, put} = fixture(); run(root, "init");
  const token = run(root, "tokens", "set", "color/brand", "--light", "#123456", "--dark", "#abcdef", "--usage", "Brand color");
  expect(token.exitCode).toBe(0);
  put("design/styles.css", ".custom { @apply p-4; }");
  put("design/pages/Home.tsx", 'export default function Home(){return <main className="p-4 bg-brand dark:p-8 hover:opacity-50 custom">Hello</main>}');
  const bundle = await renderReact(root, "design/pages/Home.tsx");
  expect(bundle.html).not.toContain('<pre id="__cd-error"');
  const css = await [...bundle.assets].find(([key]) => key.endsWith("tailwind.css"))![1].text();
  expect(css).toContain(".p-4"); expect(css).toContain("--color-brand"); expect(css).toContain(".bg-brand"); expect(css).toContain("hover"); expect(css).not.toContain("@apply");
  const checked = run(root, "check"); expect(checked.stdout.toString()).not.toContain("ERROR"); expect(checked.exitCode).toBe(0);
});

test("checks reject JSX and malformed TSX, retain inactive originals, and repair misplaced TSX previews", async () => {
  const {root, put} = fixture(); run(root, "init", "--no-tailwind");
  put("design/components/ui/Badge.tsx", '/** Purpose: Badge. */ export default function Badge(){return <span>Ready</span>}');
  put("design/components/ui/Badge.preview.tsx", 'import Badge from "./Badge"; export default function Preview(){return <Badge/>}');
  const fixed = run(root, "check", "--fix");
  expect(fixed.stdout.toString()).toContain("moved");
  expect(fixed.exitCode).toBe(0);
  expect(readFileSync(join(root, "design/components/ui/previews/Badge.preview.tsx"), "utf8")).toContain('"../Badge"');
  put("design/components/ui/previews/Badge.preview.tsx", 'import Badge from "../Badge"; export default function Preview(){return <Badge/>}');
  put("design/pages/Original.html", '<c-missing></c-missing>');
  expect(run(root, "check").exitCode).toBe(0);
  put("design/pages/Bad.jsx", "export default () => <div/>");
  expect(await adapter(root).diagnostics(root)).toContain("design/pages/Bad.jsx: React mode supports TSX only");
  put("design/pages/Bad.tsx", "export default function Page(){return <div>}");
  expect((await renderReact(root, "design/pages/Bad.tsx")).html).toContain('<pre id="__cd-error"');
  const before = readFileSync(join(root, "design/pages/Original.html"), "utf8");
  configure(root, {mode: "html"});
  expect(readFileSync(join(root, "design/pages/Original.html"), "utf8")).toBe(before);
  expect(listPages(root)).toContain("design/pages/Original.html");
  expect(listPages(root)).not.toContain("design/pages/Bad.tsx");
});
