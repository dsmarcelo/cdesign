import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDataDir, update } from "./store";
import { type Capabilities, type SlashCommand, type ProviderEvent, type ProviderSession, type TurnSettings, type TurnStatus } from "./chat-providers";
import { PROVIDERS } from "./chat-registry";
import { resolveContext, withContext, type ContextRef } from "./chat-context";
import { loadConversations, removeConversation, saveConversation, type Conversation } from "./chat-store";
export type { Conversation };

/** Per-project chat state: saved conversations (./chat-store) plus the one running turn. Events never touch the preview broadcast (`push` in server.ts). */
export const MAX_PROMPT = 20000;
export const MAX_BODY = 100 * 1024;
const MAX_ITEMS = 500, MAX_TEXT = 200_000, MAX_OUTPUT = 50_000, MAX_LOG = 2000;
const stopGrace = () => Number(process.env.CDESIGN_CHAT_STOP_GRACE_MS) || 5000;

export class ChatError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export type ChatEvent =
  | { type: "turn.begin"; conversation: { id: string; title: string; provider: string; fullAccess: boolean; model: string | null; effort: string | null }; text: string; itemId: string; context?: ContextRef[] }
  | ProviderEvent
  | { type: "reset" }
  | { type: "list" } // conversations were created, renamed or deleted: refetch the list
  | { type: "settings"; fullAccess: boolean; conversationId?: string; model?: string | null; effort?: string | null };
/** `cid` is the conversation an event belongs to (only one turn runs per project, so it is the active one). */
type Logged = ChatEvent & { seq: number; cid?: string };

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
      conv.status = "running"; conv.turnId = null; conv.error = null; conv.approvals = []; conv.fullAccess = ev.conversation.fullAccess; conv.model = ev.conversation.model; conv.effort = ev.conversation.effort;
      conv.items.push({ id: ev.itemId, kind: "user", text: ev.text, ...(ev.context?.length ? { context: ev.context } : {}) });
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
      conv.status = "idle"; conv.turnId = null; conv.approvals = []; conv.last = ev.status;
      conv.error = ev.status === "failed" ? ev.error ?? "The turn failed" : null;
      for (const it of conv.items) if (it.status === "inProgress") it.status = ev.status === "completed" ? "completed" : ev.status; // partial output stays, but nothing looks live
      break;
  }
  while (conv.items.length > MAX_ITEMS) conv.items.shift();
}


/** Capabilities are discovered from the installed agent (it may start a process), so they are cached briefly; a failed discovery is retried sooner. */
const capCache = new Map<string, { at: number; value: Promise<Capabilities> }>();
export function capabilitiesOf(id: string, fresh = false): Promise<Capabilities> {
  const hit = capCache.get(id);
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.value;
  const value = PROVIDERS[id].capabilities().catch((e): Capabilities => ({ source: "fallback", note: `Could not discover settings: ${(e as Error).message}`, models: [], efforts: [], defaultLabel: "Default" }));
  capCache.set(id, { at: Date.now(), value });
  return value;
}

/** Slash commands change rarely (installing a skill is the usual cause) but listing them starts the agent once, so they are cached briefly. A failed listing is not kept. */
const cmdCache = new Map<string, { at: number; value: Promise<SlashCommand[]> }>();
export function commandsOf(id: string, root: string, fresh = false): Promise<SlashCommand[]> {
  const p = PROVIDERS[id];
  if (!p?.commands) return Promise.resolve([]);
  const key = id + "\0" + root, hit = cmdCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.value;
  const value = p.commands(root).catch((): SlashCommand[] => (cmdCache.delete(key), []));
  cmdCache.set(key, { at: Date.now(), value });
  return value;
}

/** Throws a ChatError explaining why `model`/`effort` cannot be used with this provider; null means the provider default. */
async function checkSettings(providerId: string, model: string | null, effort: string | null) {
  const label = PROVIDERS[providerId].label;
  const caps = await capabilitiesOf(providerId);
  let efforts = caps.efforts;
  if (model !== null) {
    const m = caps.models.find((x) => x.id === model);
    if (!m) throw new ChatError(400, caps.models.length ? `${label} does not offer the model "${model}". Available: ${caps.models.map((x) => x.id).join(", ")}.` : `${label} did not list its models, so only its default model can be used (${caps.note})`);
    efforts = m.efforts ?? caps.efforts;
  }
  if (effort !== null && !efforts.includes(effort)) throw new ChatError(400, efforts.length ? `${model ? `The model "${model}"` : `${label}'s default model`} does not support the effort "${effort}". Supported: ${efforts.join(", ")}.` : `${label} did not list reasoning efforts${model ? ` for "${model}"` : ""}, so only its default effort can be used.`);
}
const settingOf = (v: unknown, name: string): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 100 || /[\s\u0000-\u001f]/.test(v)) throw new ChatError(400, `${name} must be a plain value or null`);
  return v;
};

