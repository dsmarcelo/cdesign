/**
 * Provider contract for the desktop chat, plus the Codex adapter (`codex app-server` over stdio JSON-RPC)
 * and the Claude adapter (the installed `claude` CLI in bidirectional stream-json mode: see ./chat-claude).
 * Codex tested against codex-cli 0.169.0 (protocol generated with `codex app-server generate-json-schema`).
 * Capabilities relied on: `initialize`/`initialized`, `thread/start` (cwd, approvalPolicy, sandbox), `turn/start` (per-turn approvalPolicy/sandboxPolicy),
 * `turn/interrupt`, notifications `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`,
 * `item/commandExecution/outputDelta`, `serverRequest/resolved`, and the server requests `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
 */

export type ItemKind = "user" | "message" | "command" | "file" | "tool";
export type Item = { id: string; kind: ItemKind; title?: string; text?: string; output?: string; status?: string; /** design context sent with a user message (see chat-context.ts) */ context?: unknown[] };
export type TurnStatus = "completed" | "interrupted" | "failed";
/** A pending permission request. `id` is the provider's own request id, unique within one session. */
export type Approval = { id: string; tool: string; detail: string; reason?: string };
export type ApprovalOutcome = "allowed" | "denied" | "cancelled";
export type ProviderEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "item.started"; item: Item }
  | { type: "item.delta"; itemId: string; text: string }
  | { type: "item.completed"; item: Item }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; id: string; outcome: ApprovalOutcome }
  | { type: "turn.completed"; status: TurnStatus; error?: string };

export type ProviderInfo = {
  id: string;
  label: string;
  state: "ready" | "missing" | "unsupported" | "login" | "error";
  message: string;
  version?: string;
};
/** One selectable model. `efforts` are the reasoning-effort values it accepts (absent: the provider does not say per model). */
export type ModelInfo = { id: string; label: string; efforts?: string[] };
/**
 * What a provider lets the user choose. `source` is "provider" when the lists came from the installed agent itself and "fallback" when they
 * are only what its documentation/help text names (or nothing, in which case only the provider default can be used). Lists are never invented.
 */
export type Capabilities = {
  source: "provider" | "fallback";
  note: string;
  models: ModelInfo[];
  /** Effort values valid with the provider's default model. */
  efforts: string[];
  /** Label for "no override" (e.g. the default model's name). */
  defaultLabel: string;
};
/** `undefined` means the provider default. */
export type TurnSettings = { model?: string; effort?: string };
export type StartOptions = {
  root: string;
  fullAccess: boolean;
  model?: string;
  effort?: string;
  /** Provider session to continue after its process died (only providers that can resume use it). */
  resume?: string;
  onEvent: (e: ProviderEvent) => void;
  onExit: (message: string) => void;
};
export interface ProviderSession {
  /** Provider-side session id once known, so a dead process can be resumed with the same context. */
  sessionId?: string;
  /** Resolves once the provider accepted the turn; events keep arriving through `onEvent`. `fullAccess` applies to this turn only. */
  send(text: string, fullAccess: boolean, settings: TurnSettings): Promise<void>;
  /** Answers one pending approval; false when `id` is not pending (stale, duplicate or cancelled), in which case nothing is authorized. */
  respond(id: string, allow: boolean): boolean;
  /** Withdraws pending approvals, then interrupts the turn. */
  interrupt(): Promise<void>;
  close(): void;
}
export interface Provider {
  id: string;
  label: string;
  /** True when model/effort can change on the next turn of a live session; otherwise the session is restarted (resumed) to apply them. */
  perTurn: boolean;
  discover(): Promise<ProviderInfo>;
  capabilities(): Promise<Capabilities>;
  start(o: StartOptions): Promise<ProviderSession>;
}

export const CODEX_MIN = "0.169.0";
const versionParts = (v: string) => v.split(".").map(Number);
export const atLeast = (v: string, min: string) => {
  const a = versionParts(v), b = versionParts(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Runs a short command (never a model turn) and returns its output; a hung binary is killed after `ms`. */
export async function probe(cmd: string[], ms = 8000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), ms);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    return { code: await proc.exited, out: (out + err).trim() };
  } finally {
    clearTimeout(timer);
  }
}

