import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDataDir } from "./store";
import type { Approval, Item } from "./chat-providers";

export type Conversation = {
  id: string;
  title: string;
  provider: string;
  fullAccess: boolean;
  /** Chosen model / reasoning effort; null = the provider default. Saved with the chat so reopening restores it. */
  model: string | null;
  effort: string | null;
  /** How the most recent finished turn ended (null before the first). */
  last: "completed" | "interrupted" | "failed" | null;
  /** Provider-side session id: what lets a reopened chat continue its own context instead of the latest unrelated CLI session. */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running";
  turnId: string | null;
  items: Item[];
  approvals: Approval[]; // pending permission requests of the running turn (never persisted as answerable)
  error: string | null;
};

/** One file per conversation under the gitignored project state; ids come from the daemon, never from a request path. */
const dir = (root: string) => join(dataDir(root), "chats");
const ID = /^[a-z0-9]{1,32}$/;

/**
 * Written to a temp file and renamed, so a crash mid-write leaves the previous complete record.
 * Synchronous, and only the daemon writes, so writes are serialized by construction.
 */
export function saveConversation(root: string, c: Conversation) {
  if (!ID.test(c.id)) return;
  ensureDataDir(root);
  mkdirSync(dir(root), { recursive: true });
  const file = join(dir(root), c.id + ".json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, file);
}

export function removeConversation(root: string, id: string) {
  if (ID.test(id)) rmSync(join(dir(root), id + ".json"), { force: true });
}

/** Unreadable or malformed records are skipped rather than blocking the chat. */
export function loadConversations(root: string): Conversation[] {
  const d = dir(root);
  if (!existsSync(d)) return [];
  const out: Conversation[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(readFileSync(join(d, f), "utf8"));
      if (!c || typeof c.id !== "string" || !ID.test(c.id) || f !== c.id + ".json" || typeof c.provider !== "string" || !Array.isArray(c.items)) continue;
      out.push({
        id: c.id,
        title: typeof c.title === "string" && c.title ? c.title : "Chat",
        provider: c.provider,
        fullAccess: c.fullAccess !== false,
        model: typeof c.model === "string" && c.model ? c.model : null,
        effort: typeof c.effort === "string" && c.effort ? c.effort : null,
        last: c.last === "completed" || c.last === "interrupted" || c.last === "failed" ? c.last : null,
        sessionId: typeof c.sessionId === "string" ? c.sessionId : null,
        createdAt: Number(c.createdAt) || 0,
        updatedAt: Number(c.updatedAt) || 0,
        status: c.status === "running" ? "running" : "idle",
        turnId: null,
        items: c.items,
        approvals: [],
        error: typeof c.error === "string" ? c.error : null,
      });
    } catch { /* skip */ }
  }
  return out;
}
