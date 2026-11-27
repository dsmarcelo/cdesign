import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideProject } from "./modes";

/**
 * Flows: one JSON file per canvas tab in design/flows/<id>.json. A flow is a set of frames, each a page placed on
 * the canvas at x/y with its own device size w×h. The viewer writes positions and sizes when the user drags or
 * resizes a frame; agents may add frames too. Older files with `steps`/`links` are read as frames (screens only).
 */
export type FlowFrame = { id: string; page: string; title?: string; x: number; y: number; w: number; h: number };
export type Flow = { id: string; file: string; title: string; description?: string; frames: FlowFrame[]; errors: string[] };

export const FLOWS_DIR = "design/flows";
export const DEFAULT_SIZE: [number, number] = [402, 874];
const GAP = 80;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PREVIEWABLE = /\.(tsx|html)$/;

const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
const size = (v: unknown, d: number) => Math.max(200, Math.min(4000, num(v) ?? d));

/** `page.tsx#venda/cliente` -> `page.tsx`: the part after "#" is the URL state the page opens with (a dialog or sheet showing). */
export const baseFile = (path: string) => path.split("#")[0];

export const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "frame";

function checkPage(root: string, ref: string, frame: string, errors: string[]) {
  const path = baseFile(ref);
  if (!path.startsWith("design/") || !PREVIEWABLE.test(path)) errors.push(`frame "${frame}": page must be a project-relative design/… .tsx or .html file, got "${path}"`);
  else if (!existsSync(join(root, path)) || !insideProject(root, path)) errors.push(`frame "${frame}": page file not found: ${path}`);
}

/** A frame placed after the others: to the right of the rightmost one, top-aligned with the first. */
export function nextSlot(frames: FlowFrame[], w = DEFAULT_SIZE[0]): { x: number; y: number } {
  if (!frames.length) return { x: 0, y: 0 };
  return { x: Math.max(...frames.map((f) => f.x + f.w)) + GAP, y: Math.min(...frames.map((f) => f.y)) };
}

/** `design/pages/vendas/nova-venda.tsx#venda/cliente` -> `nova-venda-venda-cliente` */
const idBase = (page: string) => { const [f, state] = page.split("#"); return f.split("/").pop()!.replace(/\.(tsx|html)$/, "") + (state ? "-" + state : ""); };

function uniqueId(frames: { id: string }[], base: string) {
  let id = slug(base), n = 2;
  while (frames.some((f) => f.id === id)) id = `${slug(base).slice(0, 59)}-${n++}`;
  return id;
}

export function readFlow(root: string, id: string): Flow {
  const file = `${FLOWS_DIR}/${id}.json`;
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(join(root, file), "utf8")); }
  catch (e) { return { id, file, title: id, frames: [], errors: [`invalid JSON: ${(e as Error).message}`] }; }
  if (!ID.test(id)) errors.push(`file name must be lowercase letters, digits and dashes: ${id}.json`);
  const frames: FlowFrame[] = [];
  const legacy = !Array.isArray(raw.frames) && Array.isArray(raw.steps);
  const list = (Array.isArray(raw.frames) ? raw.frames : legacy ? raw.steps : []) as Record<string, unknown>[];
  if (raw.frames !== undefined && !Array.isArray(raw.frames)) errors.push(`"frames" must be an array`);
  for (const f of list) {
    const page = str(f?.page);
    if (legacy && !page) continue; // decisions and wireframe-only steps of the old format have no frame
    const title = str(f?.title);
    const id = str(f?.id) ?? uniqueId(frames, title ?? (page ? idBase(page) : "frame"));
    if (!ID.test(id)) { errors.push(`frame id must be lowercase letters, digits and dashes: "${id}"`); continue; }
    if (frames.some((x) => x.id === id)) { errors.push(`duplicate frame id "${id}"`); continue; }
    if (!page) { errors.push(`frame "${id}": needs a page`); continue; }
    checkPage(root, page, id, errors);
    const w = size(f.w, DEFAULT_SIZE[0]), h = size(f.h, DEFAULT_SIZE[1]);
    const slot = nextSlot(frames, w);
    frames.push({ id, page, ...(title ? { title } : {}), x: num(f.x) ?? slot.x, y: num(f.y) ?? slot.y, w, h });
  }
  return { id, file, title: str(raw.title) ?? id, description: str(raw.description), frames, errors };
}

export function listFlows(root: string): Flow[] {
  const dir = join(root, FLOWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readFlow(root, f.slice(0, -5)));
}

const flowPath = (root: string, id: string) => {
  if (!ID.test(id)) throw new Error("Flow id must be lowercase letters, digits and dashes, e.g. nova-venda");
  return join(root, FLOWS_DIR, `${id}.json`);
};

