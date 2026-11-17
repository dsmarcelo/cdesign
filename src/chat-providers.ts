/**
 * Provider contract for the desktop chat, plus the Codex adapter (`codex app-server` over stdio JSON-RPC).
 * Tested against codex-cli 0.169.0 (protocol generated with `codex app-server generate-json-schema`).
 * Capabilities relied on: `initialize`/`initialized`, `thread/start` (cwd, approvalPolicy, sandbox), `turn/start`, `turn/interrupt`,
 * notifications `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`.
 */

export type ItemKind = "user" | "message" | "command" | "file" | "tool";
export type Item = { id: string; kind: ItemKind; title?: string; text?: string; output?: string; status?: string };
export type TurnStatus = "completed" | "interrupted" | "failed";
export type ProviderEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "item.started"; item: Item }
  | { type: "item.delta"; itemId: string; text: string }
  | { type: "item.completed"; item: Item }
  | { type: "turn.completed"; status: TurnStatus; error?: string };

export type ProviderInfo = {
  id: string;
  label: string;
  state: "ready" | "missing" | "unsupported" | "login" | "error";
  message: string;
  version?: string;
};
export type StartOptions = { root: string; fullAccess: boolean; onEvent: (e: ProviderEvent) => void; onExit: (message: string) => void };
export interface ProviderSession {
  /** Resolves once the provider accepted the turn; events keep arriving through `onEvent`. */
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}
export interface Provider {
  id: string;
  label: string;
  discover(): Promise<ProviderInfo>;
  start(o: StartOptions): Promise<ProviderSession>;
}

const CODEX_MIN = "0.169.0";
const versionParts = (v: string) => v.split(".").map(Number);
const atLeast = (v: string, min: string) => {
  const a = versionParts(v), b = versionParts(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Runs a short command (never a model turn) and returns its output; a hung binary is killed after `ms`. */
async function probe(cmd: string[], ms = 8000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), ms);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    return { code: await proc.exited, out: (out + err).trim() };
  } finally {
    clearTimeout(timer);
  }
}

const MAX_LINE = 8 * 1024 * 1024;
const rec = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

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
  private proc!: ReturnType<typeof Bun.spawn>;
  private next = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private stderr = "";
  private closed = false;
  private thread = "";
  private turn = "";
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
  async init() {
    await this.call("initialize", { clientInfo: { name: "cdesign", title: "cdesign", version: "1" } }, 15000);
    this.write({ method: "initialized" });
    const r = await this.call("thread/start", { cwd: this.o.root, approvalPolicy: this.o.fullAccess ? "never" : "on-request", sandbox: this.o.fullAccess ? "danger-full-access" : "workspace-write" }, 15000);
    const id = str(rec(r?.thread)?.id);
    if (!id) throw new Error("Codex returned no thread id (unsupported app-server protocol)");
    this.thread = id;
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
    if (m.id !== undefined) { // server request: nothing here may block waiting for a decision (approvals arrive with the permissions task)
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") this.write({ id: m.id, result: { decision: "decline" } });
      else this.write({ id: m.id, error: { code: -32601, message: `cdesign does not handle ${method}` } });
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
  async send(text: string) {
    const r = await this.call("turn/start", { threadId: this.thread, input: [{ type: "text", text, text_elements: [] }] }, 20000);
    const id = str(rec(r?.turn)?.id);
    if (id && !this.turn) { this.turn = id; this.o.onEvent({ type: "turn.started", turnId: id }); }
  }
  async interrupt() {
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

export const PROVIDERS: Record<string, Provider> = { codex };
