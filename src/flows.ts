import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { insideProject } from "./modes";

/**
 * Flows: one JSON file per user flow in design/flows/<id>.json. A flow is a graph of steps (screens and decisions)
 * joined by links. A screen step pairs a wireframe (design/wireframe/…, the plan) with the real page (design/pages/…)
 * once one exists. The pair is what sync tracks: design/sync.json records the content hashes of both files when
 * they were last confirmed in sync, plus explicit "outdated" marks that agents or the user set.
 */
export type FlowStep = { id: string; title?: string; wireframe?: string; page?: string; decision?: string; note?: string; wireframes?: Variants };
/** Device variants of one wireframe: `name.phone.tsx` and `name.desktop.tsx` siblings; an unsuffixed file is responsive (both). */
export type Variants = { phone?: string; desktop?: string };

const VARIANT = /\.(phone|desktop)(\.(?:tsx|html))$/;
export function variantsOf(root: string, file: string): Variants {
  const m = file.match(VARIANT);
  const base = m ? file.slice(0, m.index) : file.replace(/\.(tsx|html)$/, "");
  const ext = m ? m[2] : file.slice(base.length);
  const sib = (d: string) => existsSync(join(root, `${base}.${d}${ext}`)) ? `${base}.${d}${ext}` : undefined;
  if (m) return { phone: m[1] === "phone" ? file : sib("phone"), desktop: m[1] === "desktop" ? file : sib("desktop") };
  return { phone: sib("phone") ?? file, desktop: sib("desktop") ?? file };
}
export type FlowLink = { from: string; to: string; label?: string; dashed?: boolean };
export type Flow = { id: string; file: string; title: string; description?: string; steps: FlowStep[]; links: FlowLink[]; errors: string[] };

export const FLOWS_DIR = "design/flows";
export const WIREFRAME_DIR = "design/wireframe";
const SYNC_FILE = "design/sync.json";
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PREVIEWABLE = /\.(tsx|html)$/;

const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;

/** `page.tsx#venda/cliente` -> `page.tsx`: the part after "#" is the URL state the page opens with (a dialog or sheet showing). */
export const baseFile = (path: string) => path.split("#")[0];

function checkFile(root: string, ref: string | undefined, kind: string, step: string, errors: string[]) {
  if (ref === undefined) return;
  const path = baseFile(ref);
  if (!path.startsWith("design/") || !PREVIEWABLE.test(path)) errors.push(`step "${step}": ${kind} must be a project-relative design/… .tsx or .html file, got "${path}"`);
  else if (!existsSync(join(root, path)) || !insideProject(root, path)) errors.push(`step "${step}": ${kind} file not found: ${path}`);
}

export function readFlow(root: string, id: string): Flow {
  const file = `${FLOWS_DIR}/${id}.json`;
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(join(root, file), "utf8")); }
  catch (e) { return { id, file, title: id, steps: [], links: [], errors: [`invalid JSON: ${(e as Error).message}`] }; }
  if (!ID.test(id)) errors.push(`file name must be lowercase letters, digits and dashes: ${id}.json`);
  const steps: FlowStep[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(raw.steps) ? raw.steps as Record<string, unknown>[] : []) {
    const step: FlowStep = { id: str(s?.id) ?? "", title: str(s?.title), wireframe: str(s?.wireframe), page: str(s?.page), decision: str(s?.decision), note: str(s?.note) };
    if (!ID.test(step.id)) { errors.push(`step id must be lowercase letters, digits and dashes: "${step.id}"`); continue; }
    if (seen.has(step.id)) { errors.push(`duplicate step id "${step.id}"`); continue; }
    seen.add(step.id);
    if (step.decision && (step.wireframe || step.page)) errors.push(`step "${step.id}": a decision has no wireframe or page`);
    if (!step.decision && !step.wireframe && !step.page) errors.push(`step "${step.id}": needs a wireframe, a page, or a decision`);
    checkFile(root, step.wireframe, "wireframe", step.id, errors);
    checkFile(root, step.page, "page", step.id, errors);
    if (step.wireframe && existsSync(join(root, step.wireframe))) step.wireframes = variantsOf(root, step.wireframe);
    steps.push(step);
  }
  if (!Array.isArray(raw.steps)) errors.push(`"steps" must be an array`);
  const links: FlowLink[] = [];
  for (const l of Array.isArray(raw.links) ? raw.links as Record<string, unknown>[] : []) {
    const link: FlowLink = { from: str(l?.from) ?? "", to: str(l?.to) ?? "", label: str(l?.label), dashed: l?.dashed === true || undefined };
    if (!seen.has(link.from) || !seen.has(link.to)) { errors.push(`link ${link.from || "?"} -> ${link.to || "?"}: unknown step id`); continue; }
    links.push(link);
  }
  if (raw.links !== undefined && !Array.isArray(raw.links)) errors.push(`"links" must be an array`);
  return { id, file, title: str(raw.title) ?? id, description: str(raw.description), steps, links, errors };
}

