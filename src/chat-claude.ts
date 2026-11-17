/**
 * Claude adapter: drives the user's installed `claude` CLI (existing login, no SDK, no API key) over bidirectional stream-json.
 * Tested against Claude Code 2.1.326 with a live session (see README "Chat with a local agent"). Framing relied on:
 *   spawn   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
 *           --permission-prompt-tool stdio --permission-mode default --allow-dangerously-skip-permissions [--resume <id>]
 *           (without `--permission-prompt-tool stdio` the CLI never asks: it denies anything needing approval on its own)
 *   in      {type:"control_request",request_id,request:{subtype:"initialize"}}                 -> {type:"control_response",response:{subtype:"success",request_id}}
 *           {type:"user",message:{role:"user",content:"<text>"}}                               starts a turn
 *           {type:"control_request",request:{subtype:"interrupt"}}                             -> control_response success; pending permissions are withdrawn, turn ends with result/error_during_execution
 *           {type:"control_request",request:{subtype:"set_permission_mode",mode}}              -> success, or error (e.g. bypass not allowed by managed settings)
 *           {type:"control_response",response:{subtype:"success",request_id,response:{behavior:"allow",updatedInput}|{behavior:"deny",message}}}  answers can_use_tool
 *   out     {type:"system",subtype:"init",session_id}; {type:"stream_event",event:{content_block_start|content_block_delta|content_block_stop},api_message_id};
 *           {type:"assistant",message:{id,content:[tool_use...]}}; {type:"user",message:{content:[tool_result...]}};
 *           {type:"control_request",request_id,request:{subtype:"can_use_tool",tool_name,input,description,blocked_path}}; {type:"control_cancel_request",request_id};
 *           {type:"result",subtype:"success"|"error_during_execution"|...,is_error,result}
 */
import { MAX_LINE, atLeast, probe, rec, str, type Item, type ItemKind, type Provider, type ProviderSession, type StartOptions } from "./chat-providers";

const CLAUDE_MIN = "2.1.326";
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const QUESTION_TOOLS = new Set(["AskUserQuestion"]);

const kindOf = (name: string): ItemKind => (name === "Bash" ? "command" : FILE_TOOLS.has(name) ? "file" : "tool");
/** One line saying what a tool call does, for the activity row and for approval prompts. */
function describe(name: string, input: unknown): string {
  const i = rec(input) ?? {};
  const pick = name === "Bash" ? str(i.command) : str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? str(i.pattern) ?? str(i.url) ?? str(i.query) ?? str(i.command);
  if (pick) return pick.slice(0, 500);
  let j = ""; try { j = JSON.stringify(input) ?? ""; } catch { /* unserializable */ }
  return j.length > 2 ? j.slice(0, 300) : name;
}
const resultText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => str(rec(b)?.text) ?? "").filter(Boolean).join("\n") : "";

