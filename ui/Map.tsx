import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  baseName,
  MAP_DEVICE,
  previewPath,
  lsGet,
  lsSet,
  ssGet,
  ssSet,
  SYNC_STATE,
  type Flow,
  type FlowsData,
  type FlowStep,
  type SyncItem,
  type ViewerMode,
} from "./lib";

type Device = "phone" | "desktop";
type Layer = "wireframe" | "page";

function stepView(s: FlowStep, layer: Layer, device: Device) {
  const other: Device = device === "phone" ? "desktop" : "phone";
  const v = s.wireframes ?? (s.wireframe ? { phone: s.wireframe, desktop: s.wireframe } : {});
  const wire: [string, Device] | null = v[device] ? [v[device]!, device] : v[other] ? [v[other]!, other] : null;
  const page: [string, Device] | null = s.page ? [s.page, device] : null;
  const [first, second] = layer === "page" ? [page, wire] : [wire, page];
  const [file, dev] = first ?? second ?? [null, device];
  const notes: string[] = [];
  if (!first) notes.push(layer === "page" ? "No page yet" : "No wireframe");
  else if (dev !== device) notes.push(dev === "phone" ? "Phone only" : "Desktop only");
  return { file, device: dev, sub: notes.join(" · ") || undefined, fallback: !first };
}