export function listFlows(root: string): Flow[] {
  const dir = join(root, FLOWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readFlow(root, f.slice(0, -5)));
}

export function newFlow(root: string, id: string, title?: string): string {
  if (!ID.test(id)) throw new Error("Flow id must be lowercase letters, digits and dashes, e.g. nova-venda");
  const file = `${FLOWS_DIR}/${id}.json`;
  if (existsSync(join(root, file))) throw new Error(`${file} already exists`);
  mkdirSync(join(root, FLOWS_DIR), { recursive: true });
  writeFileSync(join(root, file), JSON.stringify({ title: title ?? id, description: "", steps: [], links: [] }, null, 2) + "\n");
  return file;
}

// ---------- sync between wireframes and pages ----------

type SyncFile = {
  version: 1;
  /** keyed by page path: the wireframe it was last confirmed against, with both content hashes at that moment */
  pairs: Record<string, { wireframe: string; wireframeHash: string; pageHash: string; syncedAt: string }>;
  /** keyed by file (a page or a wireframe): it must be updated to match its counterpart */
  outdated: Record<string, { note?: string; at: string }>;
};
export type SyncState = "no-page" | "no-wireframe" | "never-synced" | "in-sync" | "wireframe-changed" | "page-changed" | "both-changed";
export type SyncItem = {
  wireframe?: string;
  wireframes?: Variants;
  page?: string;
  state: SyncState;
  /** explicit marks: which side needs updating, and why */
  outdated: { file: string; side: "page" | "wireframe"; note?: string; at: string }[];
  steps: { flow: string; step: string; title: string }[];
  syncedAt?: string;
};

const fileHash = (root: string, f: string) => { try { return createHash("sha1").update(readFileSync(join(root, f))).digest("hex"); } catch { return ""; } };
/** A wireframe's hash covers all of its device variants, so editing the desktop sibling also counts as a wireframe change. */
const hash = (root: string, ref: string) => {
  const f = baseFile(ref);
  if (!f.startsWith(WIREFRAME_DIR + "/")) return fileHash(root, f);
  const v = variantsOf(root, f), files = [...new Set([v.phone, v.desktop].filter(Boolean) as string[])].sort();
  return files.length === 1 ? fileHash(root, files[0]) : createHash("sha1").update(files.map((x) => fileHash(root, x)).join()).digest("hex");
};
export function readSync(root: string): SyncFile {
  try {
    const s = JSON.parse(readFileSync(join(root, SYNC_FILE), "utf8"));
    return { version: 1, pairs: s.pairs && typeof s.pairs === "object" ? s.pairs : {}, outdated: s.outdated && typeof s.outdated === "object" ? s.outdated : {} };
  } catch { return { version: 1, pairs: {}, outdated: {} }; }
}
const writeSync = (root: string, s: SyncFile) => { mkdirSync(join(root, "design"), { recursive: true }); writeFileSync(join(root, SYNC_FILE), JSON.stringify(s, null, 2) + "\n"); };

