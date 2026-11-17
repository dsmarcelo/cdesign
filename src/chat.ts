import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDataDir } from "./store";
import { type Approval, type Item, type ProviderEvent, type ProviderSession, type TurnStatus } from "./chat-providers";
import { PROVIDERS } from "./chat-registry";

/** Per-project chat state. In memory only: durable history is a later task. Events never touch the preview broadcast (`push` in server.ts). */
export const MAX_PROMPT = 20000;
export const MAX_BODY = 100 * 1024;
const MAX_ITEMS = 500, MAX_TEXT = 200_000, MAX_OUTPUT = 50_000, MAX_LOG = 2000;
const stopGrace = () => Number(process.env.CDESIGN_CHAT_STOP_GRACE_MS) || 5000;

export class ChatError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Conversation = {
  id: string;
  provider: string;
  fullAccess: boolean;
  status: "idle" | "running";
  turnId: string | null;
  items: Item[];
  approvals: Approval[]; // pending permission requests of the running turn
  error: string | null;
};
export type ChatEvent =
  | { type: "turn.begin"; conversation: { id: string; provider: string; fullAccess: boolean }; text: string; itemId: string }
  | ProviderEvent
  | { type: "reset" }
  | { type: "settings"; fullAccess: boolean };
type Logged = ChatEvent & { seq: number };

/** Saved per project; Full access unless the user chose Normal. Unreadable files fall back to the default. */
const settingsFile = (root: string) => join(dataDir(root), "chat.json");
function readFull(root: string): boolean {
  try { return existsSync(settingsFile(root)) ? JSON.parse(readFileSync(settingsFile(root), "utf8")).fullAccess !== false : true; } catch { return true; }
}

const cap = (s: string, max: number) => (s.length > max ? s.slice(-max) : s);
const rid = () => Math.random().toString(36).slice(2, 10);

/** Reducer shared in spirit with ui/chat.js: the snapshot is exactly the events applied in order. */
export function apply(conv: Conversation, ev: ChatEvent) {
  const find = (id: string) => conv.items.find((i) => i.id === id);
  switch (ev.type) {
    case "turn.begin":
      conv.status = "running"; conv.turnId = null; conv.error = null; conv.approvals = []; conv.fullAccess = ev.conversation.fullAccess;
      conv.items.push({ id: ev.itemId, kind: "user", text: ev.text });
      break;
    case "turn.started": conv.turnId = ev.turnId; break;
    case "item.started": if (!find(ev.item.id)) conv.items.push({ ...ev.item }); break;
    case "item.delta": {
      const it = find(ev.itemId);
      if (it) it.kind === "message" ? (it.text = cap((it.text ?? "") + ev.text, MAX_TEXT)) : (it.output = cap((it.output ?? "") + ev.text, MAX_OUTPUT));
      break;
    }
    case "item.completed": {
      const it = find(ev.item.id);
      if (!it) conv.items.push({ ...ev.item });
      else Object.assign(it, ev.item, it.kind !== "message" && !ev.item.output ? { output: it.output } : {}, it.kind === "message" && !ev.item.text ? { text: it.text } : {});
      break;
    }
    case "approval.requested": if (!conv.approvals.some((a) => a.id === ev.approval.id)) conv.approvals.push({ ...ev.approval }); break;
    case "approval.resolved": conv.approvals = conv.approvals.filter((a) => a.id !== ev.id); break;
    case "turn.completed":
      conv.status = "idle"; conv.turnId = null; conv.approvals = [];
      conv.error = ev.status === "failed" ? ev.error ?? "The turn failed" : null;
      for (const it of conv.items) if (it.status === "inProgress") it.status = ev.status === "completed" ? "completed" : ev.status; // partial output stays, but nothing looks live
      break;
  }
  while (conv.items.length > MAX_ITEMS) conv.items.shift();
}

export class ProjectChat {
  private conv: Conversation | null = null;
  private session: (ProviderSession & { provider: string }) | null = null;
  private active = false; // the single admission point: set synchronously in send(), cleared when the turn ends
  private stopping = false;
  private gen = 0;
  private stopTimer: Timer | undefined;
  private log: Logged[] = [];
  private seq = 0;
  private clients = new Set<ReadableStreamDefaultController>();
  private closed = false;
  private fullAccess: boolean;
  private resumeId: { conversation: string; provider: string; id: string } | null = null;
  constructor(public root: string) { this.fullAccess = readFull(root); }

  get busy() { return this.active; }

  snapshot() {
    return { seq: this.seq, busy: this.active, fullAccess: this.fullAccess, conversation: this.conv ? structuredClone(this.conv) : null };
  }

