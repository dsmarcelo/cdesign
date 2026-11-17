import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";
import { parseClaudeHelp } from "../src/chat-claude";

const cli = join(import.meta.dir, "../src/cli.ts");
const codexFixture = join(import.meta.dir, "fixtures/fake-codex.ts");
const claudeFixture = join(import.meta.dir, "fixtures/fake-claude.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** Throwaway home + project + daemon (port 0) with fake `codex` and `claude` first on PATH; `dir` persists across `restart`. */
async function boot(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-settings-"));
  const home = join(dir, "home"), root = join(dir, "project"), bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", home, root, bin]);
  for (const [name, f] of [["codex", codexFixture], ["claude", claudeFixture]]) { writeFileSync(join(bin, name), `#!/bin/sh\nexec ${process.execPath} ${f} "$@"\n`); chmodSync(join(bin, name), 0o755); }
  const logs = { codex: join(dir, "codex.log"), claude: join(dir, "claude.log") };
  const id = projectId(root);
  let daemon: ReturnType<typeof Bun.spawn>, base = "";
  const start = async () => {
    rmSync(join(home, "daemon.json"), { force: true });
    daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", FAKE_CODEX_LOG: logs.codex, FAKE_CLAUDE_LOG: logs.claude, ...env },
      stdout: "ignore", stderr: "pipe",
    });
    let port = 0;
    for (let i = 0; i < 200 && !port; i++) { try { port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await Bun.sleep(50); } }
    expect(port).toBeGreaterThan(0);
    base = `http://127.0.0.1:${port}`;
  };
  await start();
  cleanups.push(async () => { daemon.kill(); await daemon.exited; rmSync(dir, { recursive: true, force: true }); });
  const url = (p: string) => `${base}/__cd/${p}${p.includes("?") ? "&" : "?"}project=${id}`;
  const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
  const snap = async (c = "") => (await fetch(url(`chat?c=${c}`))).json() as Promise<any>;
  const until = async <T,>(fn: () => Promise<T> | T, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(25); }
    throw new Error("timed out");
  };
  const idle = (c = "") => until(async () => { const s = await snap(c); return s.conversation && !s.busy && s.conversation.items.some((i: any) => i.kind === "message") ? s : null; });
  const restart = async () => { daemon.kill("SIGKILL"); await daemon.exited; await start(); };
  const log = (which: "codex" | "claude") => { try { return readFileSync(logs[which], "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { post, snap, until, idle, restart, log, url, root };
}
const providers = async (c: Awaited<ReturnType<typeof boot>>) => (await (await fetch(c.url("chat/providers"))).json()).providers as any[];

test("capabilities: Codex lists what its app-server reports; Claude lists what --help documents; nothing is invented when unavailable", async () => {
  const c = await boot();
  const [codex, claude] = await providers(c);
  expect(codex.capabilities).toMatchObject({ source: "provider", defaultLabel: "Default (Fake Big)", efforts: ["low", "medium", "high"] });
  expect(codex.capabilities.models).toEqual([{ id: "fake-big", label: "Fake Big", efforts: ["low", "medium", "high"] }, { id: "fake-mini", label: "Fake Mini", efforts: ["low"] }]); // hidden model left out
  expect(claude.capabilities.source).toBe("fallback");
  expect(claude.capabilities.models.map((m: any) => m.id)).toEqual(["fable", "opus", "sonnet"]);
  expect(claude.capabilities.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);

  const bad = await boot({ FAKE_CODEX_MODELS: "fail", FAKE_CLAUDE_HELP: "none" });
  const [c2, c3] = await providers(bad);
  expect(c2.capabilities).toMatchObject({ source: "fallback", models: [], efforts: [] });
  expect(c2.capabilities.note).toContain("only its default");
  expect(c3.capabilities).toMatchObject({ source: "fallback", models: [], efforts: [] });
}, 30000);

test("parseClaudeHelp reads aliases and effort levels from wrapped help text", () => {
  expect(parseClaudeHelp("  --effort <level>   Effort level\n     (low, high)\n  --model <model>  Model. Use an\n   alias (e.g.\n 'a', 'b', or 'c') or name.")).toEqual({ aliases: ["a", "b", "c"], efforts: ["low", "high"] });
  expect(parseClaudeHelp("nothing here")).toEqual({ aliases: [], efforts: [] });
});

test("Codex receives the chosen model and effort on the next turn; they persist per conversation and survive a restart", async () => {
  const c = await boot();
  expect((await c.post("chat/send", { text: "hello", provider: "codex", model: "fake-mini", effort: "low" })).status).toBe(202);
  const s = await c.idle();
  expect(s.conversation).toMatchObject({ model: "fake-mini", effort: "low", fullAccess: true });
  const turn1 = c.log("codex").find((l) => l.method === "turn/start");
  expect(turn1.params).toMatchObject({ model: "fake-mini", effort: "low" });

  // change between turns through the settings endpoint; the follow-up sends the new values and nothing else changed
  const r = await c.post("chat/settings", { conversationId: s.conversation.id, model: "fake-big", effort: "high" });
  expect(await r.json()).toMatchObject({ model: "fake-big", effort: "high" });
  await c.post("chat/send", { text: "again", provider: "codex", conversationId: s.conversation.id });
  await c.until(async () => c.log("codex").filter((l) => l.method === "turn/start").length === 2);
  expect(c.log("codex").filter((l) => l.method === "turn/start")[1].params).toMatchObject({ model: "fake-big", effort: "high" });
  await c.idle();

  // a second chat keeps its own settings; the first is not touched by it, and neither is a global "last used"
  await c.post("chat/send", { text: "other", provider: "codex" });
  const other = (await c.until(async () => { const x = await c.snap(); return !x.busy && x.conversations.length === 2 ? x : null; })).conversation;
  expect(other).toMatchObject({ model: null, effort: null });
  const lastTurn = c.log("codex").filter((l) => l.method === "turn/start").at(-1);
  expect(lastTurn.params.model).toBeUndefined();
  expect(lastTurn.params.effort).toBeUndefined();

  await c.restart();
  expect((await c.snap(s.conversation.id)).conversation).toMatchObject({ model: "fake-big", effort: "high" });
  expect((await c.snap(other.id)).conversation).toMatchObject({ model: null, effort: null });
}, 40000);

test("Claude gets --model/--effort as flags; changing them resumes the same session; going back to default drops the flags", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "hello", provider: "claude", model: "opus", effort: "high" });
  const s = await c.idle();
  const spawns = () => c.log("claude").filter((l) => l.argv);
  expect(spawns()[0].argv).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
  expect(spawns()[0].argv).not.toContain("--resume");

  await c.post("chat/settings", { conversationId: s.conversation.id, model: "sonnet", effort: "low" });
  await c.post("chat/send", { text: "again", provider: "claude", conversationId: s.conversation.id });
  await c.until(async () => spawns().length === 2);
  const second = spawns()[1].argv as string[];
  expect(second).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "low", "--resume"]));
  expect(second[second.indexOf("--resume") + 1]).toBe((await c.snap(s.conversation.id)).conversation.sessionId);
  await c.idle();

  await c.post("chat/settings", { conversationId: s.conversation.id, model: null, effort: null });
  await c.post("chat/send", { text: "once more", provider: "claude", conversationId: s.conversation.id });
  await c.until(async () => spawns().length === 3);
  expect(spawns()[2].argv).not.toContain("--model");
  expect(spawns()[2].argv).not.toContain("--effort");
}, 40000);