/** Every wireframe/page pairing that the flows declare, merged across flows (the same screen may appear in several). */
export function syncItems(root: string, flows = listFlows(root)): SyncItem[] {
  const s = readSync(root);
  const items = new Map<string, SyncItem>();
  for (const flow of flows) for (const step of flow.steps) {
    if (step.decision) continue;
    const key = `${step.wireframe ?? ""}|${step.page ?? ""}`;
    const item = items.get(key) ?? { wireframe: step.wireframe, wireframes: step.wireframes, page: step.page, state: "never-synced" as SyncState, outdated: [], steps: [] };
    item.steps.push({ flow: flow.id, step: step.id, title: step.title ?? step.id });
    items.set(key, item);
  }
  for (const item of items.values()) {
    const { wireframe, page } = item;
    if (!page) item.state = "no-page";
    else if (!wireframe) item.state = "no-wireframe";
    else {
      const rec = s.pairs[page];
      if (!rec || rec.wireframe !== wireframe) item.state = "never-synced";
      else {
        const w = hash(root, wireframe) !== rec.wireframeHash, p = hash(root, page) !== rec.pageHash;
        item.state = w && p ? "both-changed" : w ? "wireframe-changed" : p ? "page-changed" : "in-sync";
        item.syncedAt = rec.syncedAt;
      }
    }
    for (const [file, side] of [[page, "page"], [wireframe, "wireframe"]] as const)
      if (file && s.outdated[file]) item.outdated.push({ file, side, ...s.outdated[file] });
  }
  return [...items.values()];
}

/** The pair a file belongs to (as wireframe or page), from the flows. A plain page path also matches a step that opens it with a URL state. */
export function pairOf(root: string, file: string, flows = listFlows(root)): SyncItem | undefined {
  const items = syncItems(root, flows);
  return items.find((i) => i.wireframe === file || i.page === file) ?? items.find((i) => !!i.page && baseFile(i.page) === file);
}

function known(root: string, file: string) {
  const item = pairOf(root, file);
  if (!item) throw new Error(`${file} is not a wireframe or page of any flow in ${FLOWS_DIR}/. Add it to a flow step first.`);
  return item;
}

/** Mark one side as needing an update to match the other (the file given is the one to change). */
export function markOutdated(root: string, file: string, note?: string) {
  known(root, file);
  const s = readSync(root);
  s.outdated[file] = { ...(note ? { note } : {}), at: new Date().toISOString() };
  writeSync(root, s);
}

/** Confirm a pair is in sync now: records both hashes and clears outdated marks on both sides. */
export function markSynced(root: string, file: string) {
  const item = known(root, file);
  if (!item.wireframe || !item.page) throw new Error(`${file} has no ${item.page ? "wireframe" : "page"} in its flow step, so there is nothing to sync. Use \`sync clear\` to drop an outdated mark.`);
  const s = readSync(root);
  s.pairs[item.page] = { wireframe: item.wireframe, wireframeHash: hash(root, item.wireframe), pageHash: hash(root, item.page), syncedAt: new Date().toISOString() };
  delete s.outdated[item.page];
  delete s.outdated[item.wireframe];
  writeSync(root, s);
  return item;
}

/** Drop an outdated mark without confirming sync (for example: decided the change stays in the prototype only). */
export function clearOutdated(root: string, file: string) {
  const s = readSync(root);
  if (!s.outdated[file]) return false;
  delete s.outdated[file];
  writeSync(root, s);
  return true;
}

const STATE_TEXT: Record<SyncState, string> = {
  "no-page": "wireframe only, no page yet",
  "no-wireframe": "page without a wireframe",
  "never-synced": "never confirmed in sync",
  "in-sync": "in sync",
  "wireframe-changed": "wireframe changed since last sync",
  "page-changed": "page changed since last sync",
  "both-changed": "both changed since last sync",
};

