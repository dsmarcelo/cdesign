import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("desktop opens the shared daemon without a tunnel and keeps the picker after closing a project", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-desktop-"));
  const root = join(home, "project");
  mkdirSync(root);
  const cli = join(import.meta.dir, "../src/cli.ts");
  const env = { ...process.env, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" };
  const daemon = Bun.spawn([process.execPath, cli, "daemon", "--port", "0"], { env, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = daemon.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    const base = new TextDecoder().decode(first.value).trim().replace("cdesign viewer: ", "");
    const launch = (...args: string[]) => {
      const result = Bun.spawnSync([process.execPath, cli, "desktop-url", ...args], { env, stderr: "inherit" });
      expect(result.exitCode).toBe(0);
      return new URL(result.stdout.toString().trim());
    };
    expect(launch().origin).toBe(base);
    const project = launch(root);
    const id = project.hostname.split(".")[0];
    expect(project.port).toBe(new URL(base).port);
    const api = base.replace("localhost", "127.0.0.1");
    expect((await (await fetch(api + "/__cd/projects")).json()).projects).toHaveLength(1);
    expect((await (await fetch(api + "/__cd/tunnel")).json()).url).toBeNull();
    expect((await fetch(api + `/__cd/projects/${id}/remove`, { method: "POST" })).ok).toBe(true);
    await Bun.sleep(350);
    expect(launch().origin).toBe(base);
    expect((await (await fetch(api + "/__cd/projects")).json()).projects).toHaveLength(0);
  } finally {
    daemon.kill();
    await daemon.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
