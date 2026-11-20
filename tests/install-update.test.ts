import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Bash installer records an exact downloaded revision for script and stdin installs", () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-install-"));
  try {
    const bin = join(home, "bin");
    const sha = "a".repeat(40);
    const update = "b".repeat(40);
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/bash
if [ "${"$"}FAIL_DOWNLOAD" = 1 ]; then exit 1; fi
case "${"$"}*" in
  *api.github.com/repos/example/fork/commits/topic*) echo '{"sha":"${sha}"}';;
  *github.com/example/fork/archive/${sha}.tar.gz*|*github.com/example/fork/archive/${update}.tar.gz*) cat "${"$"}HOME/archive";;
  *) exit 1;;
esac
`, { mode: 0o755 });
    const fixture = join(home, "fixture");
    mkdirSync(join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "src/cli.ts"), "");
    writeFileSync(join(fixture, "package.json"), "{}");
    expect(Bun.spawnSync(["tar", "-czf", join(home, "archive"), "-C", home, "fixture"]).exitCode).toBe(0);
    const env = { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH, CDESIGN_HOME: join(home, "share"), CDESIGN_REPO: "example/fork", CDESIGN_REF: "topic", CDESIGN_SRC: "" };
    mkdirSync(env.CDESIGN_HOME);
    for (const stdin of [false, true]) {
      const result = Bun.spawnSync(stdin ? ["bash"] : ["bash", "install.sh"], { env, ...(stdin ? { stdin: readFileSync("install.sh") } : {}) });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(env.CDESIGN_HOME, ".install.json"), "utf8"))).toEqual({ kind: "archive", repo: "example/fork", ref: "topic", sha });
    }
    const failed = Bun.spawnSync(["bash", "install.sh"], {
      env: { ...env, CDESIGN_INSTALL_SHA: update, FAIL_DOWNLOAD: "1" },
    });
    expect(failed.exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(join(env.CDESIGN_HOME, ".install.json"), "utf8")).sha).toBe(sha);
    const replacement = Bun.spawnSync(["bash", "install.sh"], {
      env: { ...env, CDESIGN_INSTALL_SHA: update, CDESIGN_INSTALL_UPDATE: "1" },
    });
    expect(replacement.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(env.CDESIGN_HOME, ".install.json"), "utf8")).sha).toBe(update);
    const linked = Bun.spawnSync(["bash", "install.sh"], { env: { ...env, CDESIGN_SRC: fixture } });
    expect(linked.exitCode).toBe(0);
    expect(realpathSync(env.CDESIGN_HOME)).toBe(fixture);
    expect(readFileSync(join(home, ".local/bin/cdesign"), "utf8")).toContain("CDESIGN_INSTALL_LINK");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
