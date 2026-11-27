import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  MAP_DEVICE,
  previewPath,
  splitState,
  lsGet,
  lsSet,
  ssGet,
  ssSet,
  SYNC_STATE,
  type BoardElement,
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

/**
 * Lays a flow out as a tree that grows to the right: each screen's destinations sit in the next column, stacked
 * top to bottom in link order, with the screen centred on them, joined by elbow arrows. The tree comes from a
 * breadth-first walk from the entry step, so a screen sits next to the first screen that opens it.
 * Links back to the opener ("Concluir", "Voltar") become a ↩ badge on the screen instead of a second arrow;
 * links between siblings bend around the right side of the column; any other link runs in a lane above the flow.
 */
function layoutFlow(flow: Flow, layer: Layer, device: Device) {
  const ids = flow.steps.map((s) => s.id);
  const out: Record<string, number[]> = Object.fromEntries(ids.map((i) => [i, []]));
  flow.links.forEach((l, k) => out[l.from]?.push(k));

  const parent: Record<string, string> = {};
  const depth: Record<string, number> = {};
  const kids: Record<string, string[]> = Object.fromEntries(ids.map((i) => [i, []]));
  const tree = new Set<number>();
  const roots: string[] = [];
  const seen = new Set<string>();
  const walk = (root: string) => {
    roots.push(root);
    seen.add(root);
    depth[root] = 0;
    for (const queue = [root]; queue.length; ) {
      const u = queue.shift()!;
      for (const k of out[u]) {
        const v = flow.links[k].to;
        if (seen.has(v)) continue;
        seen.add(v);
        parent[v] = u;
        depth[v] = depth[u] + 1;
        kids[u].push(v);
        tree.add(k);
        queue.push(v);
      }
    }
  };
  const hasIn = new Set(flow.links.filter((l) => l.from !== l.to).map((l) => l.to));
  for (const i of [ids[0], ...ids.filter((i) => !hasIn.has(i)), ...ids]) if (i !== undefined && !seen.has(i)) walk(i);

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

  const title = (id: string) => {
    const st = flow.steps.find((s) => s.id === id);
    return st?.title ?? st?.decision ?? id;
  };
  const returns: Record<string, { label?: string; to: string }[]> = {};
  const bracket: number[] = [];
  const lanes: number[] = [];
  flow.links.forEach((l, k) => {
    if (tree.has(k)) return;
    if (l.from === l.to || parent[l.from] === l.to) (returns[l.from] ??= []).push({ label: l.label, to: title(l.to) });
    else if (depth[l.from] === depth[l.to]) bracket.push(k);
    else lanes.push(k);
  });

  const GAP = device === "desktop" ? 480 : 420;
  const VGAP = device === "desktop" ? 600 : 560;
  const PAD = 120;
  const LANE = device === "desktop" ? 104 : 60;
  const captionClearance = device === "desktop" ? 520 : 320;
  const cols = Math.max(...ids.map((i) => depth[i]), 0) + 1;
  const colW = Array.from({ length: cols }, (_, x) => Math.max(D, ...ids.filter((i) => depth[i] === x).map((i) => size[i][0])));
  const colX = colW.map((_, x) => PAD + colW.slice(0, x).reduce((a, w) => a + w + GAP, 0));
  const colEnd = (id: string) => colX[depth[id]] + colW[depth[id]];

  const extent: Record<string, number> = {};
  const measure = (u: string): number => {
    const k = kids[u].reduce((sum, v) => sum + measure(v), 0) + Math.max(0, kids[u].length - 1) * VGAP;
    return (extent[u] = Math.max(size[u][1], k));
  };
  const top = PAD + (lanes.length ? captionClearance + (lanes.length - 1) * LANE : 0) + 80;
  const pos: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const place = (u: string, y0: number) => {
    const [w, h] = size[u];
    const block = kids[u].reduce((sum, v) => sum + extent[v], 0) + Math.max(0, kids[u].length - 1) * VGAP;
    let y = y0 + (extent[u] - block) / 2;
    for (const v of kids[u]) {
      place(v, y);
      y += extent[v] + VGAP;
    }
    let mid = y0 + extent[u] / 2;
    if (kids[u].length) {
      const first = pos[kids[u][0]], last = pos[kids[u].at(-1)!];
      mid = (first.y + first.h / 2 + last.y + last.h / 2) / 2;
    }
    const x = colX[depth[u]] + (colW[depth[u]] - w) / 2;
    pos[u] = { x, y: Math.min(Math.max(mid - h / 2, y0), y0 + extent[u] - h), w, h };
  };
  let y = top;
  for (const r of roots) {
    measure(r);
    place(r, y);
    y += extent[r] + VGAP * 2;
  }
  const width = (colX.at(-1) ?? PAD) + (colW.at(-1) ?? D) + PAD;
  const height = y - VGAP * 2 + PAD;

  type Edge = { d: string; dashed?: boolean; label?: string; mid: [number, number] };
  const edges: Edge[] = [];
  const centre = (id: string) => pos[id].y + pos[id].h / 2;
  // Elbows from each screen to its destinations: ports spread down the right side in child order, and the
  // vertical runs step right toward the middle of the fan so no two arrows cross.
  for (const u of ids) {
    const ks = out[u].filter((k) => tree.has(k));
    if (!ks.length) continue;
    const p = pos[u], sx = p.x + p.w, edge = colEnd(u);
    const ports = ks.map((k, i) =>
      ks.length === 1
        ? Math.min(Math.max(centre(flow.links[k].to), p.y + p.h * 0.15), p.y + p.h * 0.85)
        : p.y + p.h * (0.25 + (0.5 * i) / (ks.length - 1))
    );
    const up = ks.map((k, i) => [k, i] as const).filter(([k, i]) => centre(flow.links[k].to) < ports[i] - 1);
    const down = ks.map((k, i) => [k, i] as const).filter(([k, i]) => centre(flow.links[k].to) > ports[i] + 1).reverse();
    const step = Math.min(44, (GAP * 0.45 - 48) / Math.max(1, up.length, down.length));
    const stem: Record<number, number> = {};
    up.forEach(([k], a) => (stem[k] = edge + 48 + a * step));
    down.forEach(([k], b) => (stem[k] = edge + 48 + b * step));
    ks.forEach((k, i) => {
      const l = flow.links[k], t = pos[l.to], ty = centre(l.to), py = ports[i];
      const xv = stem[k];
      edges.push(
        xv === undefined
          ? { d: `M${sx} ${py} H${t.x}`, dashed: !!l.dashed, label: l.label, mid: [(edge + t.x) / 2, py] }
          : { d: `M${sx} ${py} H${xv} V${ty} H${t.x}`, dashed: !!l.dashed, label: l.label, mid: [(xv + t.x) / 2, ty] }
      );
    });
  }
  // Sibling links bend around the right side of their column and enter the target from the right.
  bracket.forEach((k, n) => {
    const l = flow.links[k], a = pos[l.from], b = pos[l.to];
    const x = colEnd(l.from) + GAP * 0.55 + n * 36;
    const sy = a.y + a.h * 0.8, ty = b.y + b.h * 0.2;
    edges.push({ d: `M${a.x + a.w} ${sy} H${x} V${ty} H${b.x + b.w}`, dashed: true, label: l.label, mid: [x, (sy + ty) / 2] });
  });
  // Everything else (long returns, skips) runs in its own lane above the flow.
  lanes.forEach((k, n) => {
    const l = flow.links[k], a = pos[l.from], b = pos[l.to];
    const lane = top - 80 - captionClearance - n * LANE;
    const off = 24 + (56 * n) / Math.max(1, lanes.length);
    const sx = colEnd(l.from) + off, tx = colX[depth[l.to]] - off;
    const sy = a.y + a.h * 0.1, ty = b.y + b.h * 0.1;
    edges.push({
      d: `M${a.x + a.w} ${sy} H${sx} V${lane} H${tx} V${ty} H${b.x}`,
      dashed: true,
      label: l.label,
      mid: [(sx + tx) / 2, lane],
    });
  });

  return { width, height, pos, views, edges, returns };
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
  returns,
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
  returns?: { label?: string; to: string }[];
  item?: SyncItem;
  style?: React.CSSProperties;
  mode: ViewerMode;
  onOpen: (file: string) => void;
  onFrameLoad: (f: HTMLIFrameElement) => void;
  registerFrame: React.RefCallback<HTMLIFrameElement>;
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
        {returns?.map((r, i) => (
          <span key={i} className="badge ret" title={`Returns to ${r.to}`}>↩ {r.label ?? r.to}</span>
        ))}
      </div>
      <div
        className={`thumb ${device}${!file ? " empty" : ""}`}
        style={{ width: w, height: h }}
        onDoubleClick={() => {
          if (file && mode !== "comment") onOpen(file);
        }}
      >
        {!file ? (
          <span>No file yet</span>
        ) : (
          <iframe
            key={file}
            ref={registerFrame}
            title={file}
            tabIndex={-1}
            data-src={previewPath(file)}
            data-file={splitState(file)[0]}
            onLoad={(e) => onFrameLoad(e.currentTarget)}
          />
        )}
      </div>
    </div>
  );
}