const SAVE_MS = 300;
const INTERRUPTED = "Interrupted: cdesign stopped or restarted while the agent was working. What it said so far is kept and nothing was retried. Send a follow-up to continue this chat.";
const titleOf = (text: string) => { const t = text.replace(/\s+/g, " ").trim(); return t.length > 60 ? t.slice(0, 59) + "…" : t; };

export class ProjectChat {
  private convs = new Map<string, Conversation>();
  private session: (ProviderSession & { provider: string; cid: string; settings: TurnSettings }) | null = null;
  private active = false; // the single admission point: set synchronously in send(), cleared when the turn ends
  private activeId: string | null = null; // conversation owning the running or approval-waiting turn
  private stopping = false;
  private gen = 0;
  private stopTimer: Timer | undefined;
  private starting: { close(): void } | null = null; // child still initializing: owned here so Stop and shutdown can kill it
  private saveTimer: Timer | undefined;
  private dirty = new Set<string>();
  private log: Logged[] = [];
  private seq = 0;
  /** Changes with every daemon run: a client holding a sequence number from an earlier run must reload the snapshot. */
  private epoch = rid();
  private clients = new Set<ReadableStreamDefaultController>();
  private closed = false;
  private fullAccess: boolean;
  constructor(public root: string) {
    this.fullAccess = readFull(root);
    // A turn that was running when the previous daemon went away is over: keep its partial output, never retry it or replay an approval.
    for (const c of loadConversations(root)) {
      if (c.status === "running") {
        c.status = "idle";
        c.last = "interrupted";
        c.error = INTERRUPTED;
        for (const it of c.items) if (it.status === "inProgress") it.status = "interrupted";
        saveConversation(root, c);
      }
      this.convs.set(c.id, c);
    }
  }

  get busy() { return this.active; }

