import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdit, classGroup, editInfo } from "../src/edit";

function project(mode: "react" | "html", tailwind: boolean, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cdesign-edit-"));
  const put = (f: string, b: string) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), b); };
  put("design/cdesign.json", JSON.stringify({ version: 1, mode, tailwind }));
  for (const [f, b] of Object.entries(files)) put(f, b);
  return { root, read: (f: string) => readFileSync(join(root, f), "utf8") };
}

test("classGroup tells colors from sizes, alignment, widths and variants", () => {
  const sizes = new Set(["sm", "lg", "body"]);
  expect(classGroup("text-red-500", sizes)).toBe("color");
  expect(classGroup("text-sm", sizes)).toBe("font-size");
  expect(classGroup("text-body", sizes)).toBe("font-size");
  expect(classGroup("text-[18px]", sizes)).toBe("font-size");
  expect(classGroup("text-[#fff]", sizes)).toBe("color");
  expect(classGroup("text-center", sizes)).toBe(null);
  expect(classGroup("bg-cover", sizes)).toBe(null);
  expect(classGroup("bg-primary/50", sizes)).toBe("background-color");
  expect(classGroup("border", sizes)).toBe(null);
  expect(classGroup("border-2", sizes)).toBe(null);
  expect(classGroup("border-t-red-500", sizes)).toBe(null);
  expect(classGroup("border-zinc-200", sizes)).toBe("border-color");
  expect(classGroup("font-semibold", sizes)).toBe("font-weight");
  expect(classGroup("font-sans", sizes)).toBe(null);
  expect(classGroup("hover:bg-red-500", sizes)).toBe(null);
});

test("React + Tailwind: replaces classes in literals, cn() calls and templates, or adds className", () => {
  const page = [
    'export default function Home({on}:{on:boolean}){return <main>',
    '<button className="px-4 bg-red-500 text-white hover:bg-red-600 font-medium text-sm">A</button>',
    '<p className={cn("p-2 text-zinc-500", on && "underline")}>B</p>',
    '<span className={`px-1 text-lg ${on ? "a" : "b"}`}>C</span>',
    '<b>D</b>',
    '<i className={cn("p-1", on && "bg-blue-500")}>E</i>',
    '</main>}',
  ].join("\n");
  const { root, read } = project("react", true, { "design/pages/Home.tsx": page });
  const f = "design/pages/Home.tsx";
  expect(applyEdit(root, { file: f, cdId: "2:1", changes: [{ prop: "background-color", token: "primary", value: "#00f" }, { prop: "font-weight", value: "700" }, { prop: "font-size", token: "lg", value: "1.125rem" }] }).ok).toBe(true);
  expect(read(f).split("\n")[1]).toBe('<button className="px-4 text-white hover:bg-red-600 bg-primary font-bold text-lg">A</button>');
  expect(applyEdit(root, { file: f, cdId: "3:1", changes: [{ prop: "color", value: "#123456" }] }).ok).toBe(true);
  expect(read(f).split("\n")[2]).toBe('<p className={cn("p-2 text-[#123456]", on && "underline")}>B</p>');
  expect(applyEdit(root, { file: f, cdId: "4:1", changes: [{ prop: "font-size", value: "22px" }] }).ok).toBe(true);
  expect(read(f).split("\n")[3]).toBe('<span className={`px-1 text-[22px] ${on ? "a" : "b"}`}>C</span>');
  expect(applyEdit(root, { file: f, cdId: "5:1", changes: [{ prop: "color", token: "ink", value: "#111" }] }).ok).toBe(true);
  expect(read(f).split("\n")[4]).toBe('<b className="text-ink">D</b>');
  const r = applyEdit(root, { file: f, cdId: "6:1", changes: [{ prop: "background-color", token: "ink", value: "#111" }] });
  expect(r.ok).toBe(false);
});