function layoutFlow(flow: Flow, layer: Layer, device: Device) {
  const ids = flow.steps.map((s) => s.id);
  const out: Record<string, number[]> = Object.fromEntries(ids.map((i) => [i, []]));
  flow.links.forEach((l, k) => out[l.from]?.push(k));
  const state: Record<string, number> = {};
  const back = new Set<number>();
  const dfs = (u: string) => {
    state[u] = 1;
    for (const k of out[u] ?? []) {
      const v = flow.links[k].to;
      if (state[v] === 1) back.add(k);
      else if (!state[v]) dfs(v);
    }
    state[u] = 2;
  };
  ids.forEach((i) => state[i] || dfs(i));
  const layerOf: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]));
  for (let n = 0; n < ids.length; n++) {
    flow.links.forEach((l, k) => {
      if (!back.has(k) && layerOf[l.to] < layerOf[l.from] + 1) layerOf[l.to] = layerOf[l.from] + 1;
    });
  }
  const row: Record<string, number> = {};
  const used = new Set<string>();
  const hasIn = new Set(flow.links.filter((_, k) => !back.has(k)).map((l) => l.to));
  let maxRow = -1;
  const take = (i: string, r: number) => {
    while (used.has(layerOf[i] + ":" + r)) r++;
    row[i] = r;
    used.add(layerOf[i] + ":" + r);
    maxRow = Math.max(maxRow, r);
  };
  const visit = (u: string, r: number) => {
    if (row[u] !== undefined) return;
    take(u, r);
    let first = true;
    for (const k of out[u] ?? []) {
      const v = flow.links[k].to;
      if (back.has(k) || row[v] !== undefined) continue;
      visit(v, first ? row[u] : maxRow + 1);
      first = false;
    }
  };
  ids.filter((i) => !hasIn.has(i)).forEach((i) => visit(i, maxRow + 1));
  ids.forEach((i) => visit(i, maxRow + 1));

  const views: Record<string, ReturnType<typeof stepView>> = {};
  const size: Record<string, [number, number]> = {};
  const D = 220;
  for (const s of flow.steps) {
    if (s.decision) size[s.id] = [D, D];
    else {
      views[s.id] = stepView(s, layer, device);
      size[s.id] = MAP_DEVICE[views[s.id].device];
    }
  }
  const GAP = 320, ROW = 260, PAD = 120;
  const rankCount = Math.max(...ids.map((i) => layerOf[i]), 0) + 1;
  const colW = Array.from({ length: rankCount }, (_, x) =>
    Math.max(D, ...ids.filter((i) => layerOf[i] === x).map((i) => size[i][0]))
  );
  const colX = colW.map((_, x) => PAD + colW.slice(0, x).reduce((a, w) => a + w + GAP, 0));
  const rowH = Math.max(...ids.map((i) => size[i][1]), D);
  // Put one-step detours side by side when the rest of the flow forms a single main row.
  const detours = ids.filter((i) => row[i] > 0 && out[i].every((k) => back.has(k)) &&
    flow.links.some((l, k) => !back.has(k) && l.to === i && row[l.from] === 0));
  const compact = detours.length > 0 && ids.every((i) => row[i] === 0 || detours.includes(i));
  const side = new Set(compact ? detours : []);
  const feedback = flow.links.flatMap((l, k) => back.has(k) && !side.has(l.from) && !side.has(l.to) ? [k] : []);
  const branch = flow.links.flatMap((l, k) => side.has(l.from) || side.has(l.to) ? [k] : []);
  const LANE = device === "desktop" ? 104 : 60;
  const captionClearance = device === "desktop" ? 520 : 320;
  const top = PAD + (feedback.length ? captionClearance + (feedback.length - 1) * LANE : 0);
  const branchTop = top + rowH + captionClearance + branch.length * LANE;
  const pos = Object.fromEntries(ids.map((i) => {
    const [w, h] = size[i], x = layerOf[i];
    return [i, { x: colX[x] + (colW[x] - w) / 2, y: top + row[i] * (rowH + ROW) + (rowH - h) / 2, w, h }];
  }));
  const mainWidth = (colX.at(-1) ?? PAD) + (colW.at(-1) ?? D) - PAD;
  let branchWidth = 0;
  if (compact) {
    const parentRank = (i: string) => layerOf[flow.links.find((l, k) => !back.has(k) && l.to === i)!.from];
    detours.sort((a, b) => parentRank(a) - parentRank(b));
    branchWidth = detours.reduce((sum, i) => sum + size[i][0], 0) + (detours.length - 1) * GAP;
    let x = PAD + Math.max(0, (mainWidth - branchWidth) / 2);
    for (const i of detours) {
      pos[i].x = x;
      pos[i].y = branchTop + (rowH - pos[i].h) / 2;
      x += pos[i].w + GAP;
    }
  }
  const width = Math.max(mainWidth, branchWidth) + 2 * PAD;
  const height = PAD + (compact ? branchTop + rowH : top + (maxRow + 1) * rowH + Math.max(0, maxRow) * ROW);

  const edges = flow.links.map((l, k) => {
    const from = pos[l.from], to = pos[l.to];
    const branchLane = branch.indexOf(k);
    const feedbackLane = feedback.indexOf(k);
    if (branchLane !== -1 || feedbackLane !== -1) {
      const below = branchLane !== -1;
      const lane = below ? top + rowH + 44 + branchLane * LANE : top - captionClearance - feedbackLane * LANE;
      const sidePort = (id: string, p: typeof from, source: boolean) => {
        const sign = source ? 1 : -1;
        const x = source ? p.x + p.w : p.x;
        const rank = layerOf[id];
        const columnEdge = colX[rank] + (source ? colW[rank] : 0);
        const offset = 44 + 56 * feedbackLane / Math.max(1, feedback.length);
        return { x, y: p.y + p.h * (below ? 0.22 : 0.26), stem: below ? x + sign * 50 : columnEdge + sign * offset };
      };
      const bottomPort = (id: string, p: typeof from) => {
        const links = branch.filter((index) => {
          const link = flow.links[index];
          return link.from === id || link.to === id;
        });
        const x = p.x + p.w * (links.indexOf(k) + 1) / (links.length + 1);
        return { x, y: p.y + p.h, stem: x };
      };
      const start = below && !side.has(l.from) ? bottomPort(l.from, from) : sidePort(l.from, from, true);
      const end = below && !side.has(l.to) ? bottomPort(l.to, to) : sidePort(l.to, to, false);
      const sx = start.stem, tx = end.stem;
      return {
        d: `M${start.x} ${start.y} H${sx} V${lane} H${tx} V${end.y} H${end.x}`,
        dashed: back.has(k) || !!l.dashed,
        label: l.label,
        mid: [(sx + tx) / 2, lane] as [number, number],
      };
    }
    const sx = from.x + from.w, sy = from.y + from.h / 2;
    const tx = to.x, ty = to.y + to.h / 2;
    const c = Math.max(80, (tx - sx) / 2);
    return {
      d: `M${sx} ${sy} C${sx + c} ${sy},${tx - c} ${ty},${tx} ${ty}`,
      dashed: !!l.dashed,
      label: l.label,
      mid: [(sx + tx) / 2, (sy + ty) / 2] as [number, number],
    };
  });

  return { width, height, pos, views, edges };
}