export const MAX_LINE = 8 * 1024 * 1024;
export const rec = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
export const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Maps a Codex thread item to the shared shape; items the chat does not display return null. */
function mapItem(raw: unknown): Item | null {
  const it = rec(raw);
  const id = str(it?.id);
  if (!it || !id) return null;
  const status = str(it.status);
  switch (it.type) {
    case "agentMessage": return { id, kind: "message", text: str(it.text) ?? "" };
    case "commandExecution": return { id, kind: "command", title: String(it.command ?? "command"), output: str(it.aggregatedOutput) ?? "", status };
    case "fileChange": return { id, kind: "file", title: (Array.isArray(it.changes) ? it.changes.map((c) => str(rec(c)?.path)).filter(Boolean).join(", ") : "") || "file changes", status };
    case "mcpToolCall": return { id, kind: "tool", title: `${str(it.server) ?? "mcp"}.${str(it.tool) ?? "tool"}`, status };
    case "dynamicToolCall": return { id, kind: "tool", title: str(it.tool) ?? "tool", status };
    case "webSearch": return { id, kind: "tool", title: `web search: ${str(it.query) ?? ""}`, status };
    default: return null;
  }
}

class CodexSession implements ProviderSession {
  sessionId?: string;
  private proc!: ReturnType<typeof Bun.spawn>;
  private next = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private stderr = "";
  private closed = false;
  private thread = "";
  private turn = "";
  private asked = new Map<string, { rpcId: unknown }>(); // pending approvals, keyed by String(request id)
  private titles = new Map<string, string>(); // itemId -> what the item is, to describe file-change approvals
  constructor(private o: StartOptions, bin: string) {
    this.proc = Bun.spawn([bin, "app-server"], { cwd: o.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.read(this.proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
    this.drainErr(this.proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
    this.proc.exited.then((code) => {
      const why = `Codex stopped unexpectedly (exit code ${code})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-300)}` : ""}`;
      for (const p of this.pending.values()) p.fail(new Error(why));
      this.pending.clear();
      if (!this.closed) o.onExit(why);
    });
  }
  async handshake() {
    await this.call("initialize", { clientInfo: { name: "cdesign", title: "cdesign", version: "1" } }, 15000);
    this.write({ method: "initialized" });
  }
  /** `model/list`, following pagination (bounded). */
  async models(): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: any = await this.call("model/list", cursor ? { cursor } : {}, 15000);
      if (Array.isArray(r?.data)) out.push(...r.data);
      cursor = str(r?.nextCursor) ?? null;
      if (!cursor) break;
    }
    return out;
  }
  async init() {
    await this.handshake();
    const policy = { cwd: this.o.root, ...(this.o.model ? { model: this.o.model } : {}), approvalPolicy: this.o.fullAccess ? "never" : "on-request", sandbox: this.o.fullAccess ? "danger-full-access" : "workspace-write" };
    // a saved conversation continues its own thread (never "the latest one")
    const r = this.o.resume ? await this.call("thread/resume", { threadId: this.o.resume, ...policy }, 15000) : await this.call("thread/start", policy, 15000);
    // (turn/start repeats the policy per turn, so a mode change between turns needs no new thread)
    const id = str(rec(r?.thread)?.id);
    if (!id) throw new Error("Codex returned no thread id (unsupported app-server protocol)");
    this.thread = id;
    this.sessionId = id;
  }
  private write(msg: object) {
    try {
      (this.proc.stdin as { write(s: string): unknown; flush?(): unknown }).write(JSON.stringify(msg) + "\n");
      (this.proc.stdin as { flush?(): unknown }).flush?.();
    } catch { /* process is gone: `exited` reports it */ }
  }
  private call(method: string, params: object, ms = 0): Promise<any> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      const timer = ms ? setTimeout(() => { this.pending.delete(id); fail(new Error(`Codex did not answer ${method} within ${ms / 1000}s${this.stderr.trim() ? `: ${this.stderr.trim().slice(-300)}` : ""}`)); }, ms) : null;
      this.pending.set(id, { ok: (v) => (timer && clearTimeout(timer), ok(v)), fail: (e) => (timer && clearTimeout(timer), fail(e)) });
      this.write({ id, method, params });
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
      if (buf.length > MAX_LINE && !buf.includes("\n")) { this.close(); this.o.onExit("Codex sent an oversized protocol message"); return; }
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
    const method = str(m.method);
    if (method === undefined) { // response to one of our requests
      const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.fail(new Error(str(rec(m.error)?.message) ?? "Codex request failed"));
      else p.ok(m.result);
      return;
    }
    const params = rec(m.params) ?? {};
    if (m.id !== undefined) { this.serverRequest(m.id, method, params); return; }
    if (method === "serverRequest/resolved") { // the provider settled it itself (turn ended, interrupted, answered elsewhere)
      const key = String(params.requestId);
      if (this.asked.delete(key)) this.o.onEvent({ type: "approval.resolved", id: key, outcome: "cancelled" });
      return;
    }
    if (params.threadId !== undefined && params.threadId !== this.thread) return;
    const emit = this.o.onEvent;
    switch (method) {
      case "turn/started": {
        const id = str(rec(params.turn)?.id);
        if (id) { this.turn = id; emit({ type: "turn.started", turnId: id }); }
        break;
      }
      case "turn/completed": {
        const t = rec(params.turn);
        const s = str(t?.status);
        this.turn = "";
        emit({ type: "turn.completed", status: s === "interrupted" ? "interrupted" : s === "failed" ? "failed" : "completed", error: s === "failed" ? str(rec(t?.error)?.message) ?? "Codex turn failed" : undefined });
        break;
      }
      case "item/started": case "item/completed": {
        const item = mapItem(params.item);
        if (item?.title) this.titles.set(item.id, item.title);
        if (item) emit({ type: method === "item/started" ? "item.started" : "item.completed", item });
        break;
      }
      case "item/agentMessage/delta": case "item/commandExecution/outputDelta": {
        const id = str(params.itemId), text = str(params.delta);
        if (id && text) emit({ type: "item.delta", itemId: id, text });
        break;
      }
    }
  }
  private serverRequest(rpcId: unknown, method: string, params: Record<string, any>) {
    const key = String(rpcId);
    const known = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
    if (known && (params.threadId === undefined || params.threadId === this.thread) && (params.turnId === undefined || !this.turn || params.turnId === this.turn)) {
      const cmd = method.startsWith("item/commandExecution");
      const itemId = str(params.itemId) ?? "";
      const detail = cmd ? [str(params.command), str(params.cwd) ? `in ${str(params.cwd)}` : ""].filter(Boolean).join(" ") || "command" : this.titles.get(itemId) ?? str(params.grantRoot) ?? "file changes";
      this.asked.set(key, { rpcId });
      this.o.onEvent({ type: "approval.requested", approval: { id: key, tool: cmd ? "Run command" : "Change files", detail, reason: str(params.reason) } });
      return;
    }
    // anything else (user questions, permission grants, MCP prompts, legacy approvals) cannot be answered here and must not hang the turn
    this.write({ id: rpcId, error: { code: -32601, message: `cdesign cannot answer ${method}` } });
    if (method.includes("requestUserInput") || method.includes("elicitation") || method.includes("requestApproval") || method.includes("Approval")) {
      this.o.onEvent({ type: "item.completed", item: { id: "unsupported-" + key, kind: "tool", title: "Unsupported agent request", output: `Codex asked for input cdesign cannot provide (${method}). It was declined; use Stop if the agent keeps waiting.`, status: "failed" } });
    }
  }
  respond(id: string, allow: boolean) {
    const a = this.asked.get(id);
    if (!a) return false;
    this.asked.delete(id);
    this.write({ id: a.rpcId, result: { decision: allow ? "accept" : "decline" } });
    this.o.onEvent({ type: "approval.resolved", id, outcome: allow ? "allowed" : "denied" });
    return true;
  }
  async send(text: string, fullAccess: boolean, settings: TurnSettings) {
    const r = await this.call("turn/start", {
      threadId: this.thread,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: fullAccess ? "never" : "on-request",
      sandboxPolicy: fullAccess ? { type: "dangerFullAccess" } : { type: "workspaceWrite" },
    }, 20000);
    const id = str(rec(r?.turn)?.id);
    if (id && !this.turn) { this.turn = id; this.o.onEvent({ type: "turn.started", turnId: id }); }
  }
  async interrupt() {
    for (const [id, a] of [...this.asked]) { // a turn blocked on a decision only ends once the request is withdrawn
      this.asked.delete(id);
      this.write({ id: a.rpcId, result: { decision: "cancel" } });
      this.o.onEvent({ type: "approval.resolved", id, outcome: "cancelled" });
    }
    if (!this.turn) return;
    await this.call("turn/interrupt", { threadId: this.thread, turnId: this.turn }, 10000);
  }
  close() {
    this.closed = true;
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}

export const codex: Provider = {
  id: "codex",
  label: "Codex",
  perTurn: true,
  /** Asks the installed app-server (`model/list`); a failure is reported honestly as "provider default only". */
  async capabilities() {
    const none = (note: string): Capabilities => ({ source: "fallback", note, models: [], efforts: [], defaultLabel: "Default" });
    const bin = Bun.which("codex");
    if (!bin) return none("Codex is not installed, so its models are unknown.");
    const s = new CodexSession({ root: process.cwd(), fullAccess: true, onEvent() {}, onExit() {} }, bin);
    try {
      await s.handshake();
      const list = (await s.models()).map(rec).filter((m): m is Record<string, any> => !!m && !m.hidden && !!(str(m.model) ?? str(m.id)));
      if (!list.length) return none("Codex reported no models; only its default can be used.");
      const efforts = (m: Record<string, any>) => (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: unknown) => str(rec(e)?.reasoningEffort)).filter((e: unknown): e is string => !!e) : []);
      const models = list.map((m) => ({ id: (str(m.model) ?? str(m.id))!, label: str(m.displayName) ?? (str(m.model) ?? str(m.id))!, efforts: efforts(m) }));
      const def = list.find((m) => m.isDefault) ?? list[0];
      return { source: "provider", note: "Models and reasoning efforts reported by Codex.", models, efforts: efforts(def), defaultLabel: `Default (${str(def.displayName) ?? str(def.model) ?? "Codex"})` };
    } catch (e) {
      return none(`Codex did not list its models (${(e as Error).message.slice(0, 160)}); only its default can be used.`);
    } finally {
      s.close();
    }
  },
  async discover() {
    const base = { id: "codex", label: "Codex" };
    const bin = Bun.which("codex");
    if (!bin) return { ...base, state: "missing", message: "Codex CLI not found on PATH. Install it (npm i -g @openai/codex), then run `codex login`." };
    let version = "";
    try {
      const v = await probe([bin, "--version"]);
      version = v.out.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
      if (v.code || !version) return { ...base, state: "error", message: `Could not read the Codex version (\`codex --version\` said: ${v.out.slice(0, 200) || "nothing"}).` };
    } catch (e) {
      return { ...base, state: "error", message: `Could not run Codex: ${(e as Error).message}` };
    }
    if (!atLeast(version, CODEX_MIN)) return { ...base, version, state: "unsupported", message: `Codex ${version} is older than the tested ${CODEX_MIN}. Update it (npm i -g @openai/codex).` };
    try {
      const l = await probe([bin, "login", "status"]);
      if (l.code) return { ...base, version, state: "login", message: "Codex is not logged in. Run `codex login` in a terminal, then reload." };
    } catch (e) {
      return { ...base, version, state: "error", message: `Could not check the Codex login: ${(e as Error).message}` };
    }
    return { ...base, version, state: "ready", message: `Codex ${version} ready.` };
  },
  async start(o) {
    const bin = Bun.which("codex");
    if (!bin) throw new Error("Codex CLI not found on PATH.");
    const s = new CodexSession(o, bin);
    try {
      await s.init();
    } catch (e) {
      s.close();
      throw new Error(`Codex could not start: ${(e as Error).message}`);
    }
    return s;
  },
};
