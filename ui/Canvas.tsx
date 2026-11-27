import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  FRAME_PRESETS,
  previewPath,
  splitState,
  lsGet,
  lsSet,
  type BoardElement,
  type Flow,
  type FlowFrame,
  type ViewerMode,
} from "./lib";

const GAP = 80;
const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_SIZE: [number, number] = FRAME_PRESETS["iPhone 18"];

export const frameTitle = (f: FlowFrame) => {
  if (f.title) return f.title;
  const [file, state] = splitState(f.page);
  const name = file.split("/").pop()!.replace(/\.(tsx|html)$/, "");
  return state ? `${name} · ${state}` : name;
};

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "frame";
const uniqueId = (frames: FlowFrame[], base: string) => {
  let id = slug(base), n = 2;
  while (frames.some((f) => f.id === id)) id = `${slug(base)}-${n++}`;
  return id;
};
const nextSlot = (frames: FlowFrame[]) =>
  frames.length ? { x: Math.max(...frames.map((f) => f.x + f.w)) + GAP, y: Math.min(...frames.map((f) => f.y)) } : { x: 0, y: 0 };

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

function AddPage({ files, onAdd, onClose }: { files: string[]; onAdd: (file: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? files.filter((f) => f.toLowerCase().includes(t)) : files).slice(0, 200);
  }, [files, q]);
  return (
    <div className="cv-add" role="dialog" aria-label="Add a page to this tab" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <input
        autoFocus
        type="search"
        placeholder="Find a page…"
        aria-label="Find a page"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && list[0]) onAdd(list[0]); }}
      />
      <div className="cv-add-list">
        {list.map((f) => (
          <button key={f} type="button" className="f" title={f} onClick={() => onAdd(f)}>
            {f.replace(/^design\//, "")}
          </button>
        ))}
        {!list.length && <small>No pages match.</small>}
      </div>
    </div>
  );
}

const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

/**
 * The canvas: one tab (flow) of pages as live frames the user drags, resizes and arranges freely. Design mode keeps
 * the previews inert so a click selects an element (or comments on it) and a drag moves the frame; Preview mode
 * hands the pointer to the pages so they scroll and respond like the real app.
 */
