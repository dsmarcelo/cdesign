// Fake `codex` for tests: answers --version / login status and speaks enough of `app-server` JSON-RPC to drive the chat.
// Prompt keywords: "slow" streams then waits for an interrupt; "ignore" also ignores the interrupt; "crash" dies mid-stream; "html" replies with markup; "edit" writes fake-agent-edit.txt in its cwd.
import { appendFileSync, writeFileSync } from "node:fs";
const [a, b] = process.argv.slice(2);
const log = (o: object) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + "\n");
if (a === "--version") { console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.169.0"}`); process.exit(0); }
if (a === "login" && b === "status") {
  if (process.env.FAKE_CODEX_LOGIN === "out") { console.error("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT"); process.exit(0);
}
if (a !== "app-server") process.exit(2);
if (process.env.FAKE_CODEX_START === "die") { console.error("boom: cannot start"); process.exit(5); }
log({ argv: process.argv.slice(2), cwd: process.cwd() });
const send = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
const note = (method: string, params: object) => send({ method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let turn = 0, interrupted = false, ignore = false;
async function run(text: string, id: string) {
  const msg = { id: "m" + id, type: "agentMessage", text: "" };
  note("turn/started", { threadId: "thr_1", turn: { id, status: "inProgress", items: [] } });
  if (text.includes("edit")) writeFileSync("fake-agent-edit.txt", "edited by fake codex " + Date.now());
  const cmd = { id: "c" + id, type: "commandExecution", command: "ls -la", status: "inProgress", aggregatedOutput: "" };
  note("item/started", { threadId: "thr_1", turnId: id, item: cmd });
  note("item/commandExecution/outputDelta", { threadId: "thr_1", turnId: id, itemId: cmd.id, delta: "total 0\n" });
  note("item/completed", { threadId: "thr_1", turnId: id, item: { ...cmd, status: "completed", aggregatedOutput: "total 0\n", exitCode: 0 } });
  note("item/started", { threadId: "thr_1", turnId: id, item: msg });
  for (const part of text.includes("html") ? ["<img src=x onerror=document.title=1>"] : ["Hello", " from", " fake Codex"]) { await sleep(30); note("item/agentMessage/delta", { threadId: "thr_1", turnId: id, itemId: msg.id, delta: part }); }
  if (text.includes("crash")) process.exit(3);
  if (text.includes("slow")) { ignore = text.includes("ignore"); while (!interrupted) await sleep(20); }
  const status = interrupted ? "interrupted" : "completed";
  note("item/completed", { threadId: "thr_1", turnId: id, item: { ...msg, text: interrupted ? "Hello from" : text.includes("html") ? "<img src=x onerror=document.title=1>" : "Hello from fake Codex" } });
  note("turn/completed", { threadId: "thr_1", turn: { id, status, items: [] } });
}
const dec = new TextDecoder(); let buf = "";
for await (const chunk of process.stdin as any) {
  buf += dec.decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    log(m);
    if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
    else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "thr_1" } } });
    else if (m.method === "turn/start") {
      const id = "t" + ++turn; interrupted = false;
      send({ id: m.id, result: { turn: { id, status: "inProgress", items: [] } } });
      run(m.params.input[0].text, id);
    } else if (m.method === "turn/interrupt") { send({ id: m.id, result: {} }); if (!ignore) interrupted = true; }
  }
}