test("React without Tailwind edits the style object", () => {
  const { root, read } = project("react", false, { "design/pages/Home.tsx": 'export default function Home(){return <main>\n<h1 style={{ padding: 8, color: "red" }}>A</h1>\n<h2>B</h2>\n</main>}' });
  const f = "design/pages/Home.tsx";
  applyEdit(root, { file: f, cdId: "2:1", changes: [{ prop: "color", token: "ink", value: "#111" }, { prop: "font-weight", value: "600" }] });
  expect(read(f).split("\n")[1]).toBe('<h1 style={{ padding: 8, color: "var(--color-ink)", fontWeight: "600" }}>A</h1>');
  applyEdit(root, { file: f, cdId: "3:1", changes: [{ prop: "font-size", value: "20px" }] });
  expect(read(f).split("\n")[2]).toBe('<h2 style={{ fontSize: "20px" }}>B</h2>');
});

test("shared React components: edit every instance or only one (when className is forwarded)", () => {
  const button = 'export default function Button({className=""}:{className?:string}){return <button className={`px-4 bg-red-500 ${className}`}>Go</button>}';
  const plain = 'export default function Tag(){return <span className="bg-zinc-100">Tag</span>}';
  const home = 'import Button from "../components/ui/Button";\nimport Tag from "../components/ui/Tag";\nexport default function Home(){return <main><Button/><Button className="mt-2 bg-blue-500"/><Tag/></main>}';
  const { root, read } = project("react", true, { "design/components/ui/Button.tsx": button, "design/components/ui/Tag.tsx": plain, "design/pages/Home.tsx": home });
  const btn = "design/components/ui/Button.tsx", page = "design/pages/Home.tsx";
  const info = editInfo(root, btn, "1:75", [`${page}:3:54`]);
  expect(info.instance).toMatchObject({ ok: true, component: "Button", where: `${page}:3` });
  expect(applyEdit(root, { file: btn, cdId: "1:75", uses: [`${page}:3:54`], scope: "instance", changes: [{ prop: "background-color", token: "primary", value: "#00f" }] }).ok).toBe(true);
  expect(read(page)).toContain('<Button/><Button className="mt-2 bg-primary!"/>');
  expect(applyEdit(root, { file: btn, cdId: "1:75", uses: [`${page}:3:45`], scope: "instance", changes: [{ prop: "color", token: "surface", value: "#fff" }] }).ok).toBe(true);
  expect(read(page)).toContain('<Button className="text-surface!"/>');
  expect(applyEdit(root, { file: btn, cdId: "1:75", uses: [`${page}:3:45`], scope: "element", changes: [{ prop: "background-color", token: "ink", value: "#000" }] }).ok).toBe(true);
  expect(read(btn)).toContain("className={`px-4 bg-ink ${className}`}");
  const tag = editInfo(root, "design/components/ui/Tag.tsx", "1:38", [`${page}:3:92`]);
  expect(tag.instance?.ok).toBe(false);
  expect(tag.instance?.reason).toContain("doesn't pass className");
  expect(tag.element.ok).toBe(true);
});

test("HTML: class and style attributes, self-closing components and instance overrides", () => {
  const { root, read } = project("html", false, {
    "design/components/badge.html": '<span class="badge" style="color: red">{{label}}</span>',
    "design/index.html": '<!doctype html><html><body>\n<c-badge label="a" /> <h1 class="t">Hi</h1>\n<c-badge label="b"></c-badge>\n</body></html>',
  });
  const page = "design/index.html", badge = "design/components/badge.html";
  expect(applyEdit(root, { file: page, cdId: "2:31", changes: [{ prop: "font-size", value: "32px" }] }).ok).toBe(true);
  expect(read(page)).toContain('<c-badge label="a" /> <h1 class="t" style="font-size: 32px;">Hi</h1>');
  expect(applyEdit(root, { file: badge, cdId: "1:1", uses: [`${page}:3:1`], scope: "instance", changes: [{ prop: "background-color", value: "#eee" }] }).ok).toBe(true);
  expect(read(page)).toContain('<c-badge label="b" style="background-color: #eee;"></c-badge>');
  expect(applyEdit(root, { file: badge, cdId: "1:1", changes: [{ prop: "color", token: "ink", value: "#111" }] }).ok).toBe(true);
  expect(read(badge)).toBe('<span class="badge" style="color: var(--color-ink);">{{label}}</span>');
});
