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
import { MAX_LINE, atLeast, probe, rec, str, type Capabilities, type Item, type ItemKind, type Provider, type ProviderSession, type SlashCommand, type StartOptions, type TurnSettings } from "./chat-providers";

const CLAUDE_MIN = "2.1.326";
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const QUESTION_TOOLS = new Set(["AskUserQuestion"]);

/**
 * Commands Claude Code runs itself, with no model turn (checked against 2.1.329: each answers with a synthetic message and a result of 0 turns).
 * They reach the agent exactly as typed: design context or comments around `/compact` would become its summarization instructions.
 */
const LOCAL = new Set(["compact", "clear", "context", "usage", "rename", "recap", "reload-skills"]);
/** Commands that would fight cdesign (model/effort belong to the picker, `config` can lift permissions) or only make sense in a terminal. */
const HIDDEN = new Set(["model", "effort", "fast", "config", "mcp", "agents", "list-agents", "output-style", "autocompact", "heapdump", "doctor", "color", "focus", "reload-plugins", "login", "logout", "exit", "quit"]);
const slashName = (text: string) => text.match(/^\/([A-Za-z0-9_][A-Za-z0-9_:.-]*)(?=\s|$)/)?.[1];
const tokens = (n: unknown) => (typeof n === "number" ? (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n)) : "?");

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
    if (o.model) args.push("--model", o.model);
    if (o.effort) args.push("--effort", o.effort);
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
        else if (m.subtype === "status") this.compaction(m);
        else if (m.subtype === "compact_boundary") {
          const c = rec(m.compact_metadata);
          this.compacting(`Conversation compacted (${tokens(c?.pre_tokens)} → ${tokens(c?.post_tokens)} tokens).`, "completed");
        }
        return;
      case "conversation_reset": // /clear: the next message starts empty, under a new session id that the following init announces
        emit({ type: "item.completed", item: { id: "reset-" + this.seen++, kind: "notice", text: "Context cleared. Claude starts the next message with an empty context.", status: "completed" } });
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
        if (typeof content === "string") return this.localOutput(content);
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
  private note = ""; // id of the compaction notice that is still running
  /** `/compact` and automatic compaction report `status: "compacting"` first, then a boundary; a failed one ends with a null status and a non-success result. */
  private compaction(m: Record<string, any>) {
    if (m.status === "compacting" && !this.note) {
      this.note = "compact-" + this.seen++;
      this.o.onEvent({ type: "item.started", item: { id: this.note, kind: "notice", text: "Compacting the conversation…", status: "inProgress" } });
    } else if (m.status === null && this.note && str(m.compact_result) && m.compact_result !== "success") {
      this.compacting(`Compaction failed (${m.compact_result}).`, "failed");
    }
  }
  private compacting(text: string, status: "completed" | "failed") {
    const id = this.note || "compact-" + this.seen++; // an auto-compaction may report only its boundary
    this.note = "";
    this.o.onEvent({ type: "item.completed", item: { id, kind: "notice", text, status } });
  }
  /** Output of a local command arrives as a user message wrapped in `<local-command-stdout>`; "Compacted" only repeats the compaction notice. */
  private localOutput(raw: string) {
    const m = raw.match(/^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>\s*$/);
    const text = m?.[2].trim();
    if (!m || !text || text === "Compacted") return;
    this.o.onEvent({ type: "item.completed", item: { id: "local-" + this.seen++, kind: m[1] === "stderr" ? "notice" : "message", text, status: "completed" } });
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
  async send(text: string, fullAccess: boolean, _settings: TurnSettings) {
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

/** Claude Code has no model-listing command; what `claude --help` documents (model aliases, effort levels) is the supported set. */
export function parseClaudeHelp(help: string): { aliases: string[]; efforts: string[] } {
  const flat = help.replace(/\s+/g, " ");
  const alias = flat.match(/--model <model> .*?\(e\.g\. ((?:'[^']+'(?:, | or |, or )?)+)\)/)?.[1] ?? "";
  const effort = flat.match(/--effort <level> .*?\(([a-z]+(?:, [a-z]+)*)\)/)?.[1] ?? "";
  return { aliases: [...alias.matchAll(/'([^']+)'/g)].map((m) => m[1]), efforts: effort ? effort.split(", ") : [] };
}

/**
 * What a `/` can start in this install: Claude Code lists its slash commands and skills (user, project and plugin ones) in the answer to `initialize`.
 * It runs in the project folder so project skills are listed. A short-lived process asks and is killed; no message is sent, so it costs no model call.
 */
async function listCommands(root: string): Promise<SlashCommand[]> {
  const bin = Bun.which("claude");
  if (!bin) return [];
  const proc = Bun.spawn([bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "default"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "ignore" }); // project skills live under the project
  const stdin = proc.stdin as { write(s: string): unknown; flush?(): unknown };
  stdin.write(JSON.stringify({ type: "control_request", request_id: "cdcmds", request: { subtype: "initialize" } }) + "\n"); stdin.flush?.();
  const timer = setTimeout(() => proc.kill(), 15000);
  let found: unknown[] = [];
  try {
    const dec = new TextDecoder();
    let buf = "";
    read: for await (const c of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(c, { stream: true });
      if (buf.length > MAX_LINE && !buf.includes("\n")) break;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: Record<string, any> | null = null;
        try { m = rec(JSON.parse(line)); } catch { /* not protocol output */ }
        const r = m?.type === "control_response" ? rec(m.response) : null;
        if (r?.request_id === "cdcmds") { if (Array.isArray(rec(r.response)?.commands)) found = rec(r.response)!.commands as unknown[]; break read; }
      }
    }
  } finally { clearTimeout(timer); proc.kill(); }
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const c of found) {
    const r = rec(c), name = str(r?.name);
    if (!name || name.startsWith("__") || HIDDEN.has(name) || seen.has(name) || !/^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/.test(name)) continue;
    const description = (str(r?.description) ?? "").replace(/\s*\((?:user|project|plugin|builtin)\)$/, "");
    if (/sessions only$/.test(description)) continue; // launched by a server/workflow, not typed
    seen.add(name);
    out.push({ name, description: description.slice(0, 400), hint: (str(r?.argumentHint) ?? "").slice(0, 100), local: LOCAL.has(name) });
  }
  return out.sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
}

export const claude: Provider = {
  id: "claude",
  label: "Claude",
  perTurn: false, // --model/--effort are process flags: a change resumes the saved session in a new process
  isLocal: (text) => LOCAL.has(slashName(text) ?? ""),
  commands: listCommands,
  async capabilities() {
    const none = (note: string): Capabilities => ({ source: "fallback", note, models: [], efforts: [], defaultLabel: "Default" });
    const bin = Bun.which("claude");
    if (!bin) return none("Claude Code is not installed, so its models are unknown.");
    try {
      const h = await probe([bin, "--help"]);
      const { aliases, efforts } = parseClaudeHelp(h.out);
      if (!aliases.length && !efforts.length) return none("Claude Code does not list its models; only its default can be used.");
      return {
        source: "fallback",
        note: "Claude Code does not list its models. These are the aliases and effort levels its --help documents; an unsupported pairing is reported by Claude when the turn starts.",
        models: aliases.map((a) => ({ id: a, label: a, efforts })),
        efforts,
        defaultLabel: "Default",
      };
    } catch (e) {
      return none(`Could not read Claude Code's help (${(e as Error).message.slice(0, 120)}); only its default can be used.`);
    }
  },
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
    o.onSpawn?.(s);
    try {
      await s.init();
    } catch (e) {
      s.close();
      throw new Error(`Claude could not start: ${(e as Error).message}`);
    }
    return s;
  },
};
