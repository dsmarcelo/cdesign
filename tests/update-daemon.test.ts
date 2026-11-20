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
  const cli = join(link, "src/cli.ts");
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
    env: { ...process.env, CDESIGN_HOME: home, CDESIGN_INSTALL_LINK: link, CDESIGN_IDLE_SECONDS: "300" },
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
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(state().pid).toBe(pid);
    writeFileSync(cli, source + "\n// changed runtime\n");
    const response = await apply();
    expect(response.ok).toBe(true);
    const { instance } = await response.json();
    nextPid = (await until(() => state().pid !== pid && state())).pid;
    expect(state().port).toBe(port);
    expect((await (await fetch(endpoint)).json()).instance).not.toBe(instance);
    expect((await (await fetch(origin + "/__cd/projects")).json()).projects.map((p: { id: string }) => p.id)).toEqual([projectId(root)]);
    expect((await (await fetch(project)).json())[0].text).toBe("Keep this");
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
