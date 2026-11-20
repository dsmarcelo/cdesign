import { sourceSnippet, insideProject } from "./modes";
import { readComments } from "./store";
import { ChatError } from "./chat";

/** One piece of design context sent with a chat message. Everything is re-derived from the project on the server; the client only names what it wants. */
export type ContextRef =
  | { kind: "page"; file: string }
  | { kind: "element"; file: string; cdId: string; selector: string; tag: string; snippet: string }
  | { kind: "comment"; id: string; file: string; cdId: string; text: string; snippet: string };

export type TabState = { file: string | null; selection: { file: string; cdId: string; selector: string; tag: string } | null };
export type ChipState = "ok" | "missing" | "stale";

const ID = /^\d+:\d+$/;
const MAX_COMMENTS = 20, MAX_FILE = 300;
const str = (v: unknown, max = MAX_FILE) => (typeof v === "string" && v.length <= max ? v : "");

/** What the composer shows as chips for one viewer tab: the page it has open and its selected element, each with a visible recoverable state. */
export function contextChips(root: string, tab: TabState | null) {
  const page = tab?.file ? { file: tab.file, state: (insideProject(root, tab.file) ? "ok" : "missing") as ChipState } : null;
  const s = tab?.selection;
  let selection: (NonNullable<TabState["selection"]> & { state: ChipState }) | null = null;
  if (s) {
    let state: ChipState = "missing";
    if (insideProject(root, s.file)) state = ID.test(s.cdId) && sourceSnippet(root, s.file, s.cdId) ? "ok" : "stale";
    selection = { file: s.file, cdId: s.cdId, selector: s.selector, tag: s.tag, state };
  }
  return { page, selection };
}

/** Validates the context a message names against this project and returns the snapshot to record and send. Anything missing or stale is refused with the reason, so nothing foreign or outdated reaches the agent. */
export function resolveContext(root: string, raw: unknown): ContextRef[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ChatError(400, "context must be an object");
  const c = raw as Record<string, unknown>;
  const out: ContextRef[] = [];
  const page = c.page;
  if (page !== undefined && page !== null) {
    const file = str((page as any)?.file);
    if (!file) throw new ChatError(400, "The page in the context is not valid");
    if (!insideProject(root, file)) throw new ChatError(409, `The page "${file}" no longer exists in this project. Remove it from the message or open another page.`);
    out.push({ kind: "page", file });
  }
  const el = c.selection;
  if (el !== undefined && el !== null) {
    const file = str((el as any)?.file), cdId = str((el as any)?.cdId, 20);
    if (!file || !ID.test(cdId)) throw new ChatError(400, "The selected element in the context is not valid");
    if (!insideProject(root, file)) throw new ChatError(409, `The selected element's file "${file}" no longer exists in this project. Remove it from the message or select an element again.`);
    const snippet = sourceSnippet(root, file, cdId);
    if (!snippet) throw new ChatError(409, `The selected element ${file}:${cdId} no longer exists (the file changed). Remove it from the message or select an element again.`);
    out.push({ kind: "element", file, cdId, selector: str((el as any)?.selector, 500), tag: str((el as any)?.tag, 40), snippet });
  }
  if (c.comments !== undefined) {
    if (!Array.isArray(c.comments) || c.comments.length > MAX_COMMENTS) throw new ChatError(400, `Attach at most ${MAX_COMMENTS} comments`);
    const known = readComments(root);
    const seen = new Set<string>();
    for (const id of c.comments) {
      if (typeof id !== "string" || seen.has(id)) continue; // a comment attached twice is attached once
      seen.add(id);
      const cm = known.find((k) => k.id === id);
      if (!cm) throw new ChatError(409, "A comment you attached no longer exists. Remove it from the message.");
      out.push({ kind: "comment", id: cm.id, file: cm.file, cdId: cm.cdId, text: cm.text, snippet: cm.snippet });
    }
  }
  return out;
}

/** The text the agent receives: the user's message plus a compact block that locates the design (files, element ids, source snippets) without pasting unrelated files. */
export function withContext(text: string, refs: ContextRef[]): string {
  if (!refs.length) return text;
  const lines = ["", "---", "cdesign context (what the user is looking at; element ids are data-cd-id \"line:col\" of the start tag in that file):"];
  for (const r of refs) {
    if (r.kind === "page") lines.push(`- Open page: ${r.file}`);
    else if (r.kind === "element") lines.push(`- Selected element: ${r.file} at ${r.cdId}${r.tag ? ` <${r.tag}>` : ""}${r.selector ? `, selector ${r.selector}` : ""}\n  ${r.snippet.replace(/\n/g, "\n  ")}`);
    else lines.push(`- Comment ${r.id} on ${r.file} at ${r.cdId}: ${JSON.stringify(r.text)}\n  ${r.snippet.replace(/\n/g, "\n  ")}`);
  }
  const comments = refs.filter((r) => r.kind === "comment");
  if (comments.length) lines.push(`Each comment above is a change the user asks for on that element. Apply all ${comments.length} of them, editing only what each needs, then run \`cdesign resolve ${comments.map((c) => c.id).join(" ")}\` to mark them done.`);
  lines.push("Edit only what the request needs; run `cdesign context for <file>` if you need the design guidance for a file.");
  return text + "\n" + lines.join("\n");
}