/** The answer to "what needs syncing?": explicit marks first, then drift to review, then what is still prototype-only. */
export function syncReport(root: string): string {
  const flows = listFlows(root);
  if (!flows.length) return `No flows yet. Create one with \`cdesign flows new <id> --title "…"\` (writes ${FLOWS_DIR}/<id>.json); see \`cdesign skills get cdesign\` > Flows.`;
  const items = syncItems(root, flows);
  const where = (i: SyncItem) => i.steps.map((s) => `${s.flow}/${s.step}`).join(", ");
  const pair = (i: SyncItem) => `${i.wireframe ?? "(no wireframe)"} <-> ${i.page ?? "(no page)"}`;
  const out: string[] = [];
  const marked = items.flatMap((i) => i.outdated.map((o) => ({ i, o })));
  out.push(`Marked outdated (${marked.length}): update the file to match its counterpart, then run \`cdesign sync done <file>\``);
  for (const { i, o } of marked) out.push(`  ${o.side} ${o.file} must follow ${o.side === "page" ? i.wireframe ?? "?" : i.page ?? "?"}${o.note ? ` — ${o.note}` : ""} (marked ${o.at.slice(0, 10)}; ${where(i)})`);
  const drift = items.filter((i) => !i.outdated.length && ["wireframe-changed", "page-changed", "both-changed"].includes(i.state));
  out.push(`\nChanged since last sync (${drift.length}): review; a wireframe change does not require a page change while it is still a prototype`);
  for (const i of drift) out.push(`  ${STATE_TEXT[i.state]}: ${pair(i)} (${where(i)})`);
  const never = items.filter((i) => !i.outdated.length && i.state === "never-synced");
  out.push(`\nNever confirmed in sync (${never.length}): compare, then \`cdesign sync done <page>\` or mark the side that is behind`);
  for (const i of never) out.push(`  ${pair(i)} (${where(i)})`);
  const proto = items.filter((i) => i.state === "no-page");
  out.push(`\nWireframes without a page yet (${proto.length})`);
  for (const i of proto) out.push(`  ${i.wireframe} (${where(i)})`);
  const inSync = items.filter((i) => i.state === "in-sync").length;
  out.push(`\nIn sync: ${inSync} pair(s).`);
  const errors = flows.flatMap((f) => f.errors.map((e) => `  ${f.file}: ${e}`));
  if (errors.length) out.push(`\nFlow problems (${errors.length}):\n${errors.join("\n")}`);
  return out.join("\n");
}

export function flowText(root: string, f: Flow): string {
  const items = syncItems(root, [f]);
  const stateOf = (s: FlowStep) => items.find((i) => i.wireframe === s.wireframe && i.page === s.page);
  const lines = [`${f.title} (${f.file})${f.description ? `\n${f.description}` : ""}`, "steps:"];
  for (const s of f.steps) {
    if (s.decision) { lines.push(`  ◇ ${s.id}: ${s.decision}`); continue; }
    const st = stateOf(s);
    const marks = st?.outdated.map((o) => ` [${o.side} outdated${o.note ? `: ${o.note}` : ""}]`).join("") ?? "";
    const dev = s.wireframes ? (s.wireframes.phone === s.wireframes.desktop ? " (responsive)" : ` (${[s.wireframes.phone && "phone", s.wireframes.desktop && "desktop"].filter(Boolean).join(" + ")})`) : "";
    lines.push(`  ▢ ${s.id}${s.title ? ` "${s.title}"` : ""}: wireframe ${s.wireframe ?? "-"}${dev} | page ${s.page ?? "-"} | ${st ? STATE_TEXT[st.state] : ""}${marks}${s.note ? `\n      note: ${s.note}` : ""}`);
  }
  lines.push("links:", ...f.links.map((l) => `  ${l.from} -> ${l.to}${l.label ? ` "${l.label}"` : ""}${l.dashed ? " (dashed)" : ""}`));
  if (f.errors.length) lines.push("problems:", ...f.errors.map((e) => `  ${e}`));
  return lines.join("\n");
}

/** Short line for `cdesign page`: how the open file relates to flows and its counterpart. */
export function pageFlowNote(root: string, file: string): string {
  let item: SyncItem | undefined;
  try { item = pairOf(root, file); } catch { return ""; }
  if (!item) return "";
  const other = item.wireframe === file ? item.page : item.wireframe;
  const role = item.wireframe === file ? "wireframe" : "page";
  const marks = item.outdated.map((o) => `${o.side} marked outdated${o.note ? ` (${o.note})` : ""}`).join("; ");
  return `Flow: ${role} of ${item.steps.map((s) => `${s.flow}/${s.step}`).join(", ")}; counterpart: ${other ?? "none yet"}; sync: ${STATE_TEXT[item.state]}${marks ? `; ${marks}` : ""}. See \`cdesign sync\`.`;
}