test("unsupported settings are rejected with the reason and nothing reaches the provider", async () => {
  const c = await boot();
  let r = await c.post("chat/send", { text: "hi", provider: "codex", model: "nope" });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("fake-big, fake-mini");
  r = await c.post("chat/send", { text: "hi", provider: "codex", model: "fake-mini", effort: "high" });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("Supported: low");
  r = await c.post("chat/send", { text: "hi", provider: "codex", effort: "max" });
  expect(r.status).toBe(400);
  expect((await c.snap()).conversations).toEqual([]);
  expect(c.log("codex").filter((l) => l.method === "turn/start")).toHaveLength(0);

  // an agent that could not list its models only offers its default
  const bad = await boot({ FAKE_CODEX_MODELS: "fail" });
  r = await bad.post("chat/send", { text: "hi", provider: "codex", model: "anything" });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("only its default");
  expect((await bad.post("chat/send", { text: "hi", provider: "codex" })).status).toBe(202);

  // settings endpoint: unknown chat, missing chat for model/effort, bad types, bad pairing
  expect((await c.post("chat/settings", { model: "fake-big" })).status).toBe(400);
  expect((await c.post("chat/settings", { conversationId: "nope", model: "fake-big" })).status).toBe(404);
  expect((await c.post("chat/settings", {})).status).toBe(400);
  await c.post("chat/send", { text: "hi", provider: "codex", model: "fake-big", effort: "high" });
  const s = await c.idle();
  expect((await c.post("chat/settings", { conversationId: s.conversation.id, model: 5 })).status).toBe(400);
  r = await c.post("chat/settings", { conversationId: s.conversation.id, model: "fake-mini" }); // effort "high" does not fit the mini model
  expect(r.status).toBe(400);
  expect((await c.snap(s.conversation.id)).conversation).toMatchObject({ model: "fake-big", effort: "high" });
}, 40000);

