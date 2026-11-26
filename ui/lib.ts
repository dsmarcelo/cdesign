export const MAP_RE = /^(map:(pages|flows)|flow:[a-z0-9-]+)$/;
export const isMapHash = (h: string | null | undefined) => MAP_RE.test(h || "");

export const pageHash = () => {
  const hash = location.hash.slice(1);
  try { return decodeURIComponent(hash); } catch { return hash; }
};

export const pagePath = (file: string) => file.split("/").map(encodeURIComponent).join("/");
export const previewPath = (file: string) => "/p/" + pagePath(file);
export const baseName = (file: string) => file.split("/").pop()!.replace(/\.(tsx|html)$/, "");

export const DEVICES: Record<string, [number, number]> = {
  "iPhone 18": [402, 874],
  "iPhone Duo inner": [626, 890],
  "iPhone Duo outer": [466, 678],
  "Galaxy Z Fold cover (thin)": [360, 840],
};

export const MAP_DEVICE: Record<"phone" | "desktop", [number, number]> = {
  phone: [402, 874],
  desktop: [1280, 800],
};

export const SYNC_STATE: Record<string, [string, string]> = {
  "no-page": ["Wireframe only", "mut"],
  "no-wireframe": ["No wireframe", "mut"],
  "never-synced": ["Never synced", "mut"],
  "in-sync": ["In sync", "ok"],
  "wireframe-changed": ["Wireframe changed", "chg"],
  "page-changed": ["Page changed", "chg"],
  "both-changed": ["Both changed", "chg"],
};

export type ViewerMode = null | "select" | "comment";
export type SidebarTab = "chat" | "files" | "comments";

export type CommentItem = {
  id: string;
  file: string;
  cdId: string;
  text: string;
  status: string;
  createdAt?: string;
};

export type ProjectInfo = { id: string; name: string; root: string; url: string };

export type FlowStep = {
  id: string;
  title?: string;
  decision?: string;
  wireframe?: string;
  wireframes?: { phone?: string; desktop?: string };
  page?: string;
};

export type FlowLink = { from: string; to: string; label?: string; dashed?: boolean };

export type Flow = {
  id: string;
  title: string;
  description?: string;
  steps: FlowStep[];
  links: FlowLink[];
  errors: string[];
};

export type OutdatedMark = { file: string; side: string; note?: string };

export type SyncItem = {
  wireframe?: string;
  page?: string;
  state: string;
  steps: { flow: string; step: string; title: string }[];
  outdated: OutdatedMark[];
};

export type FlowsData = { flows: Flow[]; sync: SyncItem[] };

export type TunnelInfo = { url?: string | null; starting?: boolean; error?: string | null };

export const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
export const ssGet = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
export const ssSet = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} };
