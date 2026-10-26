import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

// `cdesign wait` writes a heartbeat so the viewer can show whether an agent is listening
const agentPath = (root: string) => join(dataDir(root), "agent.json");
export function beat(root: string, waiting: boolean) {
  mkdirSync(dataDir(root), { recursive: true });
  writeFileSync(agentPath(root), JSON.stringify({ waiting, at: Date.now() }));
}
export function listening(root: string): boolean {
  try {
    const a = JSON.parse(readFileSync(agentPath(root), "utf8"));
    return !!a.waiting && Date.now() - a.at < 6000;
  } catch {
    return false;
  }
}

// ---------- daemon registry (one viewer process for every project) ----------
export const homeDir = () => process.env.CDESIGN_HOME ?? join(homedir(), ".cdesign");
export const daemonPath = () => join(homeDir(), "daemon.json");
const projectsPath = () => join(homeDir(), "projects.json");

/** DNS-label-safe, stable id of a project folder: "my-app-1a2b3c". It is the subdomain of the project's viewer URL. */
export const projectId = (root: string) =>
  `${(basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project").slice(0, 40)}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`;

export function readProjects(): string[] {
  try { return (JSON.parse(readFileSync(projectsPath(), "utf8")) as string[]).filter((r) => existsSync(r)); } catch { return []; }
}
export function writeProjects(roots: string[]) {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(projectsPath(), JSON.stringify(roots, null, 2));
}

// ---------- fixed tunnel domain (optional; without it `tunnel` uses a random cloudflared quick-tunnel URL) ----------
export type TunnelConfig =
  | { provider: "ngrok"; domain: string; port: number; secret: string }
  | { provider: "cloudflare"; domain: string; token: string; port: number; secret: string };
const tunnelPath = () => join(homeDir(), "tunnel.json");
export function readTunnelConfig(): TunnelConfig | null {
  try { return JSON.parse(readFileSync(tunnelPath(), "utf8")) as TunnelConfig; } catch { return null; }
}
export function writeTunnelConfig(c: TunnelConfig | null) {
  if (!c) return rmSync(tunnelPath(), { force: true });
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(tunnelPath(), JSON.stringify(c, null, 2), { mode: 0o600 }); // holds the access secret and the tunnel token
}
