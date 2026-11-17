import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const cli = join(import.meta.dir, "../src/cli.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const sleep = (ms: number) => Bun.sleep(ms);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Throwaway home + project(s) + fake agents; the daemon can be (re)started and killed on the same state. */
function world(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-hist-"));
  const home = join(dir, "home"), root = join(dir, "project"), bin = join(dir, "bin");
  for (const d of [home, root, bin]) mkdirSync(d);
  for (const [n, f] of [["codex", "fake-codex.ts"], ["claude", "fake-claude.ts"]]) {
    writeFileSync(join(bin, n), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures", f)} "$@"\n`);
    chmodSync(join(bin, n), 0o755);
  }
  const cx = join(dir, "codex.log"), cl = join(dir, "claude.log");
  const daemons: ReturnType<typeof Bun.spawn>[] = [];
  const w = {
    dir, home, root, cx, cl, id: projectId(root), port: 0,
    daemon: null as unknown as ReturnType<typeof Bun.spawn>,
    async start(extra: Record<string, string> = {}) {
      rmSync(join(home, "daemon.json"), { force: true });
      w.daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", FAKE_CODEX_LOG: cx, FAKE_CLAUDE_LOG: cl, ...env, ...extra },
        stdout: "ignore", stderr: "pipe",
      });
      daemons.push(w.daemon);
      w.port = 0;
      for (let i = 0; i < 200 && !w.port; i++) { try { w.port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await sleep(50); } }
      expect(w.port).toBeGreaterThan(0);
    },
    url: (p: string, id = w.id) => `http://127.0.0.1:${w.port}/__cd/${p}${p.includes("?") ? "&" : "?"}project=${id}`,
    post: (p: string, body: unknown, id = w.id) => fetch(w.url(p, id), { method: "POST", body: JSON.stringify(body) }),
    snap: async (c?: string, id = w.id) => (await fetch(w.url("chat" + (c ? `?c=${c}` : ""), id))).json() as Promise<any>,
    until: async <T,>(fn: () => Promise<T> | T, ms = 10000) => {
      const t = Date.now();
      while (Date.now() - t < ms) { const v = await fn(); if (v) return v as NonNullable<T>; await sleep(25); }
      throw new Error("timed out");
    },
    idle: (c?: string, id = w.id) => w.until(async () => { const x = await w.snap(c, id); return x.conversation && !x.busy && x.conversation.status === "idle" ? x : null; }, 15000),
    /** Hard kill: nothing gets a chance to clean up. */
    async crash() { w.daemon.kill("SIGKILL"); await w.daemon.exited; },
    async stop() { w.daemon.kill("SIGTERM"); await w.daemon.exited; },
  };
  cleanups.push(async () => { for (const d of daemons) { d.kill("SIGKILL"); await d.exited; } rmSync(dir, { recursive: true, force: true }); });
  return w;
}
const msgs = (s: any) => s.conversation.items.filter((i: any) => i.kind === "message").map((i: any) => i.text);

