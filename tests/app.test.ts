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

test("web app serves manifest, service worker, icons, and keeps the picker after closing a project", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-webapp-"));
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
    const api = base.replace("localhost", "127.0.0.1");

    const html = await (await fetch(api + "/")).text();
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    const manifestRes = await fetch(api + "/manifest.webmanifest");
    expect(manifestRes.ok).toBe(true);
    expect(manifestRes.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = await manifestRes.json() as { name: string; display: string; icons: { src: string }[] };
    expect(manifest.name).toBe("cdesign");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      expect((await fetch(api + icon.src)).ok).toBe(true);
    }
    const swRes = await fetch(api + "/sw.js");
    expect(swRes.ok).toBe(true);
    expect(swRes.headers.get("content-type")).toContain("javascript");
    expect((await fetch(api + "/__cd/apple-touch-icon.png")).ok).toBe(true);

    const add = await fetch(api + "/__cd/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    expect(add.ok).toBe(true);
    const project = new URL((await add.json() as { url: string }).url);
    const id = project.hostname.split(".")[0];
    expect(project.port).toBe(new URL(base).port);
    expect((await (await fetch(api + "/__cd/projects")).json()).projects).toHaveLength(1);
    expect((await (await fetch(api + "/__cd/tunnel")).json()).url).toBeNull();
    expect((await fetch(api + `/__cd/projects/${id}/remove`, { method: "POST" })).ok).toBe(true);
    await Bun.sleep(350);
    expect((await (await fetch(api + "/__cd/projects")).json()).projects).toHaveLength(0);
  } finally {
    daemon.kill();
    await daemon.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

test("restart replaces the daemon on the same port, keeps the tunnel alive, and close --all stops both", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-restart-"));
  const root = join(home, "project");
  mkdirSync(root);
  const fake = join(home, "cloudflared");
  writeFileSync(fake, "#!/bin/sh\necho https://keep-link.trycloudflare.com >&2\nexec sleep 300\n");
  chmodSync(fake, 0o755);
  const cli = join(import.meta.dir, "../src/cli.ts");
  const env = { ...process.env, PATH: `${home}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let pids: number[] = [];
  try {
    const start = Bun.spawnSync([process.execPath, cli, "restart", "--port", "0"], { env, stderr: "pipe" });
    expect(start.exitCode).toBe(0);
    expect(start.stdout.toString()).toContain("https://keep-link.trycloudflare.com");
    const first = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { pid: number; port: number; instance: string };
    const firstTunnel = JSON.parse(readFileSync(join(home, "tunnel-runtime.json"), "utf8")) as { pid: number; url: string };
    pids.push(first.pid, firstTunnel.pid);
    expect(firstTunnel.url).toBe("https://keep-link.trycloudflare.com");

    // Simulate lost daemon.json (orphaned daemon): restart --port <port> must still find and replace it.
    rmSync(join(home, "daemon.json"));
    const restarted = Bun.spawnSync([process.execPath, cli, "restart", "--port", String(first.port)], { env, stderr: "pipe" });
    expect(restarted.exitCode).toBe(0);
    const second = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { pid: number; port: number; instance: string };
    const secondTunnel = JSON.parse(readFileSync(join(home, "tunnel-runtime.json"), "utf8")) as { pid: number; url: string };
    pids.push(second.pid, secondTunnel.pid);
    expect(second.port).toBe(first.port);
    expect(second.pid).not.toBe(first.pid);
    expect(second.instance).not.toBe(first.instance);
    expect(alive(first.pid)).toBe(false);
    // The tunnel process and URL survived the restart.
    expect(secondTunnel.pid).toBe(firstTunnel.pid);
    expect(secondTunnel.url).toBe(firstTunnel.url);
    expect(alive(secondTunnel.pid)).toBe(true);

    const status = Bun.spawnSync([process.execPath, cli, "status"], { env, stderr: "pipe" });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain(`pid ${second.pid}`);
    expect(status.stdout.toString()).toContain("https://keep-link.trycloudflare.com");

    const close = Bun.spawnSync([process.execPath, cli, "close", "--all"], { env, stderr: "pipe" });
    expect(close.exitCode).toBe(0);
    expect(alive(second.pid)).toBe(false);
    expect(alive(secondTunnel.pid)).toBe(false);
  } finally {
    for (const pid of pids) try { process.kill(pid); } catch { /* already gone */ }
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