function BoardComment({ element, onClose }: { element: BoardElement; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.current?.value.trim();
    if (pending) return;
    if (!text) {
      setError("Enter a comment.");
      input.current?.focus();
      return;
    }
    setPending(true);
    setError("");
    try {
      const { file, cdId, uses, selector } = element;
      const response = await fetch("/__cd/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, cdId, uses, selector, text }),
      });
      if (!response.ok) throw new Error();
      if (input.current?.isConnected) onClose();
    } catch {
      setError("Could not save the comment. Try again.");
      setPending(false);
    }
  };

  return (
    <form className="board-comment" aria-label="Element comment" onSubmit={submit} onKeyDown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.currentTarget.requestSubmit();
      }
    }}>
      <label htmlFor="board-comment-text">Comment on &lt;{element.tag}&gt;</label>
      <small title={element.file}>{element.file}:{element.cdId}</small>
      <textarea id="board-comment-text" ref={input} name="comment" placeholder="Write a comment…" required />
      {error && <p role="alert">{error}</p>}
      <div className="grp">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Add Comment"}</button>
      </div>
    </form>
  );
}

export function ProjectMap({
  visible,
  route,
  data,
  mode,
  onToolChange,
  onElementSelect,
  onOpen,
  onSyncAction,
  onFrameLoad,
  onNavigateHash,
}: {
  visible: boolean;
  route: string;
  data: FlowsData;
  mode: ViewerMode;
  onToolChange: (tool: "select" | "comment") => void;
  onElementSelect: (element: BoardElement | null) => void;
  onOpen: (file: string) => void;
  onSyncAction: (action: "done" | "outdated" | "clear", file: string, note?: string) => void;
  onFrameLoad: (f: HTMLIFrameElement) => void;
  onNavigateHash: (h: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const flowBodyRef = useRef<HTMLDivElement>(null);
  const pickedFrame = useRef<HTMLIFrameElement | null>(null);
  const position = useRef({ x: 0, y: 0 });
  const cameras = useRef<Record<string, { x: number; y: number; zoom: number }>>({});
  const space = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const [hand, setHand] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selection, setSelection] = useState<HTMLElement | null>(null);
  const [comment, setComment] = useState<BoardElement | null>(null);
  const zoomRef = useRef(1);
  const obsRef = useRef<IntersectionObserver | null>(null);
  const iframesRef = useRef<Set<HTMLIFrameElement>>(new Set());

  const [device, setDevice] = useState<Device>(() => (ssGet("cd-map-device") === "desktop" ? "desktop" : "phone"));
  const [layerPreference, setLayer] = useState<Layer>(() => ssGet("cd-layer") === "page" ? "page" : "wireframe");
  const legacyView = useRef({ device, layer: layerPreference });
  const [panelOpen, setPanelOpen] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);

  const flowId = route.startsWith("flow:") ? route.slice(5) : null;
  const activeFlow = useMemo(
    () => data.flows.find((f) => f.id === flowId) ?? data.flows[0] ?? null,
    [data.flows, flowId]
  );
  const layer = !activeFlow || route === "map:pages" ? "page" : layerPreference;
  const cameraKey = `cd-map-camera:${route}:${layer}:${device}`;

  const clearPick = useCallback(() => {
    const frame = pickedFrame.current;
    if (!frame) return;
    frame.contentDocument?.dispatchEvent(new Event("cd-board-clear"));
    pickedFrame.current = null;
    onElementSelect(null);
  }, [onElementSelect]);

  const closeComment = useCallback(() => {
    if (document.activeElement?.closest(".board-comment")) viewportRef.current?.focus({ preventScroll: true });
    setComment(null);
  }, []);

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
      const camera = cameras.current[cameraKey] = { x, y, zoom: zoomRef.current };
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

  const fit = (target: HTMLElement | undefined = flowBodyRef.current ?? undefined, save = true) => {
    const viewport = viewportRef.current, canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    const bounds = (target ?? canvas).getBoundingClientRect();
    const origin = canvas.getBoundingClientRect();
    const old = zoomRef.current;
    const width = Math.max(1, bounds.width / old), height = Math.max(1, bounds.height / old);
    const maxZoom = target === selection ? 16 : 1;
    const z = Math.max(0.02, Math.min(maxZoom, (viewport.clientWidth - 32) / width,
      (viewport.clientHeight - 32) / height));
    applyZoom(z);
    panTo((viewport.clientWidth - width * z) / 2 - (bounds.left - origin.left) / old * z,
      (viewport.clientHeight - height * z) / 2 - (bounds.top - origin.top) / old * z, save);
  };

  useLayoutEffect(() => {
    if (!visible) return;
    let saved = cameras.current[cameraKey];
    const legacyLayer = route === "map:pages" ? "page" : legacyView.current.layer;
    const raw = lsGet(cameraKey) ?? (layer === legacyLayer && device === legacyView.current.device
      ? lsGet(`cd-map-camera:${route}`) : null);
    if (!saved && raw) {
      try {
        const camera = JSON.parse(raw);
        if (Number.isFinite(camera?.x) && Number.isFinite(camera?.y) &&
          Number.isFinite(camera.zoom) && camera.zoom >= 0.02 && camera.zoom <= 16) {
          saved = cameras.current[cameraKey] = camera;
        }
      } catch { /* Invalid saved views fall back to Fit. */ }
    }
    applyZoom(saved?.zoom ?? 1);
    panTo(saved?.x ?? 0, saved?.y ?? 0, false);
    const viewport = viewportRef.current;
    if (saved || !viewport) return;
    fit(undefined, false);
    const observer = new ResizeObserver(() => {
      if (!cameras.current[cameraKey]) fit(undefined, false);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [visible, route, device, layer, data, cameraKey]);

  useEffect(() => {
    setSelection(null);
    pointers.current.clear();
    viewportRef.current?.classList.remove("panning");
    dragged.current = false;
    space.current = false;
    setSpaceHeld(false);
    closeComment();
    clearPick();
  }, [visible, route, device, layer, closeComment, clearPick]);

  useEffect(() => {
    setHand(false);
    if (mode !== "comment") closeComment();
  }, [mode, closeComment]);

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
  }, [visible, route, device, layer]);

  const registerFrame = useCallback<React.RefCallback<HTMLIFrameElement>>((el) => {
    if (el) {
      iframesRef.current.add(el);
      if (obsRef.current && !el.src && el.dataset.src) obsRef.current.observe(el);
      return () => {
        obsRef.current?.unobserve(el);
        iframesRef.current.delete(el);
      };
    }
  }, []);

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

  const chooseTool = useCallback((tool: "select" | "comment") => {
    setHand(false);
    onToolChange(tool);
  }, [onToolChange]);

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
        (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,textarea,select,.sync-panel,.board-comment")))) return;
      const modified = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!modified && key === "escape" && (selection || comment)) {
        if (comment) closeComment();
        else {
          setSelection(null);
          clearPick();
        }
      } else if (!modified && e.code === "Space") {
        if (target instanceof Element && target.closest("button,a")) return;
        space.current = true;
        setSpaceHeld(true);
      } else if (!modified && key === "h") setHand(true);
      else if (!modified && (key === "v" || key === "s")) chooseTool("select");
      else if (!modified && key === "c") chooseTool("comment");
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
  }, [visible, route, cameraKey, selection, comment, closeComment, clearPick, chooseTool]);

  useEffect(() => {
    selection?.classList.add("board-selected");
    return () => selection?.classList.remove("board-selected");
  }, [selection]);

  const pickAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.detail > 0 && (dragged.current || hand || space.current)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as Element;
    const card = target.closest<HTMLElement>("[data-screen]");
    setSelection(card);
    if (target.closest("button") || (mode === "comment" && comment)) return;
    viewportRef.current?.focus({ preventScroll: true });

    const frame = target.closest(".thumb")?.querySelector("iframe");
    const preview = frame?.contentDocument;
    if (preview && frame && event.detail > 0) {
      const bounds = frame.getBoundingClientRect();
      const x = (event.clientX - bounds.left) * frame.clientWidth / bounds.width;
      const y = (event.clientY - bounds.top) * frame.clientHeight / bounds.height;
      const element = preview.elementFromPoint(x, y)?.closest("[data-cd-id]");
      if (element) {
        let found = false;
        element.dispatchEvent(new CustomEvent("cd-board-pick", {
          bubbles: true,
          detail: (value: BoardElement) => {
            if (pickedFrame.current !== frame) {
              pickedFrame.current?.contentDocument?.dispatchEvent(new Event("cd-board-clear"));
            }
            pickedFrame.current = frame;
            onElementSelect(value);
            if (mode === "comment") setComment(value);
            found = true;
          },
        }));
        if (found) return;
      }
    }
    clearPick();
  };

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
                      ["page", "Screens & Components"],
                    ] as const
                  ).map(([v, t]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={layer === v}
                      onClick={() => {
                        if (route === "map:pages") onNavigateHash("map:flows");
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
                    setDevice(v);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="seg" role="group" aria-label="Canvas tools">
              <button type="button" aria-pressed={!hand && mode !== "comment"} title="Select (V or S)" onClick={() => chooseTool("select")}>Select</button>
              <button type="button" aria-pressed={!hand && mode === "comment"} title="Comment (C)" onClick={() => chooseTool("comment")}>Comment</button>
              <button type="button" aria-pressed={hand} title="Hand tool (H) · Select (V)" onClick={() => setHand(!hand)}>Hand</button>
            </div>
            <div className="zoom grp" role="group" aria-label="Canvas zoom">
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
            tabIndex={-1}
            role="region"
            aria-label="Flow canvas"
            onClickCapture={pickAt}
          >
            <div className="map-position">
              <div className="map-canvas" ref={canvasRef}>
                {!activeFlow ? (
                  <div className="empty-map">
                    <p>Create a flow with <code>cdesign flows new &lt;id&gt;</code>.</p>
                  </div>
                ) : (
                  <>
                    {activeFlow.errors.length > 0 && <div className="flow-errors">{activeFlow.errors.join("\n")}</div>}
                    {flowLayout && (
                      <div className="flow-body" ref={flowBodyRef} style={{ width: flowLayout.width, height: flowLayout.height }}>
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
                                {flowLayout.returns[s.id]?.map((r, i) => (
                                  <small key={i} className="badge ret" title={`Returns to ${r.to}`}>↩ {r.label ?? r.to}</small>
                                ))}
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
                              returns={flowLayout.returns[s.id]}
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

          {comment && <BoardComment element={comment} onClose={closeComment} />}


          {panelOpen && data.flows.length > 0 && (
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
