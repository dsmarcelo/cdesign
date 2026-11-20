import { expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectId } from "../src/store";

async function until<T>(fn: () => T | Promise<T>) {
  for (let i = 0; i < 150; i++) {
    try { const value = await fn(); if (value) return value; } catch { /* Restart in progress. */ }
    await Bun.sleep(40);
  }
  throw new Error("Timed out waiting for the update daemon");
}

test("a linked viewer reloads on the same port and keeps its project and comments", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdesign-update-daemon-"));
  const runtime = join(home, "runtime"), link = join(home, "link"), root = join(home, "project");
  const state = () => JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as { port: number; pid: number };
  mkdirSync(runtime);
  mkdirSync(root);
  for (const dir of ["src", "ui"]) cpSync(resolve(dir), join(runtime, dir), { recursive: true });
  symlinkSync(resolve("node_modules"), join(runtime, "node_modules"), "dir");
  symlinkSync(runtime, link, "dir");
  const tunnelTarget = join(home, "tunnel-target");
  writeFileSync(join(home, "cloudflared"), `#!/bin/bash
printf '%s' "${"$"}{!#}" > "${tunnelTarget}"
echo https://test-link.trycloudflare.com >&2
exec sleep 300
`, { mode: 0o755 });
  const codex = resolve("tests/fixtures/fake-codex.ts");
  writeFileSync(join(home, "codex"), `#!/bin/sh
exec "${process.execPath}" "${codex}" "$@"
`, { mode: 0o755 });
  const cli = join(link, "src/cli.ts");
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
    env: { ...process.env, CDESIGN_HOME: home, CDESIGN_INSTALL_LINK: link, CDESIGN_IDLE_SECONDS: "300", PATH: home + ":" + process.env.PATH, FAKE_CODEX_INIT_DELAY: "1500" },
    stdout: "ignore", stderr: "inherit",
  });
  let nextPid: number | undefined;
  try {
    const { port, pid } = await until(state);
    const origin = `http://127.0.0.1:${port}`;
    const endpoint = origin + "/__cd/update";
    const project = origin + "/__cd/comments?project=" + projectId(root);
    const open = await fetch(project, { method: "POST", body: JSON.stringify({ file: "design/home.html", cdId: "1:1", text: "Keep this" }) });
    expect(open.ok).toBe(true);
    expect((await (await fetch(endpoint)).json()).available).toBe(false);
    const source = readFileSync(cli, "utf8");
    appendFileSync(cli, "\nconst = broken;\n");
    const apply = () => fetch(endpoint, { method: "POST", headers: { origin } });
    expect((await fetch(endpoint, { method: "POST" })).status).toBe(403);
    expect((await fetch(endpoint, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(origin + "/__cd/tunnel", { method: "POST" })).ok).toBe(true);
    const tunnelUrl = readFileSync(tunnelTarget, "utf8") + "/__cd/update";
    expect((await fetch(tunnelUrl)).status).toBe(403);
    expect((await fetch(tunnelUrl, { method: "POST", headers: { origin: new URL(tunnelUrl).origin } })).status).toBe(403);
    const chat = origin + "/__cd/chat";
    const projectQuery = "?project=" + projectId(root);
    const send = await fetch(chat + "/send" + projectQuery, { method: "POST", body: JSON.stringify({ text: "hello" }) });
    expect(send.status).toBe(202);
    const { conversationId } = await send.json();
    const busy = await apply();
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toContain("agent");
    await until(async () => !(await (await fetch(chat + projectQuery)).json()).busy);
    const website = "/__cd/website/export" + projectQuery;
    const pending = await Bun.connect({
      hostname: "127.0.0.1", port,
      socket: { data() {} },
    });
    try {
      pending.write(`POST ${website} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 2\r\n\r\n{`);
      await until(async () => {
        const response = await fetch(origin + website, { method: "POST", body: "{}" });
        return response.status === 409;
      });
      const exporting = await apply();
      expect(exporting.status).toBe(409);
      expect((await exporting.json()).error).toContain("website job");
    } finally {
      pending.end("}");
    }
    await until(async () => (await fetch(origin + website, { method: "POST", body: "{}" })).status === 400);
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(state().pid).toBe(pid);
    writeFileSync(cli, source + "\n// changed runtime\n");
    const results = await Promise.all([apply(), apply()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const response = results.find((r) => r.ok)!;
    const { instance } = await response.json();
    nextPid = (await until(() => state().pid !== pid && state())).pid;
    expect(state().port).toBe(port);
    expect((await (await fetch(endpoint)).json()).instance).not.toBe(instance);
    expect((await (await fetch(origin + "/__cd/projects")).json()).projects.map((p: { id: string }) => p.id)).toEqual([projectId(root)]);
    expect((await (await fetch(project)).json())[0].text).toBe("Keep this");
    const restored = await (await fetch(chat + projectQuery + "&c=" + conversationId)).json();
    expect(restored.conversation.id).toBe(conversationId);
    expect(restored.conversation.items.some((item: { text: string }) => item.text === "hello")).toBe(true);
  } finally {
    try {
      const pid = nextPid ?? state().pid;
      if (pid !== daemon.pid) process.kill(pid);
    } catch { /* Failed before restart. */ }
    daemon.kill();
    await daemon.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