test("conversations persist, list, rename and delete; a reopened chat resumes its own provider session after a daemon restart (both providers)", async () => {
  const w = world();
  await w.start();
  const preview = await fetch(w.url("events?tab=t1"));
  let raw = "";
  const rd = preview.body!.getReader();
  (async () => { for (;;) { const r = await rd.read(); if (r.done) return; raw += new TextDecoder().decode(r.value); } })().catch(() => {});

  await w.post("chat/send", { text: "hello from codex chat", provider: "codex" });
  const a = (await w.idle()).conversation;
  await w.post("chat/send", { text: "hello from claude chat", provider: "claude" });
  const b = (await w.idle()).conversation;
  expect(a.id).not.toBe(b.id);
  expect(a.sessionId).toMatch(/^thr_/);
  expect(b.sessionId).toMatch(/^sess-/);
  expect(a.title).toBe("hello from codex chat");

  // saved in gitignored project state, one atomic file per conversation, no stray temp files
  const chats = join(w.root, ".cdesign", "chats");
  expect(readdirSync(chats).sort()).toEqual([a.id + ".json", b.id + ".json"].sort());
  expect(readFileSync(join(w.root, ".cdesign", ".gitignore"), "utf8")).toContain("*");
  expect(JSON.parse(readFileSync(join(chats, a.id + ".json"), "utf8"))).toMatchObject({ provider: "codex", sessionId: a.sessionId, fullAccess: true });

  // rename
  expect((await w.post("chat/rename", { conversationId: a.id, title: "  Landing   page  " })).status).toBe(200);
  expect((await w.post("chat/rename", { conversationId: a.id, title: "  " })).status).toBe(400);
  expect((await w.post("chat/rename", { conversationId: "nope", title: "x" })).status).toBe(404);
  const list = (await w.snap()).conversations;
  expect(list.map((c: any) => c.title).sort()).toEqual(["Landing page", "hello from claude chat"]);

  // persistence of chat output never reloads the preview
  expect(raw).not.toContain("reload");
  await rd.cancel();

  // restart: both chats are still there, and each continues its own session
  await w.stop();
  await w.start();
  expect((await w.snap()).conversations).toHaveLength(2);
  const reopened = await w.snap(a.id);
  expect(reopened.conversation.title).toBe("Landing page");
  expect(msgs(reopened)).toEqual(["Hello from fake Codex"]);
  await w.post("chat/send", { text: "follow up", provider: "codex", conversationId: a.id });
  await w.idle(a.id);
  await w.post("chat/send", { text: "again", conversationId: b.id });
  const after = await w.idle(b.id);
  expect(msgs(after)).toHaveLength(2);
  const resume = jsonl(w.cx).find((l) => l.method === "thread/resume");
  expect(resume.params.threadId).toBe(a.sessionId);
  const starts = jsonl(w.cl).filter((l) => l.argv);
  expect(starts.at(-1).argv[starts.at(-1).argv.indexOf("--resume") + 1]).toBe(b.sessionId);

  // delete only removes cdesign's saved record
  expect((await w.post("chat/delete", { conversationId: a.id })).status).toBe(200);
  expect(existsSync(join(chats, a.id + ".json"))).toBe(false);
  expect(existsSync(join(chats, b.id + ".json"))).toBe(true);
  expect((await w.snap()).conversations.map((c: any) => c.id)).toEqual([b.id]);
  expect((await w.post("chat/delete", { conversationId: a.id })).status).toBe(404);
  expect((await w.post("chat/send", { text: "hi", conversationId: a.id })).status).toBe(404);
}, 60000);

test("a session the provider can no longer resume gives a recoverable error and nothing is resubmitted", async () => {
  for (const [provider, env, log] of [["codex", "FAKE_CODEX_RESUME", "cx"], ["claude", "FAKE_CLAUDE_RESUME", "cl"]] as const) {
    const w = world();
    await w.start();
    await w.post("chat/send", { text: "hello", provider });
    const first = (await w.idle()).conversation;
    await w.stop();
    await w.start({ [env]: "fail" });
    expect((await w.post("chat/send", { text: "continue please", conversationId: first.id })).status).toBe(202);
    const s = await w.idle(first.id);
    expect(s.conversation.error).toContain("could not be resumed");
    expect(s.conversation.error).toContain("Start a new chat");
    const turnsBefore = jsonl(w[log]).filter((l) => l.method === "turn/start" || (l.type === "user")).length;
    await sleep(300);
    expect(jsonl(w[log]).filter((l) => l.method === "turn/start" || l.type === "user")).toHaveLength(turnsBefore); // never retried on a fresh session
    expect(jsonl(w[log]).filter((l) => l.method === "thread/start" || (l.argv?.[0] !== "app-server" && l.argv && !l.argv.includes("--resume")))).toHaveLength(1);
    // the project is not stuck: a new chat still works
    expect((await w.post("chat/send", { text: "fresh start", provider })).status).toBe(202);
    const fresh = await w.idle();
    expect(fresh.conversation.id).not.toBe(first.id);
    expect(fresh.conversation.error).toBeNull();
    await w.stop();
  }
}, 60000);

