import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const cli = join(import.meta.dir, "../src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

type Env = Record<string, string>;
/** Throwaway home + project + daemon (port 0) with a fake `codex` first on PATH. */
async function boot(env: Env = {}, withCodex = true) {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-chat-"));
  const home = join(dir, "home"), root = join(dir, "project"), bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", home, root, bin]);
  if (withCodex) {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`);
    chmodSync(join(bin, "codex"), 0o755);
  }
  const path = `${bin}:${process.env.PATH}`;
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
    env: { ...process.env, PATH: path, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", ...env },
    stdout: "ignore", stderr: "pipe",
  });
  cleanups.push(async () => { daemon.kill(); await daemon.exited; rmSync(dir, { recursive: true, force: true }); });
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) { try { port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await Bun.sleep(50); } }
  expect(port).toBeGreaterThan(0);
  const id = projectId(root);
  const base = `http://127.0.0.1:${port}`;
  const url = (p: string) => `${base}/__cd/${p}${p.includes("?") ? "&" : "?"}project=${id}`;
  const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
  const snap = async () => (await fetch(url("chat"))).json() as Promise<any>;
  const until = async <T,>(fn: () => Promise<T> | T, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(25); }
    throw new Error("timed out");
  };
  return { dir, home, root, id, base, url, post, snap, until, daemon, path };
}
const texts = (s: any, kind: string) => s.conversation.items.filter((i: any) => i.kind === kind);

test("providers: discovery reports a ready Codex without running a turn, and actionable states otherwise", async () => {
  const ok = await boot();
  const r = await (await fetch(ok.url("chat/providers"))).json();
  expect(r.providers[0]).toMatchObject({ id: "codex", state: "ready", version: "0.169.0" });

  const out = await boot({ FAKE_CODEX_LOGIN: "out" });
  expect((await (await fetch(out.url("chat/providers"))).json()).providers[0]).toMatchObject({ state: "login" });
  expect((await (await fetch(out.url("chat/providers"))).json()).providers[0].message).toContain("codex login");

  const old = await boot({ FAKE_CODEX_VERSION: "0.1.0" });
  expect((await (await fetch(old.url("chat/providers"))).json()).providers[0].state).toBe("unsupported");

  const none = await boot({ PATH: "/nonexistent" }, false);
  const m = (await (await fetch(none.url("chat/providers"))).json()).providers[0];
  expect(m.state).toBe("missing");
  expect(m.message).toContain("not found");
});

test("send streams a turn: message deltas, tool activity, exact project root, full access", async () => {
  const log = join(tmpdir(), `fake-codex-${Math.random().toString(36).slice(2)}.log`);
  cleanups.push(() => rmSync(log, { force: true }));
  const c = await boot({ FAKE_CODEX_LOG: log });
  const events = await fetch(c.url("chat/events"));
  const reader = events.body!.getReader();
  const res = await c.post("chat/send", { text: "  hello there  ", provider: "codex" });
  expect(res.status).toBe(202);
  const s = await c.until(async () => { const x = await c.snap(); return x.conversation?.status === "idle" && x.conversation.items.length > 2 ? x : null; });
  expect(s.conversation).toMatchObject({ provider: "codex", fullAccess: true, error: null });
  expect(texts(s, "user")[0].text).toBe("hello there");
  expect(texts(s, "message")[0].text).toBe("Hello from fake Codex");
  expect(texts(s, "command")[0]).toMatchObject({ title: "ls -la", output: "total 0\n", status: "completed" });

  // the live stream carried the incremental deltas in order
  let raw = "";
  const dec = new TextDecoder();
  while (!raw.includes("turn.completed")) raw += dec.decode((await reader.read()).value);
  const seqs = [...raw.matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect([...raw.matchAll(/"item\.delta".*?"text":"([^"]*)"/g)].map((m) => m[1])).toEqual(["total 0\\n", "Hello", " from", " fake Codex"]);
  await reader.cancel();

  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0].cwd).toBe(realpath(c.root));
  const start = lines.find((l) => l.method === "thread/start");
  expect(start.params).toMatchObject({ cwd: c.root, approvalPolicy: "never", sandbox: "danger-full-access" });
  expect(lines.find((l) => l.method === "turn/start").params.input[0].text).toBe("hello there");
});
const realpath = (p: string) => require("node:fs").realpathSync(p);

test("one active turn per project: a duplicate submit is rejected, and prompts are validated", async () => {
  const c = await boot();
  expect((await c.post("chat/send", { text: "   " })).status).toBe(400);
  expect((await c.post("chat/send", { text: "x".repeat(20001) })).status).toBe(400);
  expect((await c.post("chat/send", { text: "hi", provider: "nope" })).status).toBe(400);
  expect((await fetch(c.url("chat/send"), { method: "POST", body: "{nope" })).status).toBe(400);
  expect((await fetch(c.url("chat/send"), { method: "POST", body: JSON.stringify({ text: "x".repeat(200_000) }) })).status).toBe(413);
  const first = await Promise.all([c.post("chat/send", { text: "slow one" }), c.post("chat/send", { text: "slow two" })]);
  expect(first.map((r) => r.status).sort()).toEqual([202, 409]);
  const s = await c.until(async () => { const x = await c.snap(); return texts(x, "message")[0]?.text ? x : null; });
  expect(texts(s, "user")).toHaveLength(1);
  expect(s.busy).toBe(true);
  expect((await c.post("chat/send", { text: "again" })).status).toBe(409);
  await c.post("chat/stop", {});
  await c.until(async () => !(await c.snap()).busy);
});

test("stop interrupts the turn and keeps partial output; stale ids are rejected", async () => {
  const c = await boot();
  expect((await c.post("chat/stop", {})).status).toBe(409); // nothing running
  await c.post("chat/send", { text: "slow please" });
  const running = await c.until(async () => { const x = await c.snap(); return x.conversation?.turnId && texts(x, "message")[0]?.text ? x : null; });
  expect((await c.post("chat/stop", { conversationId: "other" })).status).toBe(409);
  expect((await c.post("chat/stop", { conversationId: running.conversation.id, turnId: "stale" })).status).toBe(409);
  expect((await c.post("chat/stop", { conversationId: running.conversation.id, turnId: running.conversation.turnId })).status).toBe(202);
  const s = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" ? x : null; });
  expect(texts(s, "message")[0].text).toBe("Hello from");
  expect(s.busy).toBe(false);
  expect((await c.post("chat/send", { text: "next turn works" })).status).toBe(202);
});

test("stop kills an agent that ignores the interrupt and keeps what it said", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "slow ignore" });
  await c.until(async () => texts(await c.snap(), "message")[0]?.text);
  await Bun.sleep(100);
  await c.post("chat/stop", {});
  const s = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" ? x : null; }, 12000);
  expect(texts(s, "message")[0].text).toBe("Hello from fake Codex");
  expect(s.conversation.error).toBeNull();
}, 20000);