class ClaudeSession implements ProviderSession {
  sessionId?: string;
  private proc!: ReturnType<typeof Bun.spawn>;
  private next = 1;
  private pending = new Map<string, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private asked = new Map<string, { input: unknown }>(); // pending can_use_tool requests
  private stderr = "";
  private closed = false;
  private mode: "default" | "bypassPermissions" = "default";
  private turn = "";
  private stopping = false;
  private blocks = new Map<string, string>(); // `${message}:${index}` -> streamed text item id
  private text = new Map<string, string>(); // streamed text item id -> text so far
  private streamed = new Set<string>(); // assistant message ids whose text already streamed
  private tools = new Map<string, { kind: ItemKind; title: string }>(); // tool_use ids shown
  private seen = 0;
  constructor(private o: StartOptions, bin: string) {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--allow-dangerously-skip-permissions"];
    if (o.resume) args.push("--resume", o.resume);
    this.proc = Bun.spawn([bin, ...args], { cwd: o.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.read(this.proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
    this.drainErr(this.proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
    this.proc.exited.then((code) => {
      const why = `Claude stopped unexpectedly (exit code ${code})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-300)}` : ""}`;
      for (const p of this.pending.values()) p.fail(new Error(why));
      this.pending.clear();
      if (!this.closed) o.onExit(why);
    });
  }
  async init() {
    await this.control({ subtype: "initialize" }, 20000);
  }
  private write(msg: object) {
    try {
      (this.proc.stdin as { write(s: string): unknown }).write(JSON.stringify(msg) + "\n");
      (this.proc.stdin as { flush?(): unknown }).flush?.();
    } catch { /* process is gone: `exited` reports it */ }
  }
  private control(request: object, ms = 0): Promise<any> {
    const id = "cd" + this.next++;
    return new Promise((ok, fail) => {
      const timer = ms ? setTimeout(() => { this.pending.delete(id); fail(new Error(`Claude did not answer ${(request as any).subtype} within ${ms / 1000}s${this.stderr.trim() ? `: ${this.stderr.trim().slice(-300)}` : ""}`)); }, ms) : null;
      this.pending.set(id, { ok: (v) => (timer && clearTimeout(timer), ok(v)), fail: (e) => (timer && clearTimeout(timer), fail(e)) });
      this.write({ type: "control_request", request_id: id, request });
    });
  }
  private async drainErr(s: ReadableStream<Uint8Array>) {
    for await (const c of s) this.stderr = (this.stderr + new TextDecoder().decode(c)).slice(-2000);
  }
  private async read(s: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = "";
    for await (const c of s) {
      buf += dec.decode(c, { stream: true });
      if (buf.length > MAX_LINE && !buf.includes("\n")) { this.close(); this.o.onExit("Claude sent an oversized protocol message"); return; }
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.handle(line);
      }
    }
  }
  private handle(line: string) {
    let m: Record<string, any> | null = null;
    try { m = rec(JSON.parse(line)); } catch { /* not protocol output */ }
    if (!m) return;
    const emit = this.o.onEvent;
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && str(m.session_id)) this.sessionId = m.session_id;
        return;
      case "control_response": {
        const r = rec(m.response);
        const p = this.pending.get(String(r?.request_id));
        if (!p) return;
        this.pending.delete(String(r?.request_id));
        if (r?.subtype === "error") p.fail(new Error(str(r.error) ?? "Claude rejected the request"));
        else p.ok(r?.response);
        return;
      }
      case "control_request": return this.request(m);
      case "control_cancel_request": {
        const id = String(m.request_id);
        if (this.asked.delete(id)) emit({ type: "approval.resolved", id, outcome: "cancelled" });
        return;
      }
      case "stream_event": return this.stream(m);
      case "assistant": return this.assistant(m);
      case "user": {
        const content = rec(m.message)?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          const r = rec(b);
          const id = str(r?.tool_use_id);
          if (r?.type !== "tool_result" || !id || !this.tools.has(id)) continue;
          emit({ type: "item.completed", item: { id, kind: this.tools.get(id)!.kind, title: this.tools.get(id)!.title, output: resultText(r.content).slice(0, 50_000), status: r.is_error ? "failed" : "completed" } });
        }
        return;
      }
      case "result": {
        const stopped = this.stopping;
        this.turn = ""; this.stopping = false;
        for (const id of [...this.asked.keys()]) { this.asked.delete(id); emit({ type: "approval.resolved", id, outcome: "cancelled" }); }
        if (m.subtype === "success" && !m.is_error) emit({ type: "turn.completed", status: "completed" });
        else if (stopped) emit({ type: "turn.completed", status: "interrupted" });
        else emit({ type: "turn.completed", status: "failed", error: str(m.result) || str(m.error) || `Claude turn failed (${str(m.subtype) ?? "error"})` });
        return;
      }
    }
  }
  private stream(m: Record<string, any>) {
    const ev = rec(m.event);
    const msg = str(m.api_message_id) ?? "m";
    const index = ev?.index;
    const key = `${msg}:${index}`;
    if (ev?.type === "content_block_start" && rec(ev.content_block)?.type === "text") {
      const id = `${key}:${this.seen++}`;
      this.blocks.set(key, id); this.text.set(id, ""); this.streamed.add(msg);
      this.o.onEvent({ type: "item.started", item: { id, kind: "message", text: "" } });
    } else if (ev?.type === "content_block_delta" && rec(ev.delta)?.type === "text_delta") {
      const id = this.blocks.get(key), t = str(rec(ev.delta)?.text);
      if (id && t) { this.text.set(id, (this.text.get(id) ?? "") + t); this.o.onEvent({ type: "item.delta", itemId: id, text: t }); }
    } else if (ev?.type === "content_block_stop") {
      const id = this.blocks.get(key);
      if (id) { this.blocks.delete(key); this.o.onEvent({ type: "item.completed", item: { id, kind: "message", text: this.text.get(id) ?? "", status: "completed" } }); this.text.delete(id); }
    }
  }
  private assistant(m: Record<string, any>) {
    const msg = rec(m.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const b of content) {
      const r = rec(b);
      if (r?.type === "tool_use" && str(r.id) && !this.tools.has(r.id)) {
        const name = str(r.name) ?? "tool";
        const kind = kindOf(name), title = kind === "tool" ? `${name}: ${describe(name, r.input)}` : describe(name, r.input);
        this.tools.set(r.id, { kind, title });
        this.o.onEvent({ type: "item.started", item: { id: r.id, kind, title, status: "inProgress" } satisfies Item });
      } else if (r?.type === "text" && str(r.text) && !this.streamed.has(str(msg?.id) ?? "")) { // streaming was off or skipped this block
        const id = `${str(msg?.id) ?? "a"}:t${this.seen++}`;
        this.o.onEvent({ type: "item.completed", item: { id, kind: "message", text: r.text, status: "completed" } });
      }
    }
  }
  private request(m: Record<string, any>) {
    const id = String(m.request_id);
    const req = rec(m.request) ?? {};
    if (req.subtype === "can_use_tool") {
      const tool = str(req.tool_name) ?? "tool";
      if (QUESTION_TOOLS.has(tool)) { // a question the user would have to answer in the terminal: never approve, tell the agent
        this.reply(id, { behavior: "deny", message: "The user cannot answer questions in this chat. Continue with your best judgment or explain what you need." });
        this.o.onEvent({ type: "item.completed", item: { id: "unsupported-" + id, kind: "tool", title: "Unsupported agent request", output: `Claude asked a question (${tool}) that cdesign chat cannot show. It was declined; use Stop if the agent keeps waiting.`, status: "failed" } });
        return;
      }
      this.asked.set(id, { input: req.input });
      const path = str(req.blocked_path);
      this.o.onEvent({ type: "approval.requested", approval: { id, tool: str(req.display_name) ?? tool, detail: describe(tool, req.input) + (path && !describe(tool, req.input).includes(path) ? ` (${path})` : ""), reason: str(req.description) !== describe(tool, req.input) ? str(req.description) : undefined } });
      return;
    }
    // hooks, MCP bridge, elicitation...: nothing here can answer, and an unanswered request would hang the turn
    this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: `cdesign cannot answer ${str(req.subtype) ?? "this request"}` } });
  }
  private reply(id: string, response: object) {
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }
  respond(id: string, allow: boolean) {
    const a = this.asked.get(id);
    if (!a) return false;
    this.asked.delete(id);
    this.reply(id, allow ? { behavior: "allow", updatedInput: a.input } : { behavior: "deny", message: "The user denied this action in cdesign." });
    this.o.onEvent({ type: "approval.resolved", id, outcome: allow ? "allowed" : "denied" });
    return true;
  }
  async send(text: string, fullAccess: boolean) {
    const want = fullAccess ? "bypassPermissions" : "default";
    if (want !== this.mode) {
      try { await this.control({ subtype: "set_permission_mode", mode: want }, 10000); }
      catch (e) { throw new Error(`Claude would not switch to ${fullAccess ? "Full" : "Normal"} access: ${(e as Error).message}`); }
      this.mode = want;
    }
    this.turn = "t" + this.next++;
    this.stopping = false;
    this.write({ type: "user", message: { role: "user", content: text } });
    this.o.onEvent({ type: "turn.started", turnId: this.turn });
  }
  async interrupt() {
    this.stopping = true;
    for (const id of [...this.asked.keys()]) { this.asked.delete(id); this.o.onEvent({ type: "approval.resolved", id, outcome: "cancelled" }); }
    await this.control({ subtype: "interrupt" }, 10000);
  }
  close() {
    this.closed = true;
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}

export const claude: Provider = {
  id: "claude",
  label: "Claude",
  async discover() {
    const base = { id: "claude", label: "Claude" };
    const bin = Bun.which("claude");
    if (!bin) return { ...base, state: "missing", message: "Claude Code not found on PATH. Install it (https://claude.com/claude-code), then run `claude` once to log in." };
    let version = "";
    try {
      const v = await probe([bin, "--version"]);
      version = v.out.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
      if (v.code || !version) return { ...base, state: "error", message: `Could not read the Claude Code version (\`claude --version\` said: ${v.out.slice(0, 200) || "nothing"}).` };
    } catch (e) {
      return { ...base, state: "error", message: `Could not run Claude Code: ${(e as Error).message}` };
    }
    if (!atLeast(version, CLAUDE_MIN)) return { ...base, version, state: "unsupported", message: `Claude Code ${version} is older than the tested ${CLAUDE_MIN}. Update it (\`claude update\`).` };
    try {
      const l = await probe([bin, "auth", "status"]);
      let loggedIn = l.code === 0;
      try { const j = rec(JSON.parse(l.out)); if (j && j.loggedIn === false) loggedIn = false; } catch { /* plain text output: rely on the exit code */ }
      if (!loggedIn) return { ...base, version, state: "login", message: "Claude Code is not logged in. Run `claude` in a terminal and log in, then reload." };
    } catch (e) {
      return { ...base, version, state: "error", message: `Could not check the Claude login: ${(e as Error).message}` };
    }
    return { ...base, version, state: "ready", message: `Claude Code ${version} ready.` };
  },
  async start(o: StartOptions) {
    const bin = Bun.which("claude");
    if (!bin) throw new Error("Claude Code not found on PATH.");
    const s = new ClaudeSession(o, bin);
    try {
      await s.init();
    } catch (e) {
      s.close();
      throw new Error(`Claude could not start: ${(e as Error).message}`);
    }
    return s;
  },
};
