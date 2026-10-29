import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type ProjectConfig = { version: 1; mode: "react" | "html"; tailwind: boolean };
export type SetupOptions = Partial<Pick<ProjectConfig, "mode" | "tailwind">>;
export const configPath = (root: string) => join(root, "design/cdesign.json");
const SKIP = new Set(["node_modules", ".git", ".cdesign", "dist", ".next", ".astro", "build"]);

/** Do not follow symlinks or enumerate dependencies/build output. */
export function projectFiles(root: string, dir = root): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink() || SKIP.has(e.name)) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? projectFiles(root, p) : [relative(root, p).split(sep).join("/")];
  }).sort();
}

export function readConfig(root: string): ProjectConfig {
  if (existsSync(configPath(root))) {
    const c = JSON.parse(readFileSync(configPath(root), "utf8"));
    if (c.version !== 1 || !["react", "html"].includes(c.mode) || typeof c.tailwind !== "boolean")
      throw new Error("Invalid design/cdesign.json: expected version 1, mode react|html, and boolean tailwind");
    return c;
  }
  const legacy = existsSync(join(root, "design/design-system.md")) || projectFiles(root, join(root, "design")).some(f => f.endsWith(".html"));
  return { version: 1, mode: legacy ? "html" : "react", tailwind: !legacy };
}

export function configure(root: string, options: SetupOptions = {}): ProjectConfig {
  const current = readConfig(root), next = { ...current, ...options };
  if (!["react", "html"].includes(next.mode) || typeof next.tailwind !== "boolean") throw new Error("Invalid project setup options");
  if (existsSync(configPath(root)) && next.mode === current.mode && next.tailwind === current.tailwind) return current;
  mkdirSync(join(root, "design"), { recursive: true });
  writeFileSync(configPath(root), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Explicit flags skip prompts. Existing projects keep their settings. */
export async function setup(root: string, options: SetupOptions): Promise<ProjectConfig> {
  if (!existsSync(configPath(root)) && !existsSync(join(root, "design/design-system.md")) &&
      !projectFiles(root, join(root, "design")).some(f => f.endsWith(".html")) &&
      options.mode === undefined && options.tailwind === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const mode = (await rl.question("Mode: React / HTML [React]: ")).trim().toLowerCase();
      if (mode && !["react", "html"].includes(mode)) throw new Error("Choose react or html");
      const tw = (await rl.question("Use Tailwind CSS? [Y/n]: ")).trim().toLowerCase();
      if (tw && !["y", "yes", "n", "no"].includes(tw)) throw new Error("Choose yes or no");
      options = { mode: mode === "html" ? "html" : "react", tailwind: !["n", "no"].includes(tw) };
    } finally { rl.close(); }
  }
  return configure(root, options);
}