test("closing every viewer tab mid-turn keeps the work and the daemon alive; reopening restores the snapshot without duplicated text", async () => {
  const w = world({ CDESIGN_IDLE_SECONDS: "1" });
  await w.start();
  const ev = await fetch(w.url("chat/events"));
  const reader = ev.body!.getReader();
  await w.post("chat/send", { text: "slow work", provider: "codex" });
  await w.until(async () => msgs(await w.snap())[0]);
  const pid = jsonl(w.cx).find((l) => l.argv).pid;
  await reader.cancel(); // the last viewer is gone
  await sleep(3500); // > 3x the idle limit
  expect(w.daemon.exitCode).toBeNull();
  expect(alive(pid)).toBe(true);
  // a new viewer gets one consistent snapshot, then only newer events
  const s = await w.snap();
  expect(s.busy).toBe(true);
  expect(s.conversation.status).toBe("running");
  const text = msgs(s)[0];
  const seen: any[] = [];
  const again = await fetch(w.url(`chat/events?after=${s.seq}&epoch=${s.epoch}`));
  const r2 = again.body!.getReader();
  (async () => { let buf = ""; for (;;) { const r = await r2.read(); if (r.done) return; buf += new TextDecoder().decode(r.value); for (const m of buf.matchAll(/data: (.*)\n\n/g)) seen.push(JSON.parse(m[1])); buf = ""; } })().catch(() => {});
  expect((await w.post("chat/stop", {})).status).toBe(202);
  const done = await w.idle();
  expect(text).toContain("Hello");
  expect(msgs(done)).toHaveLength(1); // one message, its text not doubled by the reconnect
  expect(msgs(done)[0].match(/Hello/g)).toHaveLength(1);
  expect(seen.every((e) => e.seq > s.seq)).toBe(true);
  await w.until(() => seen.some((e) => e.type === "turn.completed")); // the reopened stream carried the rest of the turn
  // nothing left to serve: the daemon now exits on its own and takes no agent with it
  await Promise.race([w.daemon.exited, sleep(8000)]);
  expect(w.daemon.exitCode).not.toBeNull();
  await w.until(() => !alive(pid), 5000);
}, 60000);

test("an approval-waiting turn also keeps the daemon alive, survives a reload, and only one tab can answer it", async () => {
  const w = world({ CDESIGN_IDLE_SECONDS: "1" });
  await w.start();
  await w.post("chat/settings", { fullAccess: false });
  expect((await w.post("chat/send", { text: "please ask", provider: "codex", ...{} })).status).toBe(202);
  // new chats take the project default, which is now Normal
  const waiting = await w.until(async () => { const x = await w.snap(); return x.conversation?.approvals.length ? x : null; });
  expect(waiting.conversation.fullAccess).toBe(false);
  await sleep(3000); // no viewer attached for > 2x the idle limit
  expect(w.daemon.exitCode).toBeNull();
  const again = await w.snap(waiting.conversation.id); // "refresh": the exact same pending request comes back
  expect(again.conversation.approvals).toEqual(waiting.conversation.approvals);
  const body = { conversationId: again.conversation.id, turnId: again.conversation.turnId, approvalId: again.conversation.approvals[0].id, decision: "allow" };
  const both = await Promise.all([w.post("chat/approve", body), w.post("chat/approve", body)]);
  expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
  await w.idle();
  expect(readFileSync(join(w.root, "fake-codex-approved.txt"), "utf8")).toBe("approved");
}, 60000);

test("one running turn per project across chats and tabs, other projects stay independent", async () => {
  const w = world();
  await w.start();
  const other = join(w.dir, "other");
  mkdirSync(other);
  const reg = await (await fetch(`http://127.0.0.1:${w.port}/__cd/projects`, { method: "POST", body: JSON.stringify({ root: other }) })).json() as any;
  const racers = await Promise.all([w.post("chat/send", { text: "slow one", provider: "codex" }), w.post("chat/send", { text: "slow two", provider: "claude" })]);
  expect(racers.map((r) => r.status).sort()).toEqual([202, 409]);
  const busy = await w.snap();
  expect(busy.conversations).toHaveLength(1); // the loser created nothing
  const loser = await w.post("chat/send", { text: "another", provider: "codex" });
  const err = await loser.json() as any;
  expect(loser.status).toBe(409);
  expect(err.activeConversationId).toBe(busy.activeId);
  expect(err.error).toContain(busy.conversations[0].title);
  // an independent project is not blocked
  expect((await w.post("chat/send", { text: "hi there", provider: "codex" }, reg.id)).status).toBe(202);
  const o = await w.idle(undefined, reg.id);
  expect(o.conversations).toHaveLength(1);
  expect(o.conversation.items.some((i: any) => i.text === "hi there")).toBe(true);
  expect(busy.conversation.items.some((i: any) => i.text === "hi there")).toBe(false);
  expect(existsSync(join(other, ".cdesign", "chats"))).toBe(true);
  expect(readdirSync(join(w.root, ".cdesign", "chats"))).toHaveLength(1);
  // the running chat cannot be deleted until Stop completes
  expect((await w.post("chat/delete", { conversationId: busy.activeId })).status).toBe(409);
  await w.post("chat/stop", {});
  await w.until(async () => !(await w.snap()).busy);
  expect((await w.post("chat/delete", { conversationId: busy.activeId })).status).toBe(200);
  expect((await w.snap()).conversations).toHaveLength(0);
}, 60000);