  private emit(ev: ChatEvent) {
    if (this.closed) return;
    const logged = { ...ev, seq: ++this.seq } as Logged;
    this.log.push(logged);
    if (this.log.length > MAX_LOG) this.log.shift();
    if (ev.type === "settings") { /* not part of any conversation */ } else if (this.conv) apply(this.conv, ev);
    for (const c of this.clients) this.write(c, logged);
  }
  private write(c: ReadableStreamDefaultController, ev: Logged) {
    try { c.enqueue(new TextEncoder().encode(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`)); } catch { this.clients.delete(c); }
  }

  /** Attach an SSE client: replays what it missed after `after`, or asks it to reload the snapshot when the log no longer reaches back. */
  subscribe(c: ReadableStreamDefaultController, after: number) {
    const first = this.log[0]?.seq ?? this.seq + 1;
    if (after < first - 1 && after < this.seq) this.write(c, { type: "reset", seq: this.seq });
    else for (const ev of this.log) if (ev.seq > after) this.write(c, ev);
    this.clients.add(c);
  }
  unsubscribe(c: ReadableStreamDefaultController) { this.clients.delete(c); }

  async send(body: unknown): Promise<{ conversationId: string }> {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) throw new ChatError(400, "Write a message first");
    if (text.length > MAX_PROMPT) throw new ChatError(400, `Message is too long (max ${MAX_PROMPT} characters)`);
    const provider = PROVIDERS[typeof b.provider === "string" ? b.provider : "codex"];
    if (!provider) throw new ChatError(400, "Unknown agent");
    if (b.conversationId !== undefined && (typeof b.conversationId !== "string" || b.conversationId !== this.conv?.id)) throw new ChatError(409, "That conversation is no longer current");
    if (this.active) throw new ChatError(409, "The agent is already working on a turn in this project");
    this.active = true; // admission: nothing awaits between the check and this line
    this.stopping = false;
    if (!this.conv || this.conv.provider !== provider.id) this.conv = { id: rid(), provider: provider.id, fullAccess: this.fullAccess, status: "idle", turnId: null, items: [], approvals: [], error: null };
    const conv = this.conv;
    this.emit({ type: "turn.begin", conversation: { id: conv.id, provider: conv.provider, fullAccess: this.fullAccess }, text, itemId: "u" + rid() });
    void this.run(provider.id, text, this.fullAccess);
    return { conversationId: conv.id };
  }

  private finish(status: TurnStatus, error?: string) {
    clearTimeout(this.stopTimer);
    if (!this.active) return;
    this.active = false;
    this.stopping = false;
    this.emit({ type: "turn.completed", status, error });
  }

  /** Normal/Full applies between turns: a running turn keeps the mode it started with. */
  setAccess(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (typeof b.fullAccess !== "boolean") throw new ChatError(400, "fullAccess must be true or false");
    if (this.active) throw new ChatError(409, "Access mode cannot change while the agent is working; Stop the turn or wait for it to finish");
    if (b.fullAccess !== this.fullAccess) {
      this.fullAccess = b.fullAccess;
      try { ensureDataDir(this.root); writeFileSync(settingsFile(this.root), JSON.stringify({ fullAccess: this.fullAccess })); } catch { /* unwritable project state: the choice still holds for this daemon */ }
      if (this.conv) this.conv.fullAccess = this.fullAccess;
      this.emit({ type: "settings", fullAccess: this.fullAccess });
    }
    return { fullAccess: this.fullAccess };
  }

  /** Allow once / Deny for exactly one pending request of the running turn; anything stale, duplicate or foreign is refused and authorizes nothing. */
  approve(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const conv = this.conv;
    if (!this.active || !conv || !this.session) throw new ChatError(409, "No turn is waiting for approval");
    if (b.decision !== "allow" && b.decision !== "deny") throw new ChatError(400, "decision must be allow or deny");
    if (typeof b.approvalId !== "string" || b.conversationId !== conv.id || b.turnId !== conv.turnId) throw new ChatError(409, "That approval request is no longer current");
    if (this.stopping || !conv.approvals.some((a) => a.id === b.approvalId)) throw new ChatError(409, "That approval request is no longer pending");
    if (!this.session.respond(b.approvalId, b.decision === "allow")) throw new ChatError(409, "That approval request is no longer pending");
  }

  private async run(providerId: string, text: string, fullAccess: boolean) {
    try {
      if (this.session && this.session.provider !== providerId) { this.session.close(); this.session = null; }
      if (!this.session) {
        const gen = ++this.gen; // a closed or replaced session must not speak for the current one
        const s = await PROVIDERS[providerId].start({
          root: this.root,
          fullAccess,
          resume: this.resumeId?.conversation === this.conv?.id && this.resumeId?.provider === providerId ? this.resumeId.id : undefined,
          onEvent: (e) => { if (gen === this.gen) this.onProvider(e); },
          onExit: (msg) => { if (gen !== this.gen) return; this.noteSession(); this.session = null; this.finish("failed", msg); },
        });
        if (this.closed || gen !== this.gen || !this.active) return s.close(); // Stop or a newer start overtook this slow startup: never run the canceled prompt
        this.session = Object.assign(s, { provider: providerId });
      }
      await this.session!.send(text, fullAccess);
      if (this.stopping) await this.session!.interrupt().catch(() => {});
    } catch (e) {
      this.finish("failed", (e as Error).message);
    }
  }

  /** Remembers the provider session id so a restarted process can continue the same context. */
  private noteSession() {
    const id = this.session?.sessionId;
    if (id && this.conv) this.resumeId = { conversation: this.conv.id, provider: this.session!.provider, id };
  }

  private onProvider(e: ProviderEvent) {
    if (e.type === "turn.completed") return this.finish(e.status, e.error);
    if (this.active) this.emit(e);
  }

  stop(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (!this.active || !this.conv) throw new ChatError(409, "No turn is running");
    if (b.conversationId !== undefined && b.conversationId !== this.conv.id) throw new ChatError(409, "That conversation is not the running one");
    if (b.turnId !== undefined && b.turnId !== this.conv.turnId) throw new ChatError(409, "That turn is not the running one");
    if (this.stopping) return;
    this.stopping = true;
    const s = this.session;
    if (s && this.conv.turnId) s.interrupt().catch(() => {});
    // an agent that ignores the interrupt must not keep editing: kill it and keep what it said so far
    this.stopTimer = setTimeout(() => {
      if (!this.active) return;
      this.gen++;
      this.noteSession();
      this.session?.close();
      this.session = null;
      this.finish("interrupted");
    }, stopGrace());
  }

  close() {
    this.closed = true;
    clearTimeout(this.stopTimer);
    this.gen++;
    this.session?.close();
    this.session = null;
    for (const c of this.clients) try { c.close(); } catch { /* already closed */ }
    this.clients.clear();
  }
}
