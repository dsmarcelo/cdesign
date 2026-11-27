export const MAP_RE = /^(map:(pages|flows)|flow:[a-z0-9-]+)$/;
/** The canvas tab a map hash opens; null for the legacy `map:*` routes (first tab). */
export const flowOfHash = (h: string | null | undefined) => h?.startsWith("flow:") ? h.slice(5) : null;
export const isMapHash = (h: string | null | undefined) => MAP_RE.test(h || "");

export const pageHash = () => {
  const hash = location.hash.slice(1);
  try { return decodeURIComponent(hash); } catch { return hash; }
};

export const pagePath = (file: string) => file.split("/").map(encodeURIComponent).join("/");
/** A flow step's page may carry a URL state after "#" (`page.tsx#venda/cliente`): the page opens with that dialog or sheet showing. */
export const splitState = (file: string): [string, string] => {
  const i = file.indexOf("#");
  return i === -1 ? [file, ""] : [file.slice(0, i), file.slice(i + 1)];
};
export const previewPath = (file: string) => {
  const [base, state] = splitState(file);
  return "/p/" + pagePath(base) + (state ? "#" + state : "");
};
export const baseName = (file: string) => file.split("/").pop()!.replace(/\.(tsx|html)$/, "");

export const DEVICES: Record<string, [number, number]> = {
  "iPhone 18": [402, 874],
  "iPhone Duo inner": [626, 890],
  "iPhone Duo outer": [466, 678],
  "Galaxy Z Fold cover (thin)": [360, 840],
};

/** Frame sizes for the canvas toolbar: picking one resizes every frame of the open tab. */
export const FRAME_PRESETS: Record<string, [number, number]> = {
  ...DEVICES,
  "Tablet": [768, 1024],
  "Laptop": [1280, 800],
  "Desktop": [1440, 900],
};

export type ViewerMode = null | "select" | "comment";
export type BoardElement = {
  page: string;
  file: string;
  cdId: string;
  uses: string[];
  selector: string;
  tag: string;
  text: string;
  size: string;
};
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

export type FlowFrame = { id: string; page: string; title?: string; x: number; y: number; w: number; h: number };
export type Flow = { id: string; title: string; description?: string; frames: FlowFrame[]; errors: string[] };
export type FlowsData = { flows: Flow[] };

export type TunnelInfo = { url?: string | null; starting?: boolean; error?: string | null };

export const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
export const ssGet = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
export const ssSet = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch {} };
