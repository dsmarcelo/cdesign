import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Comment = {
  id: string;
  file: string;
  cdId: string; // "line:col" of the element's start tag in `file`
  uses: string[]; // component instances the element sits in, innermost first: "file:line:col"
  selector: string;
  snippet: string;
  text: string;
  status: "draft" | "queued" | "sent" | "done"; // draft -> queued (Send in viewer) -> sent (agent ran review) -> done
  createdAt: string;
};

export const dataDir = (root: string) => join(root, ".cdesign");
const path = (root: string) => join(dataDir(root), "comments.json");

export function readComments(root: string): Comment[] {
  try {
    const l = JSON.parse(readFileSync(path(root), "utf8")) as Comment[];
    for (const c of l) if ((c.status as string) === "open") c.status = "draft"; // older files
    return l;
  } catch {
    return [];
  }
}

export function writeComments(root: string, list: Comment[]) {
  mkdirSync(dataDir(root), { recursive: true });
  writeFileSync(path(root), JSON.stringify(list, null, 2));
}

export function update(root: string, fn: (l: Comment[]) => void) {
  const l = readComments(root);
  fn(l);
  writeComments(root, l);
}

export const commentsPath = path;
export const hasData = (root: string) => existsSync(path(root));