function EdgeSvg({ paths }: { paths: { d: string; dashed?: boolean }[] }) {
  return (
    <svg className="edges">
      <defs>
        <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="currentColor" />
        </marker>
      </defs>
      {paths.map((p, i) => (
        <path key={i} d={p.d} markerEnd="url(#ah)" strokeDasharray={p.dashed ? "14 12" : undefined} />
      ))}
    </svg>
  );
}

function ScreenCard({
  file,
  title,
  device,
  cls,
  sub,
  item,
  style,
  mode,
  onOpen,
  onFrameLoad,
  registerFrame,
}: {
  file: string | null;
  title: string;
  device: Device;
  cls?: string;
  sub?: string;
  item?: SyncItem;
  style?: React.CSSProperties;
  mode: ViewerMode;
  onOpen: (file: string) => void;
  onFrameLoad: (f: HTMLIFrameElement) => void;
  registerFrame: (el: HTMLIFrameElement | null) => void;
}) {
  const [w, h] = MAP_DEVICE[device];
  const st = item ? SYNC_STATE[item.state] : null;
  return (
    <div data-screen={file ?? undefined} className={`node screen ${device}${cls ? " " + cls : ""}`} style={style}>
      <div className="cap">
        <button
          type="button"
          className="open"
          title={file ? "Open " + file : title}
          disabled={!file}
          onClick={() => file && onOpen(file)}
        >
          {title}
        </button>
        {item && st && (
          <span
            className={`badge ${item.outdated.length ? "warn" : st[1]}`}
            title={item.outdated.length ? item.outdated.map((o) => `${o.file}${o.note ? ": " + o.note : ""}`).join("\n") : undefined}
          >
            {item.outdated.length ? `${item.outdated.map((o) => o.side).join(" + ")} outdated` : st[0]}
          </span>
        )}
        {sub && <span className="badge mut">{sub}</span>}
      </div>
      <div
        className={`thumb ${device}${!file ? " empty" : ""}`}
        style={{ width: w, height: h }}
        onDoubleClick={() => {
          if (file && !mode) onOpen(file);
        }}
      >
        {!file ? (
          <span>No file yet</span>
        ) : (
          <iframe
            ref={registerFrame}
            title={file}
            data-src={previewPath(file)}
            data-file={file}
            onLoad={(e) => onFrameLoad(e.currentTarget)}
          />
        )}
      </div>
    </div>
  );
}