function writeFlow(root: string, f: Pick<Flow, "id" | "title" | "description" | "frames">) {
  mkdirSync(join(root, FLOWS_DIR), { recursive: true });
  const frames = f.frames.map(({ id, page, title, x, y, w, h }) => ({ id, ...(title ? { title } : {}), page, x, y, w, h }));
  writeFileSync(flowPath(root, f.id), JSON.stringify({ title: f.title, ...(f.description ? { description: f.description } : {}), frames }, null, 2) + "\n");
}

export function newFlow(root: string, id: string, title?: string): string {
  const path = flowPath(root, id);
  if (existsSync(path)) throw new Error(`${FLOWS_DIR}/${id}.json already exists`);
  writeFlow(root, { id, title: title ?? id, frames: [] });
  return `${FLOWS_DIR}/${id}.json`;
}

/** Creates a flow from a tab title, picking a free id from it. */
export function createFlow(root: string, title: string): Flow {
  let base = slug(title) === "frame" ? "flow" : slug(title), id = base, n = 2;
  while (existsSync(join(root, FLOWS_DIR, `${id}.json`))) id = `${base.slice(0, 59)}-${n++}`;
  newFlow(root, id, title.trim() || id);
  return readFlow(root, id);
}

export function deleteFlow(root: string, id: string) {
  const path = flowPath(root, id);
  if (!existsSync(path)) throw new Error(`${FLOWS_DIR}/${id}.json does not exist`);
  rmSync(path);
}

/** Replaces a flow's title and/or frames (the viewer sends the whole frame list after a drag, resize, add or remove). */
export function updateFlow(root: string, id: string, patch: { title?: unknown; frames?: unknown }): Flow {
  if (!existsSync(flowPath(root, id))) throw new Error(`${FLOWS_DIR}/${id}.json does not exist`);
  const cur = readFlow(root, id);
  const title = str(patch.title) ?? cur.title;
  let frames = cur.frames;
  if (patch.frames !== undefined) {
    if (!Array.isArray(patch.frames)) throw new Error("frames must be an array");
    frames = [];
    for (const f of patch.frames as Record<string, unknown>[]) {
      const page = str(f?.page);
      if (!page) throw new Error("every frame needs a page");
      const errors: string[] = [];
      checkPage(root, page, page, errors);
      if (errors.length) throw new Error(errors[0]);
      const t = str(f.title);
      const fid = str(f.id) && ID.test(f.id as string) && !frames.some((x) => x.id === f.id) ? f.id as string : uniqueId(frames, t ?? idBase(page));
      const w = size(f.w, DEFAULT_SIZE[0]), h = size(f.h, DEFAULT_SIZE[1]);
      const slot = nextSlot(frames, w);
      frames.push({ id: fid, page, ...(t ? { title: t } : {}), x: num(f.x) ?? slot.x, y: num(f.y) ?? slot.y, w, h });
    }
  }
  writeFlow(root, { id, title, description: cur.description, frames });
  return readFlow(root, id);
}

/** Adds a page as a frame after the others, sized like the last frame. */
export function addFrame(root: string, id: string, page: string, title?: string): FlowFrame {
  const cur = readFlow(root, id);
  const last = cur.frames.at(-1);
  const w = last?.w ?? DEFAULT_SIZE[0], h = last?.h ?? DEFAULT_SIZE[1];
  const f = updateFlow(root, id, { frames: [...cur.frames, { page, title, ...nextSlot(cur.frames, w), w, h }] });
  return f.frames.at(-1)!;
}

export function removeFrame(root: string, id: string, ref: string): boolean {
  const cur = readFlow(root, id);
  const frames = cur.frames.filter((f) => f.id !== ref && f.page !== ref);
  if (frames.length === cur.frames.length) return false;
  updateFlow(root, id, { frames });
  return true;
}

export function flowText(f: Flow): string {
  const lines = [`${f.title} (${f.file})${f.description ? `\n${f.description}` : ""}`, "frames:"];
  for (const s of f.frames) lines.push(`  ▢ ${s.id}${s.title ? ` "${s.title}"` : ""}: ${s.page} at ${s.x},${s.y} size ${s.w}×${s.h}`);
  if (!f.frames.length) lines.push("  (none)");
  if (f.errors.length) lines.push("problems:", ...f.errors.map((e) => `  ${e}`));
  return lines.join("\n");
}

/** Short line for `cdesign page`: the flows (canvas tabs) that show the open file. */
export function pageFlowNote(root: string, file: string): string {
  const where = listFlows(root).flatMap((f) => f.frames.filter((s) => baseFile(s.page) === file).map((s) => `${f.id}/${s.id}`));
  return where.length ? `Flow: shown as ${where.join(", ")}.` : "";
}
