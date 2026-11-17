import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const cli = join(import.meta.dir, "../src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
const claudeFixture = join(import.meta.dir, "fixtures/fake-claude.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

type Env = Record<string, string>;
/** Throwaway home + project + daemon (port 0) with fake `codex` and `claude` first on PATH. */
async function boot(env: Env = {}, withCodex = true) {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-chat-"));
  const home = join(dir, "home"), root = join(dir, "project"), bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", home, root, bin]);
  if (withCodex) {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`);
    chmodSync(join(bin, "codex"), 0o755);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec ${process.execPath} ${claudeFixture} "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
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

test("Stop during a slow startup cancels it: the canceled prompt never runs and the next turn is clean", async () => {
  const c = await boot({ FAKE_CODEX_INIT_DELAY: "1500", CDESIGN_CHAT_STOP_GRACE_MS: "300" });
  expect((await c.post("chat/send", { text: "please edit" })).status).toBe(202);
  expect((await c.post("chat/stop", {})).status).toBe(202);
  const s1 = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" ? x : null; });
  expect(texts(s1, "message")).toHaveLength(0);
  expect((await c.post("chat/send", { text: "hello" })).status).toBe(202);
  const s2 = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" && texts(x, "message").length ? x : null; }, 15000);
  expect(texts(s2, "message")).toHaveLength(1);
  await Bun.sleep(2000); // the canceled startup resolves meanwhile
  expect(existsSync(join(c.root, "fake-agent-edit.txt"))).toBe(false);
  expect(texts(await c.snap(), "message")).toHaveLength(1);
}, 30000);

test("a canceled startup that later fails cannot fail or release a newer running turn", async () => {
  const marker = logFile("fake-codex-failed-once");
  const c = await boot({ FAKE_CODEX_INIT_DELAY: "1500", FAKE_CODEX_INIT_FAIL: marker, CDESIGN_CHAT_STOP_GRACE_MS: "300" });
  expect((await c.post("chat/send", { text: "first" })).status).toBe(202);
  expect((await c.post("chat/stop", {})).status).toBe(202);
  const idle1 = await c.until(async () => { const x = await c.snap(); return x.conversation.status === "idle" ? x : null; });
  // the second turn is still starting when the first startup's late failure arrives
  expect((await c.post("chat/send", { text: "second", conversationId: idle1.conversation.id })).status).toBe(202);
  const s = await c.until(async () => { const x = await c.snap(); return !x.busy && texts(x, "message").length ? x : null; }, 15000);
  expect(s.conversation).toMatchObject({ status: "idle", error: null });
  expect(texts(s, "message")).toHaveLength(1);
}, 30000);

test("Stop and shutdown kill a provider that is still initializing", async () => {
  const log = logFile("fake-codex-pid");
  const c = await boot({ FAKE_CODEX_LOG: log, FAKE_CODEX_INIT_DELAY: "60000", CDESIGN_CHAT_STOP_GRACE_MS: "300" });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await c.post("chat/send", { text: "first" });
  const pid1 = (await c.until(() => jsonl(log).find((l) => l.pid)))?.pid as number;
  expect(alive(pid1)).toBe(true);
  await c.post("chat/stop", {});
  await c.until(() => !alive(pid1), 5000);
  await c.post("chat/send", { text: "second", conversationId: (await c.snap()).conversation.id });
  const pid2 = (await c.until(() => jsonl(log).filter((l) => l.pid).map((l) => l.pid).find((p) => p !== pid1))) as number;
  expect(alive(pid2)).toBe(true);
  c.daemon.kill("SIGTERM");
  await c.until(() => !alive(pid2), 5000);
}, 30000);

// ---------------------------------------------------------------------------------------------------------------------
// Claude support, Normal/Full access and approvals. Fakes mimic the framing verified live against Claude Code 2.1.326 / codex-cli 0.169.0.

const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const logFile = (name: string) => { const f = join(tmpdir(), `${name}-${Math.random().toString(36).slice(2)}.log`); cleanups.push(() => rmSync(f, { force: true })); return f; };
const idle = (c: Awaited<ReturnType<typeof boot>>) => c.until(async () => { const x = await c.snap(); return x.conversation && !x.busy && x.conversation.status === "idle" ? x : null; }, 15000);
const waiting = (c: Awaited<ReturnType<typeof boot>>) => c.until(async () => { const x = await c.snap(); return x.conversation?.approvals?.length ? x : null; }, 15000);
const decide = (c: Awaited<ReturnType<typeof boot>>, s: any, decision: string, over: object = {}) =>
  c.post("chat/approve", { conversationId: s.conversation.id, turnId: s.conversation.turnId, approvalId: s.conversation.approvals[0].id, decision, ...over });

test("providers: Claude reports ready, login, unsupported and missing states without running a turn", async () => {
  const ok = await boot();
  const list = (await (await fetch(ok.url("chat/providers"))).json()).providers;
  expect(list.map((p: any) => p.id)).toEqual(["codex", "claude"]);
  expect(list[1]).toMatchObject({ id: "claude", label: "Claude", state: "ready", version: "2.1.326" });
  const out = await boot({ FAKE_CLAUDE_LOGIN: "out" });
  const o = (await (await fetch(out.url("chat/providers"))).json()).providers[1];
  expect(o.state).toBe("login"); expect(o.message).toContain("log in");
  expect((await (await fetch((await boot({ FAKE_CLAUDE_VERSION: "1.0.0" })).url("chat/providers"))).json()).providers[1].state).toBe("unsupported");
  expect((await (await fetch((await boot({ PATH: "/nonexistent" }, false)).url("chat/providers"))).json()).providers[1].state).toBe("missing");
}, 30000);

test("Claude streams a turn through the installed CLI, keeps context in one session and defaults to Full access", async () => {
  const log = logFile("fake-claude");
  const c = await boot({ FAKE_CLAUDE_LOG: log });
  expect((await c.snap()).fullAccess).toBe(true);
  expect((await c.post("chat/send", { text: "hello there", provider: "claude" })).status).toBe(202);
  const s = await idle(c);
  expect(s.conversation).toMatchObject({ provider: "claude", fullAccess: true, error: null });
  expect(texts(s, "message")[0].text).toBe("Hello from fake Claude (bypassPermissions)");
  expect((await c.post("chat/send", { text: "again", provider: "claude", conversationId: s.conversation.id })).status).toBe(202);
  const s2 = await idle(c);
  expect(texts(s2, "message")).toHaveLength(2);
  const lines = jsonl(log);
  const argv = lines[0].argv as string[];
  expect(argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio"]));
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(lines[0].cwd).toBe(realpath(c.root));
  expect(lines.filter((l) => l.argv)).toHaveLength(1); // one process served both turns
  const order = lines.map((l) => l.request?.subtype ?? l.type);
  expect(order.slice(1, 4)).toEqual(["initialize", "set_permission_mode", "user"]);
  expect(lines.find((l) => l.request?.subtype === "set_permission_mode").request.mode).toBe("bypassPermissions");
}, 30000);

test("choosing another provider starts a new conversation and never reuses the other provider's session", async () => {
  const cl = logFile("fake-claude"), cx = logFile("fake-codex");
  const c = await boot({ FAKE_CLAUDE_LOG: cl, FAKE_CODEX_LOG: cx });
  await c.post("chat/send", { text: "hi", provider: "claude" });
  const a = await idle(c);
  const clash = await c.post("chat/send", { text: "hi", provider: "codex", conversationId: a.conversation.id });
  expect(clash.status).toBe(400); // a conversation keeps its provider...
  expect((await c.snap()).conversation.items).toHaveLength(a.conversation.items.length);
  expect((await c.post("chat/send", { text: "hi", provider: "codex" })).status).toBe(202);
  const b = await idle(c);
  expect(b.conversation.provider).toBe("codex");
  expect(b.conversation.id).not.toBe(a.conversation.id);
  expect(texts(b, "user")).toHaveLength(1); // ...and the old transcript is not carried over
  expect(jsonl(cx).filter((l) => l.method === "turn/start")).toHaveLength(1);
  await c.post("chat/send", { text: "back", provider: "claude" });
  const d = await idle(c);
  expect(d.conversation.id).not.toBe(b.conversation.id);
  expect(jsonl(cl).filter((l) => l.argv)).toHaveLength(2);
  expect(jsonl(cl).filter((l) => l.argv).every((l) => !l.argv.includes("--resume"))).toBe(true);
}, 40000);

test("access mode: saved per project, visible in the snapshot, changeable between turns only", async () => {
  const c = await boot();
  expect((await c.post("chat/settings", { fullAccess: "yes" })).status).toBe(400);
  expect((await (await c.post("chat/settings", { fullAccess: false })).json())).toEqual({ fullAccess: false });
  expect((await c.snap()).fullAccess).toBe(false);
  expect(JSON.parse(readFileSync(join(c.root, ".cdesign", "chat.json"), "utf8"))).toEqual({ fullAccess: false });
  await c.post("chat/send", { text: "slow one", provider: "codex" });
  await c.until(async () => texts(await c.snap(), "message")[0]?.text);
  expect((await c.post("chat/settings", { fullAccess: true })).status).toBe(409); // active turn: rejected
  expect((await c.snap()).fullAccess).toBe(false);
  await c.post("chat/stop", {});
  await idle(c);
  expect((await c.post("chat/settings", { fullAccess: true })).status).toBe(200);
  expect(JSON.parse(readFileSync(join(c.root, ".cdesign", "chat.json"), "utf8"))).toEqual({ fullAccess: true });
}, 30000);

test("Codex Normal mode: approval shows command details, Allow once runs it, Deny skips it, stale and duplicate answers authorize nothing", async () => {
  const log = logFile("fake-codex");
  const c = await boot({ FAKE_CODEX_LOG: log });
  await c.post("chat/settings", { fullAccess: false });
  await c.post("chat/send", { text: "please ask first", provider: "codex" });
  const w = await waiting(c);
  const a = w.conversation.approvals[0];
  expect(a).toMatchObject({ tool: "Run command", reason: "needs approval" });
  expect(a.detail).toContain("touch fake-codex-approved.txt");
  expect(w.busy).toBe(true);
  // wrong conversation / turn / id / decision: refused, nothing runs
  for (const over of [{ conversationId: "other" }, { turnId: "stale" }, { approvalId: "999" }]) expect((await decide(c, w, "allow", over)).status).toBe(409);
  expect((await decide(c, w, "maybe")).status).toBe(400);
  expect(existsSync(join(c.root, "fake-codex-approved.txt"))).toBe(false);
  expect((await decide(c, w, "allow")).status).toBe(202);
  expect((await decide(c, w, "allow")).status).toBe(409); // duplicate
  const done = await idle(c);
  expect(done.conversation.approvals).toEqual([]);
  expect(existsSync(join(c.root, "fake-codex-approved.txt"))).toBe(true);
  rmSync(join(c.root, "fake-codex-approved.txt"));
  expect((await decide(c, w, "allow")).status).toBe(409); // stale: that turn is over
  // deny
  await c.post("chat/send", { text: "please ask again", provider: "codex" });
  const w2 = await waiting(c);
  expect((await decide(c, w2, "deny")).status).toBe(202);
  const d = await idle(c);
  expect(existsSync(join(c.root, "fake-codex-approved.txt"))).toBe(false);
  expect(texts(d, "command").at(-1).status).toBe("declined");
  const responses = jsonl(log).filter((l) => l.method === undefined && l.result?.decision).map((l) => l.result.decision);
  expect(responses).toEqual(["accept", "decline"]);
  // Normal mapping on every turn
  const turns = jsonl(log).filter((l) => l.method === "turn/start");
  expect(turns[0].params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
}, 40000);

test("Codex Full access maps to never-ask + unrestricted sandbox, and a mode change applies to the next turn without a new thread", async () => {
  const log = logFile("fake-codex");
  const c = await boot({ FAKE_CODEX_LOG: log });
  await c.post("chat/send", { text: "hello", provider: "codex" });
  const first = await idle(c);
  await c.post("chat/settings", { fullAccess: false, conversationId: first.conversation.id });
  await c.post("chat/send", { text: "hello again", provider: "codex", conversationId: first.conversation.id });
  const s = await idle(c);
  expect(s.conversation.fullAccess).toBe(false);
  const lines = jsonl(log);
  const turns = lines.filter((l) => l.method === "turn/start");
  expect(turns[0].params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  expect(turns[1].params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
  expect(lines.filter((l) => l.method === "thread/start")).toHaveLength(1);
}, 30000);

test("Codex file-change approvals name the files; questions the adapter cannot answer fail clearly instead of hanging or approving", async () => {
  const c = await boot();
  await c.post("chat/settings", { fullAccess: false });
  await c.post("chat/send", { text: "filechange please", provider: "codex" });
  const w = await waiting(c);
  expect(w.conversation.approvals[0]).toMatchObject({ tool: "Change files", detail: "src/app.css" });
  expect((await decide(c, w, "deny")).status).toBe(202);
  await idle(c);
  await c.post("chat/send", { text: "a question for you", provider: "codex" });
  const s = await idle(c);
  expect(s.conversation.approvals).toEqual([]);
  const u = texts(s, "tool").find((i: any) => i.title === "Unsupported agent request");
  expect(u.output).toContain("cannot provide");
  expect(existsSync(join(c.root, "fake-codex-approved.txt"))).toBe(false);
}, 40000);

test("Claude Normal mode: allow and deny reach the exact request, with tool details shown", async () => {
  const log = logFile("fake-claude");
  const c = await boot({ FAKE_CLAUDE_LOG: log });
  await c.post("chat/settings", { fullAccess: false });
  await c.post("chat/send", { text: "please ask first", provider: "claude" });
  const w = await waiting(c);
  expect(w.conversation.approvals[0]).toMatchObject({ tool: "Bash", detail: expect.stringContaining("touch fake-claude-approved.txt"), reason: "Create the approved file" });
  expect((await decide(c, w, "allow", { approvalId: "nope" })).status).toBe(409);
  expect((await decide(c, w, "allow")).status).toBe(202);
  expect((await decide(c, w, "deny")).status).toBe(409); // already answered: a second answer cannot flip it
  const a = await idle(c);
  expect(existsSync(join(c.root, "fake-claude-approved.txt"))).toBe(true);
  expect(texts(a, "message").at(-1).text).toBe("Approved and done");
  rmSync(join(c.root, "fake-claude-approved.txt"));
  await c.post("chat/send", { text: "please ask again", provider: "claude" });
  const w2 = await waiting(c);
  expect((await decide(c, w2, "deny")).status).toBe(202);
  const d = await idle(c);
  expect(existsSync(join(c.root, "fake-claude-approved.txt"))).toBe(false);
  expect(texts(d, "message").at(-1).text).toBe("Denied, skipped");
  const answers = jsonl(log).filter((l) => l.type === "control_response").map((l) => l.response.response);
  expect(answers[0]).toMatchObject({ behavior: "allow", updatedInput: { command: "touch fake-claude-approved.txt" } });
  expect(answers[1]).toMatchObject({ behavior: "deny" });
  expect(jsonl(log).find((l) => l.argv).argv).toEqual(expect.arrayContaining(["--permission-mode", "default"]));
  expect(jsonl(log).some((l) => l.request?.subtype === "set_permission_mode")).toBe(false); // Normal needs no switch
}, 40000);

test("Claude questions are declined with a visible unsupported-interaction failure, never approved", async () => {
  const log = logFile("fake-claude");
  const c = await boot({ FAKE_CLAUDE_LOG: log });
  await c.post("chat/send", { text: "a question for you", provider: "claude" });
  const s = await idle(c);
  expect(s.conversation.approvals).toEqual([]);
  expect(texts(s, "tool").find((i: any) => i.title === "Unsupported agent request").output).toContain("cannot show");
  expect(jsonl(log).find((l) => l.type === "control_response" && l.response.request_id === "req1").response.response.behavior).toBe("deny");
}, 30000);

test("Stop while waiting for permission withdraws the request, ends the turn, and a late answer authorizes nothing (both providers)", async () => {
  for (const provider of ["codex", "claude"]) {
    const c = await boot();
    await c.post("chat/settings", { fullAccess: false });
    await c.post("chat/send", { text: "please ask first", provider });
    const w = await waiting(c);
    expect((await c.post("chat/stop", { conversationId: w.conversation.id, turnId: w.conversation.turnId })).status).toBe(202);
    const s = await idle(c);
    expect(s.conversation.approvals).toEqual([]);
    expect(s.conversation.error).toBeNull();
    expect((await decide(c, w, "allow")).status).toBe(409);
    await Bun.sleep(200);
    expect(existsSync(join(c.root, `fake-${provider}-approved.txt`))).toBe(false);
    expect((await c.post("chat/send", { text: "hello again", provider })).status).toBe(202); // recoverable
    expect((await idle(c)).conversation.error).toBeNull();
  }
}, 60000);

test("Claude: refused Full access, a provider that dies, junk output and a failed startup are recoverable; the session is resumed", async () => {
  const log = logFile("fake-claude");
  const c = await boot({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_NO_BYPASS: "1" });
  await c.post("chat/send", { text: "hello", provider: "claude" }); // Full is the default but this CLI refuses it
  const f = await idle(c);
  expect(f.conversation.error).toContain("would not switch to Full access");
  await c.post("chat/settings", { fullAccess: false, conversationId: f.conversation.id });
  await c.post("chat/send", { text: "badjson crash now", provider: "claude", conversationId: f.conversation.id });
  const crashed = await idle(c);
  expect(crashed.conversation.error).toContain("exit code 3");
  expect(texts(crashed, "message").at(-1).text).toBe("Hello");
  await c.post("chat/send", { text: "hello again", provider: "claude", conversationId: f.conversation.id });
  const ok = await idle(c);
  expect(ok.conversation.error).toBeNull();
  const starts = jsonl(log).filter((l) => l.argv);
  expect(starts.at(-1).argv).toContain("--resume");
  expect(starts.at(-1).argv[starts.at(-1).argv.indexOf("--resume") + 1]).toMatch(/^sess-/);

  const bad = await boot({ FAKE_CLAUDE_START: "die" });
  await bad.post("chat/send", { text: "hi", provider: "claude" });
  const b = await idle(bad);
  expect(b.conversation.error).toContain("boom: cannot start");
}, 60000);

test("access and approval controls are local-only like the rest of chat", async () => {
  const free = Bun.serve({ port: 0, fetch: () => new Response("") }), tport = free.port; free.stop(true);
  const c = await boot();
  writeFileSync(join(c.dir, "bin", "cloudflared"), "#!/bin/sh\necho 'Registered tunnel connection' >&2\nexec sleep 300\n");
  chmodSync(join(c.dir, "bin", "cloudflared"), 0o755);
  writeFileSync(join(c.home, "tunnel.json"), JSON.stringify({ provider: "cloudflare", domain: "x.example.com", token: "t", port: tport }));
  expect((await fetch(c.base + "/__cd/tunnel", { method: "POST" })).ok).toBe(true);
  const t = (p: string) => fetch(`http://127.0.0.1:${tport}/__cd/${p}`, { method: "POST", body: "{}", headers: { host: "x.example.com" } });
  expect((await t("chat/approve")).status).toBe(403);
  expect((await t("chat/settings")).status).toBe(403);
  expect((await fetch(c.url("chat/settings"), { method: "POST", headers: { origin: "http://evil.example" }, body: JSON.stringify({ fullAccess: false }) })).status).toBe(403);
  expect((await c.snap()).fullAccess).toBe(true);
}, 30000);
