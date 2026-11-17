// Fake `claude` for tests: --version / `auth status`, and the stream-json framing verified against Claude Code 2.1.326.
// Prompt keywords: "ask" requests approval for `touch fake-claude-approved.txt` (allowed -> writes it, denied -> tool error);
// "question" asks an AskUserQuestion; "slow" streams then waits for an interrupt; "crash" dies mid-stream; "badjson" prints junk first.
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = (o: object) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\n");
if (args[0] === "--version") { console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.326"} (Claude Code)`); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_CLAUDE_LOGIN === "out") { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0);
}
log({ argv: args, cwd: process.cwd(), pid: process.pid });
if (process.env.FAKE_CLAUDE_START === "die") { console.error("boom: cannot start"); process.exit(5); }
const resumed = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
if (resumed && process.env.FAKE_CLAUDE_RESUME === "fail") { console.error(`No conversation found with session ID: ${resumed}`); process.exit(1); }
const uid = Math.random().toString(36).slice(2, 6); // message ids are unique across processes, like real ones
const sid = resumed ?? "sess-" + Math.random().toString(36).slice(2, 8);
const send = (o: object) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mode = args[args.indexOf("--permission-mode") + 1], turns = 0, interrupted = false, answer: ((r: any) => void) | null = null, pendingId = "";
const stream = (event: object, msg: string) => send({ type: "stream_event", event, parent_tool_use_id: null, api_message_id: msg });
async function text(msg: string, parts: string[], index = 0) {
  stream({ type: "message_start", message: { id: msg } }, msg);
  stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, msg);
  for (const p of parts) { await sleep(30); stream({ type: "content_block_delta", index, delta: { type: "text_delta", text: p } }, msg); }
  stream({ type: "content_block_stop", index }, msg);
  send({ type: "assistant", message: { id: msg, role: "assistant", content: [{ type: "text", text: parts.join("") }] } });
}
async function run(prompt: string) {
  const n = ++turns, msg = uid + "msg" + n;
  interrupted = false;
  if (prompt.includes("badjson")) process.stdout.write("this is not json\n{broken\n");
  if (prompt.includes("crash")) { await text(msg, ["Hello"]); process.exit(3); }
  if (/\bask\b/.test(prompt) || prompt.includes("question")) {
    const q = prompt.includes("question");
    const tool = q ? "AskUserQuestion" : "Bash", input = q ? { questions: [{ question: "Which color?" }] } : { command: "touch fake-claude-approved.txt", description: "Create the approved file" };
    const tid = "toolu" + n;
    send({ type: "assistant", message: { id: msg, role: "assistant", content: [{ type: "tool_use", id: tid, name: tool, input }] } });
    pendingId = "req" + n;
    send({ type: "control_request", request_id: pendingId, request: { subtype: "can_use_tool", tool_name: tool, display_name: tool, input, description: "Create the approved file", blocked_path: q ? undefined : process.cwd() + "/fake-claude-approved.txt", tool_use_id: tid } });
    const r: any = await new Promise((ok) => (answer = ok));
    answer = null;
    if (r === "interrupt") { send({ type: "result", subtype: "error_during_execution", is_error: true }); return; }
    const allowed = r?.behavior === "allow";
    if (allowed) writeFileSync("fake-claude-approved.txt", "approved");
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: allowed ? "done" : r?.message ?? "denied", is_error: !allowed }] } });
    await text(msg + "b", [allowed ? "Approved and done" : "Denied, skipped"]);
    send({ type: "result", subtype: "success", is_error: false, result: "ok" });
    return;
  }
  if (prompt.includes("slow")) {
    await text(msg, ["Hello", " from"]);
    while (!interrupted) await sleep(20);
    send({ type: "result", subtype: "error_during_execution", is_error: true });
    return;
  }
  await text(msg, [`Hello from fake Claude (${mode})`, prompt.includes("again") ? " again" : ""]);
  send({ type: "result", subtype: "success", is_error: false, result: "ok" });
}
const dec = new TextDecoder(); let buf = "";
for await (const chunk of process.stdin as any) {
  buf += dec.decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    log(m);
    if (m.type === "control_request") {
      const sub = m.request.subtype, ok = (response: object = {}) => send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
      if (sub === "initialize") { if (process.env.FAKE_CLAUDE_INIT_DELAY) await sleep(Number(process.env.FAKE_CLAUDE_INIT_DELAY)); ok({ commands: [] }); }
      else if (sub === "set_permission_mode") {
        if (m.request.mode === "bypassPermissions" && process.env.FAKE_CLAUDE_NO_BYPASS) send({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Cannot set permission mode to bypassPermissions", error_code: "bypass_not_launched" } });
        else { mode = m.request.mode; ok({ mode }); }
      } else if (sub === "interrupt") {
        if (answer) { send({ type: "control_cancel_request", request_id: pendingId }); answer("interrupt"); } else interrupted = true;
        ok({ still_queued: [] });
      } else send({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "unsupported " + sub } });
    } else if (m.type === "control_response") {
      if (answer && m.response?.request_id === pendingId) answer(m.response.response);
    } else if (m.type === "user") { send({ type: "system", subtype: "init", cwd: process.cwd() }); run(m.message.content); }
  }
}