export function Canvas({
  visible,
  flow,
  files,
  mode,
  interact,
  onInteract,
  onToolChange,
  onElementSelect,
  onOpen,
  onSave,
  onToast,
  onFrameLoad,
  onNewTab,
}: {
  visible: boolean;
  flow: Flow | null;
  files: string[];
  mode: ViewerMode;
  interact: boolean;
  onInteract: (on: boolean) => void;
  onToolChange: (tool: "select" | "comment") => void;
  onElementSelect: (element: BoardElement | null) => void;
  onOpen: (page: string) => void;
  onSave: (flow: string, frames: FlowFrame[]) => void;
  onToast?: (msg: string) => void;
  onFrameLoad: (f: HTMLIFrameElement) => void;
  onNewTab: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pickedFrame = useRef<HTMLIFrameElement | null>(null);
  const position = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const space = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const busy = useRef(false);
  const obsRef = useRef<IntersectionObserver | null>(null);
  const iframesRef = useRef<Set<HTMLIFrameElement>>(new Set());
  const [hand, setHand] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [comment, setComment] = useState<BoardElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [frames, setFramesState] = useState<FlowFrame[]>(flow?.frames ?? []);
  const framesRef = useRef(frames);
  const flowId = flow?.id ?? null;
  const cameraKey = `cd-cv-camera:${flowId}`;

  /** The server copy wins unless the user is mid-drag; our own saves come back identical. */
  useEffect(() => {
    if (busy.current) return;
    framesRef.current = flow?.frames ?? [];
    setFramesState(framesRef.current);
  }, [flow]);

  const setFrames = (next: FlowFrame[]) => {
    framesRef.current = next;
    setFramesState(next);
  };
  const save = (next = framesRef.current) => {
    if (flowId) onSave(flowId, next);
  };

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
      canvas.style.setProperty("--z", String(Math.max(z, 0.1)));
    }
    setZoomPct(Math.round(z * 100));
  };

  const panTo = (x: number, y: number, persist = true) => {
    position.current = { x, y };
    if (persist && flowId) lsSet(cameraKey, JSON.stringify({ x, y, zoom: zoomRef.current }));
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
  const setZoomAtRef = useRef(setZoomAt);
  setZoomAtRef.current = setZoomAt;

  const stepZoom = (dir: 1 | -1) => {
    const cur = zoomRef.current, eps = 0.005;
    const next = dir > 0
      ? ZOOM_STEPS.find((z) => z > cur + eps) ?? cur * 1.25
      : [...ZOOM_STEPS].reverse().find((z) => z < cur - eps) ?? cur / 1.25;
    setZoomAt(next);
  };

  /** Centres a canvas rectangle (canvas units) and zooms to fit it, leaving room for the labels and toolbars. */
  const fitRect = (x: number, y: number, w: number, h: number, maxZoom: number, persist = true) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    // Room above for the frame labels and below for the floating toolbar.
    const top = 44, bottom = 84;
    const z = Math.max(0.02, Math.min(maxZoom, (vw - 64) / Math.max(1, w), (vh - top - bottom) / Math.max(1, h)));
    applyZoom(z);
    panTo((vw - w * z) / 2 - x * z, top + (vh - top - bottom - h * z) / 2 - y * z, persist);
  };

  const fit = (only?: FlowFrame[], persist = true) => {
    const list = only ?? framesRef.current;
    if (!list.length) {
      applyZoom(1);
      panTo(64, 64, persist);
      return;
    }
    const x0 = Math.min(...list.map((f) => f.x)), y0 = Math.min(...list.map((f) => f.y));
    const x1 = Math.max(...list.map((f) => f.x + f.w)), y1 = Math.max(...list.map((f) => f.y + f.h));
    fitRect(x0, y0, x1 - x0, y1 - y0, only ? 4 : 1, persist);
  };

  const focusFrame = (id: string) => {
    const f = framesRef.current.find((x) => x.id === id);
    if (!f) return;
    setSelected(id);
    fit([f]);
  };

  // Restore the tab's camera, or fit its frames the first time it opens.
  useLayoutEffect(() => {
    if (!visible) return;
    let saved: { x: number; y: number; zoom: number } | null = null;
    try {
      const c = JSON.parse(lsGet(cameraKey) || "null");
      if (Number.isFinite(c?.x) && Number.isFinite(c?.y) && c.zoom >= 0.02 && c.zoom <= 16) saved = c;
    } catch { /* an invalid saved view falls back to Fit */ }
    if (saved) {
      applyZoom(saved.zoom);
      panTo(saved.x, saved.y, false);
      return;
    }
    fit(undefined, false);
    const viewport = viewportRef.current;
    if (!viewport) return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (!lsGet(cameraKey)) fit(undefined, false); });
    });
    observer.observe(viewport);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [visible, cameraKey, frames.length === 0]);

  useEffect(() => {
    setSelected(null);
    setRenaming(null);
    setAdding(false);
    pointers.current.clear();
    viewportRef.current?.classList.remove("panning");
    dragged.current = false;
    space.current = false;
    setSpaceHeld(false);
    closeComment();
    clearPick();
  }, [visible, flowId, closeComment, clearPick]);

  useEffect(() => {
    setHand(false);
    if (mode !== "comment") closeComment();
  }, [mode, closeComment]);

  const interactRef = useRef(interact);
  interactRef.current = interact;
  useEffect(() => {
    for (const f of iframesRef.current) {
      try { f.contentDocument?.documentElement.classList.toggle("__cd-live", interact); } catch {}
    }
    if (interact) {
      closeComment();
      clearPick();
    }
  }, [interact, closeComment, clearPick]);

  // Previews load as they come near the viewport.
  useEffect(() => {
    if (!visible || !viewportRef.current) return;
    const obs = new IntersectionObserver(
      (es) => es.forEach((e) => {
        const el = e.target as HTMLIFrameElement;
        if (e.isIntersecting && !el.src && el.dataset.src) {
          el.src = el.dataset.src;
          obs.unobserve(el);
        }
      }),
      { root: viewportRef.current, rootMargin: "800px" }
    );
    obsRef.current = obs;
    for (const el of iframesRef.current) if (!el.src && el.dataset.src) obs.observe(el);
    return () => {
      obs.disconnect();
      obsRef.current = null;
    };
  }, [visible, flowId]);

  const registerFrame = useCallback<React.RefCallback<HTMLIFrameElement>>((el) => {
    if (!el) return;
    iframesRef.current.add(el);
    if (obsRef.current && !el.src && el.dataset.src) obsRef.current.observe(el);
    return () => {
      obsRef.current?.unobserve(el);
      iframesRef.current.delete(el);
    };
  }, []);

  /** In Preview the page gets the wheel; a pinch (ctrl+wheel) inside it still zooms the canvas instead of the page. */
  const frameLoaded = (f: HTMLIFrameElement) => {
    onFrameLoad(f);
    try {
      f.contentDocument?.documentElement.classList.toggle("__cd-live", interactRef.current);
      f.contentWindow?.addEventListener("wheel", (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const vr = viewportRef.current?.getBoundingClientRect(), fr = f.getBoundingClientRect();
        if (!vr) return;
        const s = fr.width / Math.max(1, f.clientWidth);
        const d = Math.max(-40, Math.min(40, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
        setZoomAtRef.current(zoomRef.current * Math.exp(-d / 100), fr.left + e.clientX * s - vr.left, fr.top + e.clientY * s - vr.top);
      }, { passive: false });
    } catch { /* cross-origin preview: nothing to forward */ }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const touch = e.pointerType === "touch";
    const onEmpty = !(e.target as Element).closest(".frame,.cv-toolbar,.cv-add");
    const pan = e.button === 1 || (e.button === 0 && (space.current || hand || touch || (onEmpty && !e.shiftKey)));
    if (!pointers.current.size) dragged.current = false;
    if (!pan) return;
    if (!touch) e.preventDefault();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Defer capture on touch so a stationary tap still reaches its original target.
    if (!touch || pointers.current.size > 1) {
      for (const id of pointers.current.keys()) e.currentTarget.setPointerCapture(id);
      dragged.current = pointers.current.size > 1;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const points = pointers.current;
    const previous = points.get(e.pointerId);
    if (!previous) return;
    const current = { x: e.clientX, y: e.clientY };
    const dx = current.x - previous.x, dy = current.y - previous.y;
    if (!dragged.current && Math.hypot(dx, dy) < 4) return;
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

  /** Drag a frame by its label (any mode) or its body (Design, select tool); a click without movement selects it. */
  const startMove = (id: string, body: boolean) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || space.current || hand || (body && e.pointerType === "touch")) return;
    if ((e.target as Element).closest("button,input")) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const f0 = framesRef.current.find((f) => f.id === id);
    if (!f0) return;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    dragged.current = false;
    busy.current = true;
    document.body.classList.add("drag");
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      if (!moved) {
        moved = true;
        dragged.current = true;
        setSelected(id);
      }
      const z = zoomRef.current;
      setFrames(framesRef.current.map((f) => f.id === id ? { ...f, x: Math.round(f0.x + (m.clientX - x0) / z), y: Math.round(f0.y + (m.clientY - y0) / z) } : f));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      document.body.classList.remove("drag");
      busy.current = false;
      if (moved) save();
      else if (!body) setSelected(id);
    };
    // On window, not the element: capture can be dropped mid-drag when the frame re-renders as selected.
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  const startResize = (id: string, dx: number, dy: number) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const f0 = framesRef.current.find((f) => f.id === id);
    if (!f0) return;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    busy.current = true;
    document.body.classList.add("drag");
    const move = (m: PointerEvent) => {
      const z = zoomRef.current;
      setFrames(framesRef.current.map((f) => f.id !== id ? f : {
        ...f,
        w: dx ? Math.round(Math.max(200, Math.min(4000, f0.w + (m.clientX - x0) / z))) : f.w,
        h: dy ? Math.round(Math.max(200, Math.min(4000, f0.h + (m.clientY - y0) / z))) : f.h,
      }));
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      document.body.classList.remove("drag");
      busy.current = false;
      save();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  /** One size for every frame of the tab; positions scale with it so a row of frames keeps its gaps. */
  const applySize = ([w, h]: [number, number]) => {
    const next = framesRef.current.map((f) => ({
      ...f,
      x: Math.round(f.x * (w + GAP) / (f.w + GAP)),
      y: Math.round(f.y * (h + GAP) / (f.h + GAP)),
      w,
      h,
    }));
    setFrames(next);
    save(next);
    requestAnimationFrame(() => fit());
  };

  const addFrame = (page: string) => {
    const list = framesRef.current;
    const last = list.at(-1);
    const f: FlowFrame = { id: uniqueId(list, page.split("/").pop()!.replace(/\.(tsx|html)(#.*)?$/, "")), page, ...nextSlot(list), w: last?.w ?? DEFAULT_SIZE[0], h: last?.h ?? DEFAULT_SIZE[1] };
    const next = [...list, f];
    setFrames(next);
    save(next);
    setAdding(false);
    requestAnimationFrame(() => focusFrame(f.id));
  };

  const removeFrame = (id: string) => {
    const next = framesRef.current.filter((f) => f.id !== id);
    setFrames(next);
    save(next);
    if (selected === id) setSelected(null);
  };

  const renameFrame = (id: string, title: string) => {
    setRenaming(null);
    const t = title.trim();
    const next = framesRef.current.map((f) => f.id !== id ? f : { ...f, ...(t ? { title: t } : { title: undefined }) });
    setFrames(next);
    save(next);
  };

  const reloadFrame = (id: string) => {
    const iframe = viewportRef.current?.querySelector<HTMLIFrameElement>(`[data-frame="${CSS.escape(id)}"] iframe`);
    try { iframe?.contentWindow?.location.reload(); } catch {}
  };

  const chooseTool = useCallback((tool: "select" | "comment") => {
    setHand(false);
    onToolChange(tool);
  }, [onToolChange]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!visible || !viewport) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.(".cv-add,.board-comment")) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.clientHeight : 1;
      // Like Figma: two-finger scroll pans in any direction; a trackpad pinch (which browsers send as ctrl+wheel)
      // or Ctrl/⌘ + wheel zooms around the pointer. Each event's step is capped so a mouse notch is not a huge jump.
      if (e.ctrlKey || e.metaKey) {
        const r = viewport.getBoundingClientRect();
        const d = Math.max(-40, Math.min(40, e.deltaY * unit));
        setZoomAt(zoomRef.current * Math.exp(-d / 100), e.clientX - r.left, e.clientY - r.top);
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
        (target instanceof HTMLElement && (target.isContentEditable || target.closest("input,textarea,select,.board-comment,.cv-add")))) return;
      const modified = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!modified && key === "escape" && (selected || comment || adding)) {
        if (adding) setAdding(false);
        else if (comment) closeComment();
        else {
          setSelected(null);
          clearPick();
        }
      } else if (!modified && e.code === "Space") {
        if (target instanceof Element && target.closest("button,a")) return;
        space.current = true;
        setSpaceHeld(true);
      } else if (!modified && key === "h") setHand(true);
      else if (!modified && (key === "v" || key === "s")) chooseTool("select");
      else if (!modified && key === "c") { onInteract(false); chooseTool("comment"); }
      else if (!modified && key === "d") onInteract(false);
      else if (!modified && key === "p") onInteract(true);
      else if (!modified && (key === "delete" || key === "backspace") && selected) removeFrame(selected);
      else if (!modified && key === "enter" && selected) {
        const f = framesRef.current.find((x) => x.id === selected);
        if (f) onOpen(f.page);
      } else if (!modified && e.shiftKey && (e.code === "Digit1" || key === "!")) fit();
      else if (!modified && e.shiftKey && (e.code === "Digit2" || key === "@")) { if (selected) focusFrame(selected); }
      else if ((modified && key === "0") || (!modified && !e.shiftKey && key === "0")) setZoomAt(1);
      else if (key === "+" || key === "=") stepZoom(1);
      else if (key === "-" || key === "_") stepZoom(-1);
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
  });

  const pickAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.detail > 0 && (dragged.current || hand || space.current)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as Element;
    if (target.closest(".cv-toolbar,.cv-add,.board-comment")) return;
    const card = target.closest<HTMLElement>("[data-frame]");
    if (!card) {
      setSelected(null);
      clearPick();
      return;
    }
    if (target.closest(".frame-label,.rz")) return;
    setSelected(card.dataset.frame!);
    if (interact || (mode === "comment" && comment)) return;
    viewportRef.current?.focus({ preventScroll: true });

    const frame = card.querySelector("iframe");
    const preview = frame?.contentDocument;
    if (preview && frame && event.detail > 0) {
      const bounds = frame.getBoundingClientRect();
      const x = (event.clientX - bounds.left) * frame.clientWidth / bounds.width;
      const y = (event.clientY - bounds.top) * frame.clientHeight / bounds.height;
      const element = preview.elementFromPoint(x, y)?.closest("[data-cd-id]")
        ?? (mode === "comment" ? preview.querySelector("[data-cd-id]") : null);
      if (element) {
        let found = false;
        element.dispatchEvent(new CustomEvent("cd-board-pick", {
          bubbles: true,
          detail: (value: BoardElement) => {
            if (pickedFrame.current !== frame) pickedFrame.current?.contentDocument?.dispatchEvent(new Event("cd-board-clear"));
            pickedFrame.current = frame;
            onElementSelect(value);
            if (mode === "comment") setComment(value);
            found = true;
          },
        }));
        if (found) return;
      }
    }
    if (mode === "comment" && card.dataset.screen) {
      const page = card.dataset.screen;
      const el: BoardElement = {
        page, file: splitState(page)[0], cdId: "1:1", uses: [], selector: "body", tag: "screen",
        text: card.querySelector(".frame-name")?.textContent || page, size: "",
      };
      onElementSelect(el);
      setComment(el);
      return;
    }
    clearPick();
  };

  const sizes = new Set(frames.map((f) => `${f.w}x${f.h}`));
  const shared = sizes.size === 1 ? [...sizes][0] : null;
  const preset = shared ? Object.keys(FRAME_PRESETS).find((k) => FRAME_PRESETS[k].join("x") === shared) ?? "custom" : frames.length ? "mixed" : "";

  return (
    <div id="map" className={`cv ${interact ? "preview" : "design"}`} aria-label="Canvas" hidden={!visible}>
      {visible && (
        <>
          <div className="cv-head">
            <div className="cv-modes" role="group" aria-label="Canvas mode">
              <button type="button" aria-pressed={!interact} title="Design: select, comment and arrange frames (D)" onClick={() => onInteract(false)}>
                <Icon d="M2.5 13.5 4 9l7-7 3 3-7 7zM9.5 3.5l3 3" />
                Design
              </button>
              <button type="button" aria-pressed={interact} title="Preview: use the pages like the real app (P)" onClick={() => onInteract(true)}>
                <Icon d="M5 3.5v9l7.5-4.5z" />
                Preview
              </button>
            </div>
          </div>

          <div
            ref={viewportRef}
            className={`cv-viewport${hand || spaceHeld ? " hand" : ""}${mode === "comment" && !interact ? " commenting" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onLostPointerCapture={endPointer}
            onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
            onDoubleClickCapture={(e) => { if (dragged.current || hand || space.current) e.stopPropagation(); }}
            onClickCapture={pickAt}
            tabIndex={-1}
            role="region"
            aria-label="Canvas frames"
          >
            <div className="cv-position">
              <div className="cv-canvas" ref={canvasRef}>
                {frames.map((f) => {
                  const sel = selected === f.id;
                  return (
                    <div
                      key={f.id}
                      data-frame={f.id}
                      data-screen={f.page}
                      className={`frame${sel ? " sel" : ""}`}
                      style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
                    >
                      <div
                        className="frame-label"
                        onPointerDown={startMove(f.id, false)}
                        onDoubleClick={(e) => {
                          if (!(e.target as Element).closest("button")) setRenaming(f.id);
                        }}
                      >
                        {renaming === f.id ? (
                          <input
                            autoFocus
                            className="frame-rename"
                            aria-label="Frame name"
                            defaultValue={frameTitle(f)}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => renameFrame(f.id, e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                            }}
                          />
                        ) : (
                          <span className="frame-name" title={f.page}>{frameTitle(f)}</span>
                        )}
                        <span className="frame-acts">
                          <button type="button" title="Open full page (Enter)" aria-label={`Open ${frameTitle(f)}`} onClick={() => onOpen(f.page)}>
                            <Icon d="M9.5 2.5h4v4m0-4L8.5 7.5M6.5 13.5h-4v-4m0 4 5-5" />
                          </button>
                          <button type="button" title="Reload" aria-label="Reload frame" onClick={() => reloadFrame(f.id)}>
                            <Icon d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" />
                          </button>
                          <button type="button" title="Remove from this tab (Delete)" aria-label="Remove frame" onClick={() => removeFrame(f.id)}>
                            <Icon d="M4 4l8 8M12 4l-8 8" />
                          </button>
                        </span>
                      </div>
                      <div
                        className="frame-body"
                        onPointerDown={!interact && mode !== "comment" ? startMove(f.id, true) : undefined}
                        onDoubleClick={() => { if (!interact && mode !== "comment") onOpen(f.page); }}
                      >
                        <iframe
                          key={f.page}
                          ref={registerFrame}
                          title={frameTitle(f)}
                          tabIndex={interact ? 0 : -1}
                          data-src={previewPath(f.page)}
                          data-file={splitState(f.page)[0]}
                          onLoad={(e) => frameLoaded(e.currentTarget)}
                        />
                      </div>
                      {sel && (
                        <>
                          <i className="rz e" title="Drag to resize" onPointerDown={startResize(f.id, 1, 0)} />
                          <i className="rz s" title="Drag to resize" onPointerDown={startResize(f.id, 0, 1)} />
                          <i className="rz se" title="Drag to resize" onPointerDown={startResize(f.id, 1, 1)} />
                          <span className="frame-size">{f.w} × {f.h}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {!flow ? (
              <div className="cv-empty">
                <p>No tabs yet. Each tab is a flow: a set of pages you arrange on the canvas.</p>
                <button type="button" onClick={onNewTab}>New tab</button>
              </div>
            ) : !frames.length && (
              <div className="cv-empty">
                <p>This tab has no pages yet.</p>
                <button type="button" onClick={() => setAdding(true)}>Add a page</button>
              </div>
            )}
            {flow && flow.errors.length > 0 && <div className="cv-errors" role="alert">{flow.errors.join("\n")}</div>}
          </div>

          {adding && flow && <AddPage files={files} onAdd={addFrame} onClose={() => setAdding(false)} />}

          {flow && (
            <div className="cv-toolbar" role="toolbar" aria-label="Canvas tools">
              <button type="button" className={!hand && mode !== "comment" ? "on" : undefined} aria-pressed={!hand && mode !== "comment"} title="Select (V)" aria-label="Select" onClick={() => chooseTool("select")}>
                <Icon d="M3.5 2.5l9 4.2-3.9 1.3-1.3 3.9z" />
              </button>
              <button type="button" className={hand ? "on" : undefined} aria-pressed={hand} title="Hand (H, or hold Space)" aria-label="Hand" onClick={() => setHand(!hand)}>
                <Icon d="M5.5 8V3.5a1 1 0 0 1 2 0V7m0-4.5a1 1 0 0 1 2 0V7m0-3a1 1 0 0 1 2 0v4.5m0-2a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5h-.5a4.5 4.5 0 0 1-3.6-1.8L2.6 10.2a1 1 0 0 1 1.6-1.2L5.5 10.5" />
              </button>
              <button type="button" className={!hand && mode === "comment" ? "on" : undefined} aria-pressed={!hand && mode === "comment"} title="Comment (C)" aria-label="Comment" onClick={() => { onInteract(false); chooseTool("comment"); }}>
                <Icon d="M14 3H2v8h3v3l4-3h5z" />
              </button>
              <span className="sep" />
              <select
                className="cv-size"
                aria-label="Frame size"
                title="Frame size: applies to every frame in this tab"
                value={preset}
                disabled={!frames.length}
                onChange={(e) => {
                  const p = FRAME_PRESETS[e.target.value];
                  if (p) applySize(p);
                }}
              >
                {preset === "mixed" && <option value="mixed">Mixed sizes</option>}
                {preset === "custom" && <option value="custom">{shared!.replace("x", " × ")}</option>}
                {preset === "" && <option value="">Size</option>}
                {Object.entries(FRAME_PRESETS).map(([k, [w, h]]) => (
                  <option key={k} value={k}>{k} · {w}×{h}</option>
                ))}
              </select>
              <span className="sep" />
              <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => stepZoom(-1)}>
                <Icon d="M3.5 8h9" />
              </button>
              <button type="button" className="pct" aria-label="Zoom to 100%" title="Zoom to 100% (0)" onClick={() => setZoomAt(1)}>
                {zoomPct}%
              </button>
              <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => stepZoom(1)}>
                <Icon d="M3.5 8h9M8 3.5v9" />
              </button>
              <button type="button" aria-label="Fit to window" title="Zoom to fit (Shift+1)" onClick={() => fit()}>
                <Icon d="M2.5 6V2.5H6m4 0h3.5V6m0 4v3.5H10m-4 0H2.5V10" />
              </button>
              <span className="sep" />
              <button type="button" className={`add${adding ? " on" : ""}`} aria-expanded={adding} title="Add a page to this tab" onClick={() => setAdding((a) => !a)}>
                <Icon d="M8 3v10M3 8h10" />
                <span>Add page</span>
              </button>
            </div>
          )}

          {comment && <BoardComment element={comment} onClose={closeComment} />}
        </>
      )}
    </div>
  );
}