test("a daemon killed mid-turn leaves the chat interrupted with partial output, and nothing is retried or replayed", async () => {
  const w = world();
  await w.start();
  await w.post("chat/settings", { fullAccess: false });
  await w.post("chat/send", { text: "slow job", provider: "codex" });
  await w.until(async () => msgs(await w.snap())[0]);
  await sleep(400); // let the debounced save land
  await w.crash();
  await w.start();
  const s = await w.snap();
  expect(s.busy).toBe(false);
  expect(s.conversation.status).toBe("idle");
  expect(s.conversation.error).toContain("Interrupted");
  expect(msgs(s)[0]).toContain("Hello");
  expect(s.conversation.items.some((i: any) => i.status === "inProgress")).toBe(false);
  expect(s.conversation.approvals).toEqual([]);
  await sleep(500);
  expect(jsonl(w.cx).filter((l) => l.method === "turn/start")).toHaveLength(1); // never retried
  // an explicit follow-up resumes the saved thread
  await w.post("chat/send", { text: "go on", conversationId: s.conversation.id });
  const next = await w.idle(s.conversation.id);
  expect(next.conversation.error).toBeNull();
  expect(jsonl(w.cx).find((l) => l.method === "thread/resume").params.threadId).toBe(s.conversation.sessionId);
}, 60000);

test("graceful shutdown mid-turn interrupts the turn, saves it, and kills the managed agent processes", async () => {
  const w = world();
  await w.start();
  await w.post("chat/send", { text: "slow job", provider: "claude" });
  await w.until(async () => msgs(await w.snap())[0]);
  const pid = jsonl(w.cl).find((l) => l.argv).pid;
  expect(alive(pid)).toBe(true);
  await w.stop();
  expect(w.daemon.exitCode).toBe(0);
  await w.until(() => !alive(pid), 5000);
  const file = readdirSync(join(w.root, ".cdesign", "chats"))[0];
  const saved = JSON.parse(readFileSync(join(w.root, ".cdesign", "chats", file), "utf8"));
  expect(saved.status).toBe("idle");
  expect(saved.items.some((i: any) => i.kind === "message")).toBe(true);
  await w.start();
  expect((await w.snap()).conversation.status).toBe("idle");
}, 60000);

test("an idle provider process alone does not keep the daemon alive", async () => {
  const w = world({ CDESIGN_IDLE_SECONDS: "1" });
  await w.start();
  await w.post("chat/send", { text: "hello", provider: "codex" });
  await w.idle();
  const pid = jsonl(w.cx).find((l) => l.argv).pid;
  expect(alive(pid)).toBe(true); // the session process lingers between turns
  await Promise.race([w.daemon.exited, sleep(8000)]);
  expect(w.daemon.exitCode).not.toBeNull();
  await w.until(() => !alive(pid), 5000);
}, 30000);

test("a stale sequence number from an earlier daemon run asks the client to reload instead of mixing streams", async () => {
  const w = world();
  await w.start();
  await w.post("chat/send", { text: "hello", provider: "codex" });
  const s = await w.idle();
  await w.stop();
  await w.start();
  const res = await fetch(w.url(`chat/events?after=${s.seq}&epoch=${s.epoch}`));
  const reader = res.body!.getReader();
  let raw = "";
  while (!raw.includes('"reset"')) { const r = await reader.read(); if (r.done) break; raw += new TextDecoder().decode(r.value); }
  expect(raw).toContain('"reset"');
  await reader.cancel();
}, 30000);