test("process failure mid-turn and startup failure are surfaced, partial output retained, next turn recovers", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "crash now" });
  const s = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" ? x : null; });
  expect(s.conversation.error).toContain("exit code 3");
  expect(texts(s, "message")[0].text).toBe("Hello from fake Codex");
  expect((await c.post("chat/send", { text: "hi again" })).status).toBe(202);
  const s2 = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" && x.conversation.error === null ? x : null; });
  expect(texts(s2, "message").at(-1).text).toBe("Hello from fake Codex");

  const bad = await boot({ FAKE_CODEX_START: "die" });
  await bad.post("chat/send", { text: "hi" });
  const f = await bad.until(async () => { const x = await bad.snap(); return x.conversation.status === "idle" ? x : null; });
  expect(f.conversation.error).toContain("boom: cannot start");
  expect(f.busy).toBe(false);
});

test("an agent edit in the project reaches the existing preview reload stream, chat tokens do not", async () => {
  const c = await boot();
  const res = await fetch(c.url("events?tab=t1"));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = "";
  (async () => { for (;;) { const r = await reader.read(); if (r.done) return; raw += dec.decode(r.value); } })().catch(() => {});
  await c.post("chat/send", { text: "edit a file" });
  await c.until(async () => raw.includes("data: reload"));
  await c.until(async () => (await c.snap()).conversation.status === "idle");
  expect(existsSync(join(c.root, "fake-agent-edit.txt"))).toBe(true);
  rmSync(join(c.root, "fake-agent-edit.txt"));
  expect(raw).not.toContain("fake Codex");
  expect(raw).not.toContain("turn.");
  await reader.cancel();
});

test("chat is local-only: tunnel visitors cannot read, stream or write it, and foreign origins are refused", async () => {
  const free = Bun.serve({ port: 0, fetch: () => new Response("") }), tport = free.port; free.stop(true);
  const c = await boot();
  writeFileSync(join(c.dir, "bin", "cloudflared"), "#!/bin/sh\necho 'Registered tunnel connection' >&2\nexec sleep 300\n");
  chmodSync(join(c.dir, "bin", "cloudflared"), 0o755);
  writeFileSync(join(c.home, "tunnel.json"), JSON.stringify({ provider: "cloudflare", domain: "x.example.com", token: "t", port: tport }));
  expect((await c.post("chat/send", { text: "local ok" })).status).toBe(202);
  await c.until(async () => !(await c.snap()).busy);
  expect((await fetch(c.base + "/__cd/tunnel", { method: "POST" })).ok).toBe(true);
  const t = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${tport}/__cd/${p}`, { ...init, headers: { host: "x.example.com" } });
  expect((await t("chat")).status).toBe(403);
  expect((await t("chat/providers")).status).toBe(403);
  expect((await t("chat/events")).status).toBe(403);
  expect((await t("chat/send", { method: "POST", body: JSON.stringify({ text: "hi" }) })).status).toBe(403);
  expect((await t("comments")).status).toBe(200); // the shared preview/comment experience is intact
  expect((await fetch(c.url("chat"), { headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect((await fetch(c.url("chat"), { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await fetch(c.url("chat/send"), { method: "POST", headers: { origin: "http://evil.example" }, body: JSON.stringify({ text: "hi" }) })).status).toBe(403);
}, 20000);

test("reconnecting with a sequence number replays only missed events", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "hello" });
  await c.until(async () => { const x = await c.snap(); return x.conversation?.status === "idle" ? x : null; });
  const s = await c.snap();
  const read = async (after: number) => {
    const r = await fetch(c.url(`chat/events?after=${after}`));
    const reader = r.body!.getReader(); const dec = new TextDecoder(); let raw = "";
    await Bun.sleep(150); const t = setTimeout(() => reader.cancel(), 10);
    for (;;) { const x = await reader.read().catch(() => ({ done: true } as any)); if (x.done) break; raw += dec.decode(x.value); }
    clearTimeout(t);
    return [...raw.matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]);
  };
  expect((await read(0)).length).toBe(s.seq);
  expect(await read(s.seq - 1)).toEqual([s.seq]);
  expect(await read(s.seq)).toEqual([]);
});
