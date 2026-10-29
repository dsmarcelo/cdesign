import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "../src/project";
import { tailwindCss } from "../src/react";
import * as tokens from "../src/tokens";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cdesign-tailwind-"));
  roots.push(root);
  mkdirSync(join(root, "design"), {recursive: true});
  configure(root, {mode: "react", tailwind: true});
  return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));

test("init creates an editable root stylesheet without parallel token files", () => {
  const root = fixture();
  tokens.initTailwind(root);
  expect(existsSync(tokens.tokensPath(root))).toBe(false);
  expect(readFileSync(tokens.tailwindPath(root), "utf8")).toContain('@import "tailwindcss"');
  writeFileSync(tokens.tailwindPath(root), '@import "tailwindcss";\n@theme { --color-brand: #123456; }');
  tokens.initTailwind(root);
  expect(tokens.search(root, ["brand"], 25)).toContain("#123456");
  expect(tokens.show(root, "color")).toContain("brand");
  expect(tokens.set(root, "color/brand", {value: "red"})).toContain("Edit design/tailwind.css");
  expect(tokens.exportTokens(root, "tailwind")).toContain("#123456");
});

test("compiler uses editable theme, relative CSS imports, utilities and dark overrides", async () => {
  const root = fixture();
  writeFileSync(join(root, "design/palette.css"), '@theme { --color-brand: #123456; --radius-pill: 999px; }');
  writeFileSync(tokens.tailwindPath(root), '@import "tailwindcss";\n@import "./palette.css";\n[data-theme="dark"] { --color-brand: #abcdef; }');
  const css = await tailwindCss(root, ['bg-brand rounded-pill hover:bg-brand']);
  expect(css).toContain(".bg-brand");
  expect(css).toContain(".rounded-pill");
  expect(css).toContain("#abcdef");
  expect(css).toContain("#123456");
});

test("migration preserves legacy variables and CSS becomes authoritative", async () => {
  const root = fixture();
  tokens.init(root);
  tokens.set(root, "color/brand", {value: "#123456", usage: "Brand"});
  tokens.set(root, "size/md", {value: "40px", usage: "Button height"});
  tokens.initTailwind(root);
  const css = await tailwindCss(root, ["bg-brand h-md"]);
  expect(css).toContain("--size-md: 40px");
  expect(css).toContain(".bg-brand");
  writeFileSync(tokens.tailwindPath(root), '@import "tailwindcss";\n@theme { --color-brand: red; }');
  expect(tokens.search(root, ["brand"], 25)).toContain("red");
  expect(tokens.search(root, ["brand"], 25)).not.toContain("#123456");
});

test("migration preserves searchable usage for colors, scales and typography", async () => {
  const root = fixture();
  tokens.init(root);
  tokens.set(root, "color/surface", {light: "#ffffff", dark: "#161618", usage: "Raised surfaces for sidebar and inputs."});
  tokens.set(root, "spacing/12", {value: "12px", usage: "Compact control padding."});
  tokens.set(root, "type/body", {size: "14px", line: "20px", weight: "400", usage: "Body copy for product descriptions."});
  tokens.initTailwind(root);
  expect(tokens.search(root, ["sidebar"], 25)).toContain("Raised surfaces for sidebar");
  expect(tokens.search(root, ["sidebar"], 25)).toContain("#161618");
  expect(tokens.search(root, ["padding"], 25)).toContain("space-12");
  expect(tokens.show(root, "type")).toContain("Body copy for product descriptions");
  expect(tokens.tokenWarnings(root)).toEqual([]);
  expect(await tailwindCss(root, ["bg-surface type-body"])).toContain(".bg-surface");
});

test("usage comments support multiline notes and warn once per undocumented semantic token", () => {
  const root = fixture();
  writeFileSync(tokens.tailwindPath(root), `@import "tailwindcss";
@theme {
  /*
   * Raised surface.
   * Pair with foreground-primary.
   */
  --color-surface: white;
  --color-missing: red;
}
[data-theme="dark"] { --color-surface: black; --color-missing: pink; }
`);
  expect(tokens.search(root, ["pair"], 25)).toContain("foreground-primary");
  expect(tokens.tokenWarnings(root)).toHaveLength(1);
  expect(tokens.tokenWarnings(root)[0]).toContain("color/missing");
  const original = readFileSync(tokens.tailwindPath(root), "utf8");
  tokens.initTailwind(root);
  expect(readFileSync(tokens.tailwindPath(root), "utf8")).toBe(original);
});
