import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { context } from "../src/context";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cdesign-context-")); roots.push(root);
  const put = (file: string, body: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), body); };
  put("design/design-system.md", "# Example\nIdentity and language.\n\n## Forms\nUse grouped forms.\n## Colors\nUse semantic colors.\n");
  return { root, put };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("legacy sections retrieve rules without unrelated context; imported bundles stay out", () => {
  const {root, put} = fixture();
  put("design/reference/import.md", "secret imported phrase");
  put("design/pages/exported-ds/spec/README.md", "secret imported phrase");
  put("design/patterns/forms.md", "# Form composition\nUse validation messages.");
  expect(context(root, "get", "design-system#forms")).toContain("Use grouped forms.");
  expect(context(root, "get", "design-system#forms")).not.toContain("semantic colors");
  expect(context(root, "find", "validation")).toContain("patterns/forms");
  expect(context(root, "find", "secret imported phrase")).toContain("0 matches");
});

test("component discovery reads a contract rather than source and target maps direct dependencies", () => {
  const {root, put} = fixture();
  put("design/components/ui/button.html", '<!-- Props: variant (default|quiet). Slots: default. -->\n<style>.do-not-dump { color: red }</style><button class="{{variant|default}}"><slot></slot><c-icon></c-icon></button>');
  put("design/pages/home.html", "<c-button>Save</c-button>PAGE_SOURCE_SENTINEL");
  const result = context(root, "get", "component/button");
  expect(result).toContain('variant="default"');
  expect(result).toContain("Dependencies: icon");
  expect(result).toContain("previews/button.preview.html");
  expect(result).not.toContain("do-not-dump");
  const map = context(root, "for", "design/pages/home.html");
  expect(map).toContain("component/button");
  expect(map).not.toContain("component/icon");
  expect(map).not.toContain("PAGE_SOURCE_SENTINEL");
});

test("large documents and catalogs have continuations", () => {
  const {root, put} = fixture();
  put("design/patterns/large.md", "# Long\n" + "abcdefghij".repeat(1500));
  for (let i = 0; i < 30; i++) put(`design/patterns/topic-${i}.md`, `# Topic ${i}`);
  const first = context(root, "get", "patterns/large");
  expect(first.length).toBeLessThan(6300);
  expect(first).toContain('--offset 6000');
  expect(context(root, "get", "patterns/large", 12000)).not.toContain("[More text:");
  expect(context(root)).toContain("--offset 20");
  expect(context(root, "list", "", 20)).toContain("patterns/topic-");
});

test("heading ids ignore fenced examples and disambiguate duplicate names", () => {
  const {root, put} = fixture();
  put("design/patterns/example.md", "# Example\n## States\nFirst.\n```md\n## Fake heading\n```\n## States\nSecond.");
  expect(context(root, "get", "patterns/example#states-2")).toContain("Second.");
  expect(() => context(root, "get", "patterns/example#fake-heading")).toThrow("Unknown context id");
});

test("target inspection rejects outside files including symlink escapes", () => {
  const {root, put} = fixture();
  const other = fixture(); other.put("outside.html", "outside");
  put("design/pages/home.html", "home");
  symlinkSync(join(other.root, "outside.html"), join(root, "design/pages/escape.html"));
  expect(() => context(root, "for", join(other.root, "outside.html"))).toThrow("inside this project");
  expect(() => context(root, "for", "design/pages/escape.html")).toThrow("inside this project");
  expect(() => context(root, "get", "design-system", -1)).toThrow("offset");
});

test("scaffolding and checks accept split guidance or header contracts, and detect broken links", () => {
  const {root, put} = fixture();
  const cli = join(import.meta.dir, "../src/cli.ts");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });
  expect(run("init").exitCode).toBe(0);
  put("design/components/ui/custom.html", '<!-- Purpose: Custom control. Props: label. --><button>{{label}}</button>');
  put("design/components/ui/previews/custom.preview.html", '<c-custom label="Save"></c-custom>');
  put("design/components/ui/other.html", '<button>Other</button>');
  put("design/components/ui/previews/other.preview.html", '<c-other></c-other>');
  put("design/patterns/controls.md", '# Controls\nThe other component is supported.');
  expect(run("check").exitCode).toBe(0);
  put("design/patterns/with spaces.md", "# Details");
  put("design/patterns/controls.md", '# Controls\nThe other component. [Details](<with spaces.md>)\n```md\n[Example](not-a-real-file.md)\n```');
  expect(run("check").exitCode).toBe(0);
  put("design/patterns/controls.md", '# Controls\nThe other component. [Missing](missing.md)');
  const broken = run("check");
  expect(broken.exitCode).toBe(1);
  expect(broken.stdout.toString()).toContain("broken guidance link");
});

test("MCP exposes the same targeted context and discoverable skills", async () => {
  const {root, put} = fixture();
  put("design/components/ui/button.html", '<!-- Props: label. --><button>{{label|Save}}</button>');
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "context-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/cli.ts"), "mcp"], cwd: root, stderr: "pipe" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.some(t => t.name === "context")).toBe(true);
    const result = await client.callTool({ name: "context", arguments: { action: "get", query: "component/button" } });
    expect(JSON.stringify(result.content)).toContain('label=');
    const skills = await client.callTool({ name: "run", arguments: { args: "skills" } });
    expect(JSON.stringify(skills.content)).toContain("skills get cdesign-system");
    expect(JSON.stringify(skills.content)).not.toContain("## Files and components");
  } finally { await client.close(); }
});
