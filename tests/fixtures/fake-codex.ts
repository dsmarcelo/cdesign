// Fake `codex` for tests (thread/resume continues the given thread id; FAKE_CODEX_RESUME=fail rejects it): answers --version / login status and speaks enough of `app-server` JSON-RPC to drive the chat.
// Approvals: "ask" requests approval for a command, "filechange" for a file change (accept runs/writes fake-codex-approved.txt, decline marks it declined);
// "question" sends an item/tool/requestUserInput the adapter cannot answer. Prompt keywords: "slow" streams then waits for an interrupt; "ignore" also ignores the interrupt; "crash" dies mid-stream; "html" replies with markup; "edit" writes fake-agent-edit.txt in its cwd.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [a, b] = process.argv.slice(2);
const log = (o: object) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + "\n");
if (a === "--version") { console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.169.0"}`); process.exit(0); }
if (a === "login" && b === "status") {
  if (process.env.FAKE_CODEX_LOGIN === "out") { console.error("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT"); process.exit(0);
}
if (a !== "app-server") process.exit(2);
if (process.env.FAKE_CODEX_START === "die") { console.error("boom: cannot start"); process.exit(5); }
log({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
// FAKE_CODEX_INIT_FAIL=<marker file>: the first process spawned dies after its init delay, later ones succeed
const failInit = !!process.env.FAKE_CODEX_INIT_FAIL && !existsSync(process.env.FAKE_CODEX_INIT_FAIL);
if (failInit) writeFileSync(process.env.FAKE_CODEX_INIT_FAIL!, "x");
const uid = Math.random().toString(36).slice(2, 6); // item ids are unique across processes, like real ones
let thr = "thr_" + Math.random().toString(36).slice(2, 8);
const send = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
const note = (method: string, params: object) => send({ method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let turn = 0, interrupted = false, ignore = false, decide: ((r: any) => void) | null = null;
async function run(text: string, id: string) {
  const msg = { id: "m" + id, type: "agentMessage", text: "" };
  note("turn/started", { threadId: thr, turn: { id, status: "inProgress", items: [] } });
  if (text.includes("edit")) writeFileSync("fake-agent-edit.txt", "edited by fake codex " + Date.now());
  // "design-edit" / "design-revert" swap a heading in design/pages/Page.html, so tests can watch the preview reload (a reversible design edit)
  if (/design-(edit|revert)/.test(text)) { const f = "design/pages/Page.html", html = readFileSync(f, "utf8"); writeFileSync(f, text.includes("design-edit") ? html.replace(">Hi<", ">Edited<") : html.replace(">Edited<", ">Hi<")); }
  const cmd = { id: "c" + id, type: "commandExecution", command: "ls -la", status: "inProgress", aggregatedOutput: "" };
  note("item/started", { threadId: thr, turnId: id, item: cmd });
  const out = text.includes("longtool") ? Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n") + "\n" : "total 0\n";
  note("item/commandExecution/outputDelta", { threadId: thr, turnId: id, itemId: cmd.id, delta: out });
  note("item/completed", { threadId: thr, turnId: id, item: { ...cmd, status: "completed", aggregatedOutput: out, exitCode: 0 } });
  note("item/started", { threadId: thr, turnId: id, item: msg });
  // "markdown": formatting, hostile markup and unsafe links, split so a fence and a link are cut mid-stream
  const parts = text.includes("markdown") ? ["Intro **bold** and `code`.\n\n- one\n- <b>two</b>\n\n```ts\nconst a = '<scr", "ipt>document.title=2</script>';\n```\n\n[bad](javascript:document.title=3) [data](data:text/html,x) [ok](https://example.com/p) <img src=x onerror=document.title=4> ", "<script>document.title=5</script>\n\n" + "W".repeat(400)] : text.includes("html") ? ["<img src=x onerror=document.title=1>"] : ["Hello", " from", " fake Codex"];
  for (const part of parts) { await sleep(30); note("item/agentMessage/delta", { threadId: thr, turnId: id, itemId: msg.id, delta: part }); }
  if (text.includes("crash")) process.exit(3);
  if (/\bask\b/.test(text) || text.includes("filechange") || text.includes("question")) {
    const file = text.includes("filechange"), q = text.includes("question");
    const item = file ? { id: "f" + id, type: "fileChange", changes: [{ path: "src/app.css" }], status: "inProgress" } : { id: "a" + id, type: "commandExecution", command: "touch fake-codex-approved.txt", status: "inProgress", aggregatedOutput: "" };
    if (!q) note("item/started", { threadId: thr, turnId: id, item });
    send(q ? { id: 90, method: "item/tool/requestUserInput", params: { threadId: thr, turnId: id, itemId: "q" + id, isBlocking: true, questions: [] } }
      : { id: 77 + turn, method: file ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval", params: { threadId: thr, turnId: id, itemId: item.id, command: file ? undefined : "touch fake-codex-approved.txt", cwd: process.cwd(), reason: "needs approval" } });
    const r: any = await new Promise((ok) => (decide = ok));
    decide = null;
    const accepted = r?.result?.decision === "accept";
    if (!q && r?.result?.decision === "cancel") { while (!interrupted) await sleep(20); }
    else if (accepted) writeFileSync("fake-codex-approved.txt", "approved");
    if (!q && !interrupted) note("item/completed", { threadId: thr, turnId: id, item: { ...item, status: accepted ? "completed" : "declined" } });
    note("turn/completed", { threadId: thr, turn: { id, status: interrupted ? "interrupted" : "completed", items: [] } });
    return;
  }
  if (text.includes("slow")) { ignore = text.includes("ignore"); while (!interrupted) await sleep(20); }
  const status = interrupted ? "interrupted" : "completed";
  note("item/completed", { threadId: thr, turnId: id, item: { ...msg, text: interrupted ? "Hello from" : parts.join("") } });
  note("turn/completed", { threadId: thr, turn: { id, status, items: [] } });
}
const dec = new TextDecoder(); let buf = "";
for await (const chunk of process.stdin as any) {
  buf += dec.decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    log(m);
    if (m.method === undefined && m.id !== undefined && decide) { decide(m); continue; }
    if (m.method === "initialize") { if (process.env.FAKE_CODEX_INIT_DELAY) await sleep(Number(process.env.FAKE_CODEX_INIT_DELAY)); if (failInit) process.exit(7); send({ id: m.id, result: { userAgent: "fake" } }); }
    else if (m.method === "model/list") {
      if (process.env.FAKE_CODEX_MODELS === "fail") send({ id: m.id, error: { code: -32601, message: "model/list unsupported" } });
      else send({ id: m.id, result: { data: [
        { id: "fake-big", model: "fake-big", displayName: "Fake Big", isDefault: true, hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "medium", description: "" }, { reasoningEffort: "high", description: "" }] },
        { id: "fake-mini", model: "fake-mini", displayName: "Fake Mini", isDefault: false, hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] },
        { id: "fake-secret", model: "fake-secret", displayName: "Hidden", isDefault: false, hidden: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [] },
      ], nextCursor: null } });
    }
    else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: thr } } });
    else if (m.method === "thread/resume") {
      if (process.env.FAKE_CODEX_RESUME === "fail") send({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${m.params.threadId}` } });
      else { thr = m.params.threadId; send({ id: m.id, result: { thread: { id: thr } } }); }
    }
    else if (m.method === "turn/start") {
      const id = `${uid}t${++turn}`; interrupted = false;
      send({ id: m.id, result: { turn: { id, status: "inProgress", items: [] } } });
      run(m.params.input[0].text, id);
    } else if (m.method === "turn/interrupt") { send({ id: m.id, result: {} }); if (!ignore) interrupted = true; }
  }
}
