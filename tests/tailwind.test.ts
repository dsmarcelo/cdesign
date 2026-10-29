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