  private list() {
    return [...this.convs.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, provider: c.provider, updatedAt: c.updatedAt, status: c.status, last: c.last }));
  }

  /** `cid` picks the conversation to include; by default the running one, else the most recently used. */
  snapshot(cid?: string | null) {
    const sel = (cid ? this.convs.get(cid) : undefined) ?? (this.activeId ? this.convs.get(this.activeId) : undefined) ?? [...this.convs.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return {
      epoch: this.epoch, seq: this.seq, busy: this.active, activeId: this.activeId, fullAccess: this.fullAccess,
      conversations: this.list(), conversation: sel ? structuredClone(sel) : null,
    };
  }

  /** Streaming output is written at most every SAVE_MS; turn boundaries flush at once. */
  private touch(c: Conversation, now = false) {
    this.dirty.add(c.id);
    if (now) return this.flush();
    this.saveTimer ??= setTimeout(() => this.flush(), SAVE_MS);
  }
  private flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const id of this.dirty) { const c = this.convs.get(id); if (c) try { saveConversation(this.root, c); } catch { /* unwritable project state: the chat still works until restart */ } }
    this.dirty.clear();
  }

  private emit(ev: ChatEvent, cid: string | null = this.activeId) {
    if (this.closed) return;
    const logged = { ...ev, seq: ++this.seq, ...(cid ? { cid } : {}) } as Logged;
    this.log.push(logged);
    if (this.log.length > MAX_LOG) this.log.shift();
    const conv = cid ? this.convs.get(cid) : undefined;
    if (conv && ev.type !== "list" && ev.type !== "settings" && ev.type !== "reset") {
      apply(conv, ev);
      this.touch(conv, ev.type === "turn.begin" || ev.type === "turn.completed" || ev.type === "approval.requested");
    }
    for (const c of this.clients) this.write(c, logged);
  }
  private write(c: ReadableStreamDefaultController, ev: Logged) {
    try { c.enqueue(new TextEncoder().encode(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`)); } catch { this.clients.delete(c); }
  }

  /** Attach an SSE client: replays what it missed after `after`, or asks it to reload the snapshot when the log no longer reaches back or belongs to another run. */
  subscribe(c: ReadableStreamDefaultController, after: number, epoch?: string | null) {
    const first = this.log[0]?.seq ?? this.seq + 1;
    if ((epoch && epoch !== this.epoch) || after > this.seq || (after < first - 1 && after < this.seq)) this.write(c, { type: "reset", seq: this.seq });
    else for (const ev of this.log) if (ev.seq > after) this.write(c, ev);
    this.clients.add(c);
  }
  unsubscribe(c: ReadableStreamDefaultController) { this.clients.delete(c); }

  private conversation(id: unknown): Conversation {
    const c = typeof id === "string" ? this.convs.get(id) : undefined;
    if (!c) throw new ChatError(404, "That conversation no longer exists");
    return c;
  }

  async send(body: unknown): Promise<{ conversationId: string }> {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) throw new ChatError(400, "Write a message first");
    if (text.length > MAX_PROMPT) throw new ChatError(400, `Message is too long (max ${MAX_PROMPT} characters)`);
    let conv = b.conversationId === undefined ? null : this.conversation(b.conversationId);
    const provider = PROVIDERS[typeof b.provider === "string" ? b.provider : conv?.provider ?? "codex"];
    if (!provider) throw new ChatError(400, "Unknown agent");
    if (conv && conv.provider !== provider.id) throw new ChatError(400, "A conversation keeps its agent; start a new chat to use another one");
    if (b.fullAccess !== undefined && typeof b.fullAccess !== "boolean") throw new ChatError(400, "fullAccess must be true or false");
    // an omitted model/effort keeps the chat's saved one; a new chat starts on the provider default
    const model = settingOf(b.model, "model") ?? (b.model === undefined ? conv?.model ?? null : null);
    const effort = settingOf(b.effort, "effort") ?? (b.effort === undefined ? conv?.effort ?? null : null);
    // a command the agent runs itself (`/compact`) is sent exactly as typed: no design context, and the comments stay undelivered
    const local = !!provider.isLocal?.(text);
    const context = local ? [] : resolveContext(this.root, b.context);
    if (this.active) {
      const at = this.activeId ? this.convs.get(this.activeId) : undefined;
      throw new ChatError(409, `The agent is already working in this project${at ? `, in the chat "${at.title}"` : ""}. Wait for it to finish or Stop it first.`, { activeConversationId: this.activeId });
    }
    if (conv && conv.items.some((i) => i.kind !== "user") && !conv.sessionId && this.session?.cid !== conv.id) throw new ChatError(409, "This chat has no saved agent session to continue. Start a new chat.");
    if (model !== (conv?.model ?? null) || effort !== (conv?.effort ?? null)) {
      await checkSettings(provider.id, model, effort);
    }
    // validation may have awaited: look everything up again, then admit with nothing awaiting before `active` is set
    conv = b.conversationId === undefined ? null : this.conversation(b.conversationId);
    if (this.active) throw new ChatError(409, "The agent is already working in this project. Wait for it to finish or Stop it first.", { activeConversationId: this.activeId });
    this.active = true; // admission: nothing awaits between the check and this line
    this.stopping = false;
    const created = !conv;
    if (!conv) {
      const now = Date.now();
      conv = { id: rid(), title: titleOf(text) || "Chat", provider: provider.id, fullAccess: typeof b.fullAccess === "boolean" ? b.fullAccess : this.fullAccess, model, effort, last: null, sessionId: null, createdAt: now, updatedAt: now, status: "idle", turnId: null, items: [], approvals: [], error: null };
      this.convs.set(conv.id, conv);
    }
    this.activeId = conv.id;
    conv.updatedAt = Date.now();
    conv.model = model; conv.effort = effort;
    if (!created && typeof b.fullAccess === "boolean") conv.fullAccess = b.fullAccess;
    // the agent now has these comments in its prompt: they leave the undelivered pool (resolve still marks them done)
    const ids = new Set(context.flatMap((r) => (r.kind === "comment" ? [r.id] : [])));
    if (ids.size) update(this.root, (l) => l.forEach((c) => ids.has(c.id) && (c.status === "draft" || c.status === "queued") && (c.status = "sent")));
    this.emit({ type: "turn.begin", conversation: { id: conv.id, title: conv.title, provider: conv.provider, fullAccess: conv.fullAccess, model, effort }, text, itemId: "u" + rid(), ...(context.length ? { context } : {}) });
    if (created) this.emit({ type: "list" }, null);
    void this.run(conv, withContext(text, context));
    return { conversationId: conv.id };
  }

  private finish(status: TurnStatus, error?: string) {
    clearTimeout(this.stopTimer);
    if (!this.active) return;
    const cid = this.activeId;
    const conv = cid ? this.convs.get(cid) : undefined;
    if (conv) conv.updatedAt = Date.now();
    this.noteSession();
    this.emit({ type: "turn.completed", status, error }, cid);
    this.active = false;
    this.activeId = null;
    this.stopping = false;
    this.flush();
  }

  /**
   * Access mode, model and effort apply between turns. Naming a conversation changes only that chat (model/effort always need one);
   * without one, `fullAccess` sets the project default used when a new chat does not say. Unsupported values are rejected with the reason.
   */
  async setSettings(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (b.fullAccess !== undefined && typeof b.fullAccess !== "boolean") throw new ChatError(400, "fullAccess must be true or false");
    let conv = b.conversationId === undefined ? null : this.conversation(b.conversationId);
    const model = settingOf(b.model, "model"), effort = settingOf(b.effort, "effort");
    if (b.fullAccess === undefined && model === undefined && effort === undefined) throw new ChatError(400, "fullAccess must be true or false");
    if ((model !== undefined || effort !== undefined) && !conv) throw new ChatError(400, "Model and effort belong to a conversation");
    if (this.active) throw new ChatError(409, "Settings cannot change while the agent is working; Stop the turn or wait for it to finish");
    if (conv && (model !== undefined || effort !== undefined)) {
      const m = model === undefined ? conv.model : model, e = effort === undefined ? conv.effort : effort;
      await checkSettings(conv.provider, m, e);
      conv = this.conversation(conv.id);
      if (this.active) throw new ChatError(409, "Settings cannot change while the agent is working; Stop the turn or wait for it to finish");
      conv.model = m; conv.effort = e;
      this.touch(conv, true);
    }
    if (typeof b.fullAccess === "boolean") {
      if (!conv && b.fullAccess !== this.fullAccess) {
        this.fullAccess = b.fullAccess;
        try { ensureDataDir(this.root); writeFileSync(settingsFile(this.root), JSON.stringify({ fullAccess: this.fullAccess })); } catch { /* unwritable project state: the choice still holds for this daemon */ }
      }
      if (conv && conv.fullAccess !== b.fullAccess) { conv.fullAccess = b.fullAccess; this.touch(conv, true); }
    }
    this.emit({ type: "settings", fullAccess: conv ? conv.fullAccess : this.fullAccess, ...(conv ? { conversationId: conv.id, model: conv.model, effort: conv.effort } : {}) }, null);
    return conv ? { fullAccess: conv.fullAccess, model: conv.model, effort: conv.effort } : { fullAccess: this.fullAccess };
  }

  rename(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const conv = this.conversation(b.conversationId);
    const title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim() : "";
    if (!title) throw new ChatError(400, "Give the chat a name");
    if (title.length > 80) throw new ChatError(400, "Chat names can be at most 80 characters");
    conv.title = title;
    this.touch(conv, true);
    this.emit({ type: "list" }, null);
    return { title };
  }

  /** Removes only cdesign's saved record; the provider's own history and the project files are untouched. */
  remove(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const conv = this.conversation(b.conversationId);
    if (this.active && this.activeId === conv.id) throw new ChatError(409, "This chat is still working. Stop it and wait for it to end before deleting.", { activeConversationId: conv.id });
    if (this.session?.cid === conv.id) { this.gen++; this.session.close(); this.session = null; }
    this.convs.delete(conv.id);
    this.dirty.delete(conv.id);
    try { removeConversation(this.root, conv.id); } catch { /* already gone */ }
    this.emit({ type: "list" }, null);
  }

  /** Allow once / Deny for exactly one pending request of the running turn; anything stale, duplicate or foreign is refused and authorizes nothing. */
  approve(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const conv = this.activeId ? this.convs.get(this.activeId) : undefined;
    if (!this.active || !conv || !this.session) throw new ChatError(409, "No turn is waiting for approval");
    if (b.decision !== "allow" && b.decision !== "deny") throw new ChatError(400, "decision must be allow or deny");
    if (typeof b.approvalId !== "string" || b.conversationId !== conv.id || b.turnId !== conv.turnId) throw new ChatError(409, "That approval request is no longer current");
    if (this.stopping || !conv.approvals.some((a) => a.id === b.approvalId)) throw new ChatError(409, "That approval request is no longer pending");
    if (!this.session.respond(b.approvalId, b.decision === "allow")) throw new ChatError(409, "That approval request is no longer pending");
  }

  private async run(conv: Conversation, text: string) {
    const provider = PROVIDERS[conv.provider];
    const fullAccess = conv.fullAccess;
    const want: TurnSettings = { ...(conv.model ? { model: conv.model } : {}), ...(conv.effort ? { effort: conv.effort } : {}) };
    let resume = conv.sessionId ?? undefined;
    let gen = -1; // the session generation this run belongs to; a later failure of an invalidated run is ignored
    // a saved session that cannot be resumed says so and stays recoverable; the prompt is never resubmitted elsewhere
    const why = (msg: string) => (resume && !conv.turnId ? `The saved ${provider.label} session could not be resumed (${msg}). Start a new chat to continue.` : msg);
    try {
      if (this.session && this.session.cid !== conv.id) { this.gen++; this.session.close(); this.session = null; }
      // a live session picks up new settings per turn only if the provider supports that, and never when going back to the default
      const had = this.session?.settings;
      if (this.session && had && (had.model !== want.model || had.effort !== want.effort) && (!provider.perTurn || (!want.model && had.model) || (!want.effort && had.effort))) {
        this.noteSession(); this.gen++; this.session.close(); this.session = null;
        resume = conv.sessionId ?? undefined;
      }
      if (!this.session) {
        gen = ++this.gen; // a closed or replaced session must not speak for the current one
        const mine = gen;
        const s = await provider.start({
          root: this.root,
          fullAccess,
          ...want,
          resume,
          onSpawn: (child) => { if (mine === this.gen && !this.closed) this.starting = child; else child.close(); },
          onEvent: (e) => { if (mine === this.gen) this.onProvider(e); },
          onExit: (msg) => { if (mine !== this.gen) return; this.noteSession(); this.session = null; this.finish("failed", why(msg)); },
        });
        this.starting = null;
        if (this.closed || gen !== this.gen || !this.active) return s.close(); // Stop or a newer start overtook this slow startup: never run the canceled prompt
        this.session = Object.assign(s, { provider: provider.id, cid: conv.id, settings: want });
        this.noteSession();
      }
      gen = this.gen;
      this.session!.settings = want;
      await this.session!.send(text, fullAccess, want);
      if (this.stopping) await this.session!.interrupt().catch(() => {});
    } catch (e) {
      if (gen >= 0 && gen !== this.gen) return; // canceled or replaced meanwhile: must not fail a newer turn
      this.starting = null;
      this.finish("failed", why((e as Error).message));
    }
  }

  private killStarting() {
    const c = this.starting;
    this.starting = null;
    c?.close();
  }

  /** Remembers the provider session id on the running conversation so it can be resumed after the process or daemon is gone. */
  private noteSession() {
    const id = this.session?.sessionId;
    const conv = this.activeId ? this.convs.get(this.activeId) : undefined;
    if (id && conv && this.session?.cid === conv.id && conv.sessionId !== id) { conv.sessionId = id; this.touch(conv, true); }
  }

  private onProvider(e: ProviderEvent) {
    if (e.type === "turn.completed") return this.finish(e.status, e.error);
    if (this.active) { this.emit(e); if (e.type === "turn.started") this.noteSession(); }
  }

  stop(body: unknown) {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const conv = this.activeId ? this.convs.get(this.activeId) : undefined;
    if (!this.active || !conv) throw new ChatError(409, "No turn is running");
    if (b.conversationId !== undefined && b.conversationId !== conv.id) throw new ChatError(409, "That conversation is not the running one", { activeConversationId: conv.id });
    if (b.turnId !== undefined && b.turnId !== conv.turnId) throw new ChatError(409, "That turn is not the running one");
    if (this.stopping) return;
    this.stopping = true;
    const s = this.session;
    if (s && conv.turnId) s.interrupt().catch(() => {});
    // an agent that ignores the interrupt must not keep editing: kill it and keep what it said so far
    this.stopTimer = setTimeout(() => {
      if (!this.active) return;
      this.gen++;
      this.noteSession();
      this.killStarting();
      this.session?.close();
      this.session = null;
      this.finish("interrupted");
    }, stopGrace());
  }

  /** Daemon shutdown or project removal: a running turn ends as interrupted (saved), its agent process is killed, pending requests close. */
  close() {
    clearTimeout(this.stopTimer);
    if (this.active) {
      this.gen++;
      this.noteSession();
      this.killStarting();
      this.session?.close();
      this.session = null;
      this.finish("interrupted");
    }
    this.flush();
    this.closed = true;
    this.gen++;
    this.killStarting();
    this.session?.close();
    this.session = null;
    for (const c of this.clients) try { c.close(); } catch { /* already closed */ }
    this.clients.clear();
  }
}
