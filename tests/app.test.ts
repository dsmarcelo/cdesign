import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("app tunnel starts without a project and reports its status", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-app-"));
  const fake = join(home, "cloudflared");
  writeFileSync(fake, "#!/bin/sh\necho https://test-link.trycloudflare.com >&2\nexec sleep 300\n");
  chmodSync(fake, 0o755);
  const daemon = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "daemon", "--port", "0"], {
    env: { ...process.env, PATH: `${home}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" },
    stdout: "ignore", stderr: "pipe",
  });
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      try { port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await Bun.sleep(50); }
    }
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;
    expect((await (await fetch(base + "/__cd/tunnel")).json()).url).toBeNull();
    const results = await Promise.all([1, 2].map(() => fetch(base + "/__cd/tunnel", { method: "POST" }).then(r => r.json())));
    expect(results.map(r => r.url)).toEqual(["https://test-link.trycloudflare.com", "https://test-link.trycloudflare.com"]);
    expect((await (await fetch(base + "/__cd/tunnel")).json()).url).toBe("https://test-link.trycloudflare.com");
  } finally {
    daemon.kill();
    await daemon.exited;
    rmSync(home, { recursive: true, force: true });
  }
});
