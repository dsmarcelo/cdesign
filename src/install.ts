import { join } from "node:path";

const NAME = "cdesign";
const CLI = join(import.meta.dir, "cli.ts");
const CMD = [process.execPath, CLI, "mcp"];

const run = (args: string[]) => {
  const p = Bun.spawnSync(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() + p.stderr.toString() };
};

type Agent = { bin: string; add: () => string[]; remove: () => string[]; prep?: () => string[] };

const AGENTS: Record<string, Agent> = {
  claude: {
    bin: "claude",
    add: () => ["claude", "mcp", "add", "--scope", "user", NAME, "--", ...CMD],
    remove: () => ["claude", "mcp", "remove", "--scope", "user", NAME],
  },
  codex: {
    bin: "codex",
    add: () => ["codex", "mcp", "add", NAME, "--", ...CMD],
    remove: () => ["codex", "mcp", "remove", NAME],
  },
  agy: {
    bin: "agy",
    add: () => ["agy", "mcp", "add", NAME, ...CMD],
    remove: () => ["agy", "mcp", "remove", NAME],
  },
};

export function installMcp(remove: boolean, targets: string[]): number {
  const names = !targets.length || targets.includes("all") ? Object.keys(AGENTS) : targets;
  const unknown = names.filter((n) => !AGENTS[n]);
  if (unknown.length) { console.error(`unknown agent: ${unknown.join(", ")} (claude, codex, agy, all)`); return 1; }
  const explicit = targets.length > 0 && !targets.includes("all");
  let code = 0, done = 0;
  for (const n of names) {
    const a = AGENTS[n];
    if (!Bun.which(a.bin)) {
      if (explicit) { console.error(`${n}: '${a.bin}' not found on PATH`); code = 1; } else console.log(`${n}: not installed, skipped`);
      continue;
    }
    if (!remove) run(a.remove()); // replace any stale registration (e.g. a different path)
    const r = run(remove ? a.remove() : a.add());
    if (r.ok) { console.log(`${n}: ${remove ? "removed" : "registered"}`); done++; }
    else if (remove) console.log(`${n}: not registered`);
    else { console.error(`${n}: failed\n${r.out.trim()}`); code = 1; }
  }
  if (!remove && !done && !code) console.log("no supported agent found (claude, codex, agy)");
  return code;
}
