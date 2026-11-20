import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater } from "../src/updater";

test("downloaded updates require a newer commit on the installed branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdesign-updater-"));
  const sha = "a".repeat(40);
  const next = "b".repeat(40);
  let head = sha;
  let status = "ahead";
  let unavailable = false;
  try {
    writeFileSync(join(root, ".install.json"), JSON.stringify({ kind: "archive", repo: "example/fork", ref: "team/main", sha }));
    const updater = new Updater(root, "", async (url) => {
      if (unavailable) throw new Error("offline");
      expect(url).toContain("/repos/example/fork/");
      if (url.endsWith("/commits/team%2Fmain")) return Response.json({ sha: head });
      expect(url).toEndWith(`/compare/${sha}...${next}`);
      return Response.json({ status });
    });
    expect(await updater.check()).toBeNull();
    head = next;
    expect(await updater.check()).toEqual({ kind: "archive", sha: next });
    status = "diverged";
    expect(await updater.check()).toBeNull();
    unavailable = true;
    expect(await updater.check()).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("linked updates distinguish upstream changes, dirty edits, and divergence", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-linked-"));
  const root = join(home, "root");
  const upstream = join(home, "upstream");
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    mkdirSync(upstream);
    git(upstream, "init", "-b", "main");
    mkdirSync(join(upstream, "src"));
    writeFileSync(join(upstream, "src/cli.ts"), "first");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "first");
    git(home, "clone", upstream, root);
    Bun.spawnSync(["ln", "-s", root, join(home, "linked")]);
    const updater = new Updater(root, join(home, "linked"));
    expect(await updater.check()).toBeNull();
    writeFileSync(join(upstream, "src/cli.ts"), "upstream");
    git(upstream, "commit", "-am", "upstream");
    expect(await updater.check()).toMatchObject({ kind: "checkout" });
    await updater.apply();
    expect(git(root, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"));
    const reloaded = new Updater(root, join(home, "linked"));
    writeFileSync(join(upstream, "src/cli.ts"), "second upstream change");
    git(upstream, "commit", "-am", "second upstream");
    writeFileSync(join(root, "src/cli.ts"), "local");
    expect(await reloaded.check()).toEqual({ kind: "reload" });
    await reloaded.apply();
    expect(git(root, "status", "--porcelain")).toContain("src/cli.ts");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(git(upstream, "rev-parse", "HEAD"));
    git(root, "commit", "-am", "local");
    expect(await new Updater(root, join(home, "linked")).check()).toBeNull();
    git(root, "reset", "--hard", "@{upstream}");
    git(root, "commit", "--allow-empty", "-m", "ahead");
    expect(await new Updater(root, join(home, "linked")).check()).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
