import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure } from "../src/project";
import { adapter, listPages } from "../src/modes";

test("HTML and React previews coexist in either project mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdesign-mixed-"));
  try {
    mkdirSync(join(root, "design/pages"), { recursive: true });
    writeFileSync(join(root, "design/pages/Page.html"), "<html><body>HTML preview</body></html>");
    writeFileSync(join(root, "design/pages/Page.tsx"), "export default function Page(){return <main>React preview</main>}");
    for (const mode of ["react", "html"] as const) {
      configure(root, { mode, tailwind: false });
      expect(listPages(root)).toEqual(["design/pages/Page.html", "design/pages/Page.tsx"]);
      expect(await adapter(root).render(root, "design/pages/Page.html")).toContain("HTML preview");
      expect(await adapter(root).render(root, "design/pages/Page.tsx")).toContain("/__cd/react/");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