test("provider stays fixed; model, effort and mode cannot change while a turn is active", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "hi", provider: "codex" });
  const s = await c.idle();
  const id = s.conversation.id;
  const r = await c.post("chat/send", { text: "x", provider: "claude", conversationId: id });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("keeps its agent");

  await c.post("chat/send", { text: "slow one", provider: "codex", conversationId: id });
  await c.until(async () => (await c.snap(id)).busy);
  for (const body of [{ model: "fake-mini" }, { effort: "low" }, { fullAccess: false }]) expect((await c.post("chat/settings", { conversationId: id, ...body })).status).toBe(409);
  expect((await c.post("chat/send", { text: "y", provider: "codex", conversationId: id, model: "fake-mini" })).status).toBe(409);
  expect((await c.snap(id)).conversation).toMatchObject({ model: null, fullAccess: true });
  await c.post("chat/stop", {});
  await c.until(async () => !(await c.snap(id)).busy);
}, 40000);

test("new chats default to Full access and each chat restores its own mode, not the last one used", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "normal chat", provider: "codex", fullAccess: false });
  const a = (await c.idle()).conversation;
  expect(a.fullAccess).toBe(false);
  await c.post("chat/send", { text: "second", provider: "codex" }); // nothing said: Full access, even though the last chat was Normal
  const b = (await c.until(async () => { const x = await c.snap(); return !x.busy && x.conversations.length === 2 ? x : null; })).conversation;
  expect(b.fullAccess).toBe(true);
  await c.post("chat/settings", { conversationId: a.id, fullAccess: true });
  expect((await c.snap(b.id)).conversation.fullAccess).toBe(true);
  expect((await c.snap()).fullAccess).toBe(true);
  await c.post("chat/settings", { conversationId: a.id, fullAccess: false });
  expect((await c.snap()).fullAccess).toBe(true); // a chat's own change leaves the project default alone
  await c.restart();
  expect((await c.snap(a.id)).conversation.fullAccess).toBe(false);
  expect((await c.snap(b.id)).conversation.fullAccess).toBe(true);
}, 40000);

test("status recovery: the last outcome of each chat is saved and an interrupted run is reported after a restart", async () => {
  const c = await boot();
  await c.post("chat/send", { text: "hi", provider: "codex" });
  expect((await c.idle()).conversation.last).toBe("completed");
  await c.post("chat/send", { text: "slow two", provider: "codex" });
  await c.until(async () => { const x = await c.snap(); return x.busy && x.conversation.items.some((i: any) => i.kind === "message" && i.text); });
  await Bun.sleep(300);
  await c.restart();
  const s = await c.snap();
  expect(s.busy).toBe(false);
  expect(s.conversations.find((x: any) => x.id === s.conversation.id).last).toBe("interrupted");
  expect(s.conversation.error).toContain("Interrupted");
  await c.post("chat/send", { text: "hi again", provider: "codex", conversationId: s.conversation.id });
  await c.until(async () => (await c.snap()).conversation.last === "completed");
}, 40000);