export function ProjectMap({
  visible,
  route,
  data,
  pages,
  mode,
  onOpen,
  onSyncAction,
  onFrameLoad,
  onNavigateHash,
}: {
  visible: boolean;
  route: string;
  data: FlowsData;
  pages: string[];
  mode: ViewerMode;
  onOpen: (file: string) => void;
  onSyncAction: (action: "done" | "outdated" | "clear", file: string, note?: string) => void;
  onFrameLoad: (f: HTMLIFrameElement) => void;
  onNavigateHash: (h: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const position = useRef({ x: 0, y: 0 });
  const cameras = useRef<Record<string, { x: number; y: number; zoom: number }>>({});
  const space = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const [hand, setHand] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selection, setSelection] = useState<HTMLElement | null>(null);
  const zoomRef = useRef(1);
  const obsRef = useRef<IntersectionObserver | null>(null);
  const iframesRef = useRef<Set<HTMLIFrameElement>>(new Set());

  const [device, setDevice] = useState<Device>(() => (ssGet("cd-map-device") === "desktop" ? "desktop" : "phone"));
  const [layer, setLayer] = useState<Layer>(() => (ssGet("cd-layer") === "page" ? "page" : "wireframe"));
  const [panelOpen, setPanelOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);

  const cameraKey = `cd-map-camera:${route}`;
  const isPages = route === "map:pages";
  const flowId = route.startsWith("flow:") ? route.slice(5) : null;
  const activeFlow = useMemo(
    () => (isPages ? null : data.flows.find((f) => f.id === flowId) ?? data.flows[0] ?? null),
    [isPages, data.flows, flowId]
  );

  const itemOf = (file: string | null) => (file ? data.sync.find((i) => i.wireframe === file || i.page === file) : undefined);

  const applyZoom = (z: number) => {
    zoomRef.current = z;
    const canvas = canvasRef.current;
    if (canvas) {
      (canvas.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
      canvas.style.setProperty("--z", String(Math.max(z, 0.2)));
    }
    setZoomPct(Math.round(z * 100));
  };

  const panTo = (x: number, y: number, save = true) => {
    position.current = { x, y };
    if (save) {
      const camera = cameras.current[route] = { x, y, zoom: zoomRef.current };
      lsSet(cameraKey, JSON.stringify(camera));
    }
    if (canvasRef.current?.parentElement) canvasRef.current.parentElement.style.translate = `${x}px ${y}px`;
  };

  const setZoomAt = (z: number, x?: number, y?: number, dx = 0, dy = 0) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = Math.max(0.02, Math.min(16, z));
    const ratio = next / zoomRef.current;
    const cx = x ?? viewport.clientWidth / 2, cy = y ?? viewport.clientHeight / 2;
    const from = position.current;
    applyZoom(next);
    panTo(cx + (from.x - cx) * ratio + dx, cy + (from.y - cy) * ratio + dy);
  };

  const fit = (target?: HTMLElement, save = true) => {
    const viewport = viewportRef.current, canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const bounds = (target ?? canvas).getBoundingClientRect();
    const origin = canvas.getBoundingClientRect();
    const old = zoomRef.current;
    const width = Math.max(1, bounds.width / old), height = Math.max(1, bounds.height / old);
    const z = Math.max(0.02, Math.min(target ? 16 : 1, (viewport.clientWidth - 32) / width,
      (viewport.clientHeight - 32) / height));
    applyZoom(z);
    panTo((viewport.clientWidth - width * z) / 2 - (bounds.left - origin.left) / old * z,
      (viewport.clientHeight - height * z) / 2 - (bounds.top - origin.top) / old * z, save);
  };

  useLayoutEffect(() => {
    if (!visible) return;
    let saved = cameras.current[route];
    const raw = lsGet(cameraKey);
    if (!saved && raw) {
      try {
        const camera = JSON.parse(raw);
        if (Number.isFinite(camera?.x) && Number.isFinite(camera?.y) &&
          Number.isFinite(camera.zoom) && camera.zoom >= 0.02 && camera.zoom <= 16) {
          saved = cameras.current[route] = camera;
        }
      } catch { /* Invalid saved views fall back to Fit. */ }
    }
    applyZoom(saved?.zoom ?? 1);
    panTo(saved?.x ?? 0, saved?.y ?? 0, false);
    const viewport = viewportRef.current;
    if (saved || !viewport) return;
    fit(undefined, false);
    const observer = new ResizeObserver(() => {
      if (!cameras.current[route]) fit(undefined, false);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [visible, route, device, layer, data, pages]);

  useEffect(() => {
    setSelection(null);
    pointers.current.clear();
    viewportRef.current?.classList.remove("panning");
    dragged.current = false;
    space.current = false;
    setSpaceHeld(false);
  }, [visible, route, device, layer, mode]);

  useEffect(() => {
    if (!visible || !viewportRef.current) return;
    const root = viewportRef.current;
    const obs = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          const el = e.target as HTMLIFrameElement;
          if (e.isIntersecting && !el.src && el.dataset.src) {
            el.src = el.dataset.src;
            obs.unobserve(el);
          }
        }),
      { root, rootMargin: "600px" }
    );
    obsRef.current = obs;
    for (const el of iframesRef.current) {
      if (!el.src && el.dataset.src) obs.observe(el);
    }
    return () => {
      obs.disconnect();
      obsRef.current = null;
    };
  }, [visible, route, device, layer, data, pages]);

  const registerFrame = (el: HTMLIFrameElement | null) => {
    if (el) {
      iframesRef.current.add(el);
      if (obsRef.current && !el.src && el.dataset.src) obsRef.current.observe(el);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const touch = e.pointerType === "touch";
    const pan = e.button === 1 || (e.button === 0 && (space.current || hand || touch));
    if (!pointers.current.size) dragged.current = false;
    if (!pan) return;
    if (!touch) e.preventDefault();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Defer capture on touch so a stationary tap still reaches its original target.
    if (!touch || pointers.current.size > 1) {
      for (const id of pointers.current.keys()) e.currentTarget.setPointerCapture(id);
      dragged.current = !touch || pointers.current.size > 1;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const points = pointers.current;
    const previous = points.get(e.pointerId);
    if (!previous) return;
    const current = { x: e.clientX, y: e.clientY };
    const dx = current.x - previous.x, dy = current.y - previous.y;
    if (!dragged.current && Math.hypot(dx, dy) < 5) return;
    dragged.current = true;
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("panning");
    points.set(e.pointerId, current);
    const other = [...points].find(([id]) => id !== e.pointerId)?.[1];
    if (other && points.size === 2) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(current.x - other.x, current.y - other.y);
      const r = e.currentTarget.getBoundingClientRect();
      setZoomAt(zoomRef.current * after / Math.max(1, before),
        (previous.x + other.x) / 2 - r.left, (previous.y + other.y) / 2 - r.top, dx / 2, dy / 2);
    } else if (points.size === 1) {
      panTo(position.current.x + dx, position.current.y + dy);
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === "lostpointercapture" && e.target !== e.currentTarget) return;
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) e.currentTarget.classList.remove("panning");
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!visible || !viewport) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
      if (e.ctrlKey || e.metaKey || (!e.shiftKey && e.deltaX === 0)) {
        const r = viewport.getBoundingClientRect();
        setZoomAt(zoomRef.current * Math.exp(-e.deltaY * unit / 300), e.clientX - r.left, e.clientY - r.top);
      } else {
        const sideways = e.shiftKey && !e.deltaX;
        panTo(position.current.x - (sideways ? e.deltaY : e.deltaX) * unit,
          position.current.y - (sideways ? 0 : e.deltaY) * unit);
      }
    };
    let previousScale = 1;
    const gestureStart = (e: Event) => {
      e.preventDefault();
      previousScale = 1;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      const { scale, clientX, clientY } = e as MouseEvent & { scale: number };
      const r = viewport.getBoundingClientRect();
      setZoomAt(zoomRef.current * scale / previousScale, clientX - r.left, clientY - r.top);
      previousScale = scale;
    };
    const keyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (e.defaultPrevented || e.isComposing || e.altKey || document.querySelector("dialog[open]") ||
        (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,textarea,select,.sync-panel")))) return;
      const modified = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!modified && key === "escape" && selection && !mode) setSelection(null);
      else if (!modified && e.code === "Space") {
        if (target instanceof Element && target.closest("button,a")) return;
        space.current = true;
        setSpaceHeld(true);
      } else if (!modified && key === "h") setHand(true);
      else if (!modified && key === "v") setHand(false);
      else if (!modified && e.shiftKey && (e.code === "Digit1" || key === "!")) fit();
      else if (!modified && e.shiftKey && (e.code === "Digit2" || key === "@")) {
        if (selection && viewport.contains(selection)) fit(selection);
      } else if (!modified && (key === "0" || (e.shiftKey && e.code === "Digit0"))) setZoomAt(1);
      else if (key === "+" || key === "=") setZoomAt(zoomRef.current * 1.25);
      else if (key === "-" || key === "_") setZoomAt(zoomRef.current / 1.25);
      else if (!modified && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
        const step = e.shiftKey ? 100 : 20;
        panTo(position.current.x + (key === "arrowleft" ? step : key === "arrowright" ? -step : 0),
          position.current.y + (key === "arrowup" ? step : key === "arrowdown" ? -step : 0));
      } else return;
      e.preventDefault();
    };
    const releaseSpace = () => {
      space.current = false;
      setSpaceHeld(false);
    };
    const keyUp = (e: KeyboardEvent) => { if (e.code === "Space") releaseSpace(); };
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("gesturestart", gestureStart);
    viewport.addEventListener("gesturechange", gestureChange);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", releaseSpace);
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("gesturestart", gestureStart);
      viewport.removeEventListener("gesturechange", gestureChange);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  }, [visible, route, selection, mode]);

  useEffect(() => {
    selection?.classList.add("board-selected");
    return () => selection?.classList.remove("board-selected");
  }, [selection]);

  const pageGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const f of pages) {
      const parts = f.slice("design/pages/".length).split("/");
      const g = parts.length > 1 ? parts[0] : "";
      const arr = groups.get(g) ?? [];
      arr.push(f);
      groups.set(g, arr);
    }
    return [...groups].sort(([a], [b]) => Number(a === "") - Number(b === "") || a.localeCompare(b));
  }, [pages]);

  const flowLayout = useMemo(
    () => (activeFlow ? layoutFlow(activeFlow, layer, device) : null),
    [activeFlow, layer, device]
  );

  const marked = data.sync.filter((i) => i.outdated.length).length;
  const drift = data.sync.filter((i) => /changed/.test(i.state)).length;

  const syncSections: [string, (i: SyncItem) => boolean][] = [
    ["Marked outdated", (i) => i.outdated.length > 0],
    ["Changed since last sync", (i) => !i.outdated.length && /changed/.test(i.state)],
    ["Never synced", (i) => !i.outdated.length && i.state === "never-synced"],
    ["Wireframe only", (i) => i.state === "no-page" && !i.outdated.length],
    ["In sync", (i) => i.state === "in-sync" && !i.outdated.length],
  ];

  return (
    <div
      id="map"
      ref={rootRef}
      aria-label="Project map"
      className={panelOpen ? "panel" : undefined}
    >
      {visible && (
        <>
          <div className="map-head">
            {isPages ? (
              <>
                <h2>Pages</h2>
                <small>Grouped by folder in design/pages</small>
              </>
            ) : (
              <>
                <h2>Flows</h2>
                {data.flows.length > 0 && (
                  <>
                    <div className="chips" title={activeFlow?.description || undefined}>
                      {data.flows.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          aria-pressed={f === activeFlow}
                          className={f.errors.length ? "bad" : undefined}
                          title={f.errors.length ? f.errors.join("\n") : undefined}
                          onClick={() => onNavigateHash("flow:" + f.id)}
                        >
                          {f.title}
                        </button>
                      ))}
                    </div>
                    <div className="seg">
                      {(
                        [
                          ["wireframe", "Wireframes"],
                          ["page", "Screens"],
                        ] as const
                      ).map(([v, t]) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={layer === v}
                          onClick={() => {
                            ssSet("cd-layer", v);
                            setLayer(v);
                          }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className={`sync-btn${marked ? " warn" : ""}`}
                      title="What needs syncing between wireframes and pages"
                      onClick={() => setPanelOpen((o) => !o)}
                    >
                      {marked ? `${marked} outdated` : drift ? `${drift} changed` : "Sync"}
                    </button>
                  </>
                )}
              </>
            )}

            <div className="seg">
              {(
                [
                  ["phone", "Phone", "Show phone screens (iPhone 18, 402 × 874)"],
                  ["desktop", "Desktop", "Show desktop screens (1280 × 800)"],
                ] as const
              ).map(([v, t, tip]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={device === v}
                  title={tip}
                  onClick={() => {
                    if (device === v) return;
                    ssSet("cd-map-device", v);
                    delete cameras.current[route];
                    lsSet(cameraKey, "");
                    setDevice(v);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="zoom grp">
              <button type="button" aria-pressed={hand} title="Hand tool (H) · Select (V)" onClick={() => setHand(!hand)}>Hand</button>
              <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setZoomAt(zoomRef.current / 1.25)}>
                −
              </button>
              <button type="button" aria-label="Actual size" title="Actual size" onClick={() => setZoomAt(1)}>
                {zoomPct}%
              </button>
              <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setZoomAt(zoomRef.current * 1.25)}>
                +
              </button>
              <button
                type="button"
                aria-label="Fit to window"
                title="Fit to window"
                onClick={() => fit()}
              >
                Fit
              </button>
            </div>
          </div>

          <div
            ref={viewportRef}
            className={`map-viewport${hand || spaceHeld ? " hand" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onLostPointerCapture={endPointer}
            onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
            onDoubleClickCapture={(e) => {
              if (dragged.current || hand || space.current) e.stopPropagation();
            }}
            onClickCapture={(e) => {
              if (e.detail > 0 && (dragged.current || hand || space.current)) {
                e.preventDefault();
                e.stopPropagation();
              } else if (!mode) {
                setSelection((e.target as Element).closest<HTMLElement>("[data-screen]"));
              }
            }}
          >
            <div className="map-position">
              <div className={`map-canvas${isPages ? " groups" : ""}`} ref={canvasRef}>
                {isPages ? (
                  !pages.length ? (
                    <p className="empty-map">No pages in design/pages yet.</p>
                  ) : (
                    pageGroups.map(([g, files]) => {
                      const hub = files.find((f) => baseName(f) === g) ?? files.find((f) => baseName(f) === "index") ?? files[0];
                      const rest = files.filter((f) => f !== hub).sort();
                      const [W, H] = MAP_DEVICE[device], GAP = 120, DOWN = 260;
                      const rowW = Math.max(W, rest.length * W + Math.max(0, rest.length - 1) * GAP);
                      const hx = (rowW - W) / 2;
                      const paths = rest.map((_, i) => {
                        const x = i * (W + GAP), y = H + DOWN;
                        const sx = hx + W / 2, sy = H, tx = x + W / 2, ty = y - 8;
                        return { d: `M${sx} ${sy} C${sx} ${sy + DOWN / 2},${tx} ${ty - DOWN / 2},${tx} ${ty}` };
                      });
                      return (
                        <section key={g || "__root"} className="group">
                          <h3>{g || "design/pages"}</h3>
                          <div className="group-body" style={{ width: rowW, height: rest.length ? 2 * H + DOWN : H }}>
                            <EdgeSvg paths={paths} />
                            <ScreenCard
                              file={hub}
                              title={baseName(hub)}
                              device={device}
                              cls="hub"
                              item={itemOf(hub)}
                              style={{ left: hx, top: 0 }}
                              mode={mode}
                              onOpen={onOpen}
                              onFrameLoad={onFrameLoad}
                              registerFrame={registerFrame}
                            />
                            {rest.map((f, i) => (
                              <ScreenCard
                                key={f}
                                file={f}
                                title={baseName(f)}
                                device={device}
                                item={itemOf(f)}
                                style={{ left: i * (W + GAP), top: H + DOWN }}
                                mode={mode}
                                onOpen={onOpen}
                                onFrameLoad={onFrameLoad}
                                registerFrame={registerFrame}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })
                  )
                ) : !activeFlow ? (
                  <div className="empty-map">
                    <p>
                      No flows yet. A flow is one file, <code>design/flows/&lt;id&gt;.json</code>, listing screens (wireframe + page) and decisions joined by labeled arrows.
                    </p>
                    <p>
                      Ask your agent: <em>“create the flow for …”</em>, or run <code>cdesign flows new &lt;id&gt;</code>.
                    </p>
                  </div>
                ) : (
                  <>
                    {activeFlow.errors.length > 0 && <div className="flow-errors">{activeFlow.errors.join("\n")}</div>}
                    {flowLayout && (
                      <div className="flow-body" style={{ width: flowLayout.width, height: flowLayout.height }}>
                        <EdgeSvg paths={flowLayout.edges} />
                        {flowLayout.edges.map(
                          (e, i) =>
                            e.label && (
                              <span key={i} className="elabel" style={{ left: e.mid[0], top: e.mid[1] }}>
                                {e.label}
                              </span>
                            )
                        )}
                        {activeFlow.steps.map((s) => {
                          const p = flowLayout.pos[s.id];
                          if (s.decision) {
                            return (
                              <div
                                key={s.id}
                                className="node decision"
                                title={s.decision}
                                style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
                              >
                                <div className="dia" />
                                <span>{s.decision}</span>
                              </div>
                            );
                          }
                          const v = flowLayout.views[s.id];
                          return (
                            <ScreenCard
                              key={s.id}
                              file={v.file}
                              title={s.title ?? s.id}
                              device={v.device}
                              cls={v.fallback ? "fallback" : ""}
                              sub={v.sub}
                              item={data.sync.find((i) => i.wireframe === s.wireframe && i.page === s.page)}
                              style={{ left: p.x, top: p.y }}
                              mode={mode}
                              onOpen={onOpen}
                              onFrameLoad={onFrameLoad}
                              registerFrame={registerFrame}
                            />
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {panelOpen && !isPages && data.flows.length > 0 && (
            <aside className="sync-panel" style={{ top: rootRef.current?.getBoundingClientRect().top ?? 0 }}>
              <button type="button" className="close ic" aria-label="Close" onClick={() => setPanelOpen(false)}>
                ×
              </button>
              <h3>Wireframes ↔ pages</h3>
              <p className="hint">
                A wireframe change does not require a page change. Only marked items need an update. Agents read this with cdesign sync.
              </p>
              {syncSections.map(([label, pred]) => {
                const list = data.sync.filter(pred);
                if (!list.length) return null;
                return (
                  <div key={label}>
                    <h4>
                      {label} ({list.length})
                    </h4>
                    {list.map((i, idx) => (
                      <div key={idx} className="srow">
                        <b>{i.steps.map((s) => s.title).join(", ")}</b>
                        {[i.wireframe, i.page].filter(Boolean).map((f) => (
                          <button key={f} type="button" className="link" onClick={() => onOpen(f!)}>
                            {f!.replace(/^design\//, "")}
                          </button>
                        ))}
                        {i.outdated.map((o) => (
                          <small key={o.file} className="warn">
                            {o.side} outdated{o.note ? ": " + o.note : ""}
                          </small>
                        ))}
                        {!i.outdated.length && /changed/.test(i.state) && <small>{SYNC_STATE[i.state]?.[0]}</small>}
                        <div className="acts">
                          {i.wireframe && i.page && (i.state !== "in-sync" || i.outdated.length > 0) && (
                            <button type="button" onClick={() => onSyncAction("done", i.page!)}>
                              Mark synced
                            </button>
                          )}
                          {i.outdated.map((o) => (
                            <button key={o.file} type="button" onClick={() => onSyncAction("clear", o.file)}>
                              Clear {o.side} mark
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </aside>
          )}
        </>
      )}
    </div>
  );
}

export function FlowBar({
  cur,
  inMap,
  data,
  onSelectFile,
  onNavigateHash,
  onSyncAction,
}: {
  cur: string | null;
  inMap: boolean;
  data: FlowsData;
  onSelectFile: (file: string) => void;
  onNavigateHash: (hash: string) => void;
  onSyncAction: (action: "done" | "outdated" | "clear", file: string, note?: string) => void;
}) {
  const item = cur ? data.sync.find((i) => i.wireframe === cur || i.page === cur) : undefined;
  if (!cur || !item || inMap) return <div id="flowbar" hidden />;

  const isWire = item.wireframe === cur;
  const nextLinks: { label: string; title: string; file: string }[] = [];
  for (const s of item.steps) {
    const f = data.flows.find((x) => x.id === s.flow);
    if (!f) continue;
    const go = (id: string, label?: string, depth = 0) => {
      const st = f.steps.find((x) => x.id === id);
      if (!st || depth > 3) return;
      if (st.decision) {
        for (const l of f.links.filter((l) => l.from === id)) {
          go(l.to, [label, l.label].filter(Boolean).join(" · "), depth + 1);
        }
        return;
      }
      const file = (isWire ? st.wireframe : st.page) ?? st.wireframe ?? st.page;
      if (!file) return;
      nextLinks.push({ label: `${label ? label + " → " : "→ "}${st.title ?? st.id}`, title: file, file });
    };
    for (const l of f.links.filter((l) => l.from === s.step && l.to !== s.step)) go(l.to, l.label);
  }
  const [stLabel, stCls] = SYNC_STATE[item.state] ?? [item.state, "mut"];

  return (
    <div id="flowbar">
      <span className="where">
        {item.steps.map((s, idx) => {
          const f = data.flows.find((x) => x.id === s.flow);
          return (
            <button key={idx} type="button" className="link" onClick={() => onNavigateHash("flow:" + s.flow)}>
              {f?.title ?? s.flow} › {s.title}
            </button>
          );
        })}
      </span>
      {nextLinks.length > 0 && (
        <span className="next">
          {nextLinks.map((n, idx) => (
            <button key={idx} type="button" className="chip" title={n.title} onClick={() => onSelectFile(n.file)}>
              {n.label}
            </button>
          ))}
        </span>
      )}
      <span className="right">
        {item.wireframe && item.page && (
          <span className="seg">
            {(
              [
                [item.wireframe, "Wireframe"],
                [item.page, "Screen"],
              ] as const
            ).map(([file, t]) => (
              <button
                key={file}
                type="button"
                aria-pressed={file === cur}
                onClick={() => file !== cur && onSelectFile(file)}
              >
                {t}
              </button>
            ))}
          </span>
        )}
        <span className={`badge ${stCls}`}>{stLabel}</span>
        {item.wireframe && item.page && item.state !== "in-sync" && (
          <button type="button" onClick={() => onSyncAction("done", item.page!)}>
            Mark synced
          </button>
        )}
        {!item.outdated.some((o) => o.file === cur) && (
          <button
            type="button"
            onClick={() => {
              const note = prompt(`What must change in ${cur}? (optional note for the agent)`, "");
              if (note !== null) onSyncAction("outdated", cur, note.trim() || undefined);
            }}
          >
            Mark this {isWire ? "wireframe" : "page"} outdated
          </button>
        )}
      </span>
      {item.outdated.map((o) => (
        <div key={o.file} className="outdated">
          <span>
            {o.file === cur ? "This " + o.side : "The " + o.side} is marked outdated{o.note ? ": " + o.note : ""}
          </span>
          {o.file !== cur && (
            <button type="button" className="link" onClick={() => onSelectFile(o.file)}>
              {o.file.replace(/^design\//, "")}
            </button>
          )}
          <button type="button" onClick={() => onSyncAction("clear", o.file)}>
            Clear mark
          </button>
        </div>
      ))}
    </div>
  );
}
