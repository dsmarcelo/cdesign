import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPane } from "./Chat";
import { ShareDialog, TunnelDialog, UpdateDialog, WebsiteDialog } from "./Dialogs";
import {
  DEVICES,
  isMapHash,
  lsGet,
  lsSet,
  pageHash,
  pagePath,
  previewPath,
  splitState,
  ssGet,
  ssSet,
  type BoardElement,
  type CommentItem,
  type FlowsData,
  type ProjectInfo,
  type SidebarTab,
  type TunnelInfo,
  type ViewerMode,
} from "./lib";
import { FlowBar, ProjectMap } from "./Map";

type TreeNode = { dirs: Record<string, TreeNode>; files: { name: string; path: string }[] };

function buildTree(list: string[]): TreeNode {
  const root: TreeNode = { dirs: {}, files: [] };
  for (const f of list) {
    const parts = f.slice("design/".length).split("/");
    const name = parts.pop()!;
    let n = root;
    for (const p of parts) n = n.dirs[p] ??= { dirs: {}, files: [] };
    n.files.push({ name, path: f });
  }
  return root;
}

function FileTree({
  node,
  prefix,
  cur,
  opened,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  prefix: string;
  cur: string | null;
  opened: Set<string>;
  onToggle: (key: string, open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {Object.entries(node.dirs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, d]) => {
          let label = name;
          let curNode = d;
          while (!curNode.files.length && Object.keys(curNode.dirs).length === 1) {
            const [k, v] = Object.entries(curNode.dirs)[0];
            label += "/" + k;
            curNode = v;
          }
          const key = prefix + label;
          return (
            <details
              key={key}
              open={opened.has(key)}
              onToggle={(e) => onToggle(key, e.currentTarget.open)}
            >
              <summary>{label}</summary>
              <div className="kids">
                <FileTree
                  node={curNode}
                  prefix={key + "/"}
                  cur={cur}
                  opened={opened}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              </div>
            </details>
          );
        })}
      {[...node.files]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => (
          <button
            key={f.path}
            className={`f${f.path === cur ? " sel" : ""}`}
            title={f.path}
            onClick={() => onSelect(f.path)}
          >
            {f.name}
          </button>
        ))}
    </>
  );
}

const getTheme = () => lsGet("cd-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export function App() {
  const tabIdRef = useRef(Math.random().toString(36).slice(2, 10));
  const openedWithoutHashRef = useRef(!location.hash.slice(1));
  const viewerInstanceRef = useRef<string | undefined>(undefined);
  const installPromptRef = useRef<{ prompt: () => Promise<void>; userChoice: Promise<unknown> } | null>(null);
  const lastMapRef = useRef<string | null>(null);
  const mapKeyRef = useRef("");

  const fr1Ref = useRef<HTMLIFrameElement>(null);
  const fr2Ref = useRef<HTMLIFrameElement>(null);
  const d1Ref = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const lsideRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const toolsPopoverRef = useRef<HTMLDivElement>(null);
  const toolsToggleRef = useRef<HTMLButtonElement>(null);
  const updateDialogRef = useRef<HTMLDialogElement>(null);
  const tunnelDialogRef = useRef<HTMLDialogElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentProject, setCurrentProject] = useState<string | null | undefined>(undefined);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [remote, setRemote] = useState(false);

  const [files, setFiles] = useState<string[]>([]);
  const [cur, setCurState] = useState<string | null>(() => {
    const h = pageHash();
    return isMapHash(h) ? null : h || null;
  });
  const [curFragment, setCurFragment] = useState("");
  const [mapRoute, setMapRoute] = useState<string | null>(() => {
    const h = pageHash();
    return isMapHash(h) ? h : null;
  });
  const [flowsData, setFlowsData] = useState<FlowsData>({ flows: [], sync: [] });
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [doneOpen, setDoneOpen] = useState(false);
  const [agentState, setAgentState] = useState<"" | "on" | "working">("");
  const [mode, setModeState] = useState<ViewerMode>(null);
  const [theme, setTheme] = useState<string>(getTheme);

  const [activeTab, setActiveTab] = useState<SidebarTab>(() => {
    const t = lsGet("cd-ltab");
    return t === "files" || t === "comments" ? t : "chat";
  });
  const [openedDirs, setOpenedDirs] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(ssGet("cd-opened") || "[]"));
    } catch {
      return new Set();
    }
  });

  const [mob, setMob] = useState(() => matchMedia("(max-width:700px)").matches);
  const [mobHideLeft, setMobHideLeft] = useState(true);
  const [deskHideLeft, setDeskHideLeft] = useState(() => lsGet("cd-hide-l") === "1");
  const [barOpen, setBarOpen] = useState(false);
  const [barBottom, setBarBottom] = useState(() => lsGet("cd-bar-bottom") === "1");

  const [view, setView] = useState<string>(() => {
    const w = ssGet("cd-width");
    return w && ["100%", "768px", "phone", "resp", "split"].includes(w) ? w : "100%";
  });
  const [dev, setDev] = useState<string>(() => {
    const v = ssGet("cd-dev");
    return v && DEVICES[v] ? v : "iPhone 18";
  });
  const [fit, setFit] = useState(() => Boolean(ssGet("cd-fit")));
  const [rot, setRot] = useState(() => Boolean(ssGet("cd-rot")));
  const rsRef = useRef<{ w: number; h: number; set?: boolean }>(
    (() => {
      const r = (ssGet("cd-resp") || "").split("x").map(Number);
      return r[0] >= 200 && r[1] >= 200 ? { w: r[0], h: r[1], set: true } : { w: 800, h: 600 };
    })()
  );
  const [dimText, setDimText] = useState(() => `${Math.round(rsRef.current.w)} × ${Math.round(rsRef.current.h)}`);

  const [toastText, setToastText] = useState("");
  const [toastOn, setToastOn] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelInfo | null>(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelBusyLabel, setTunnelBusyLabel] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const [installVisible, setInstallVisible] = useState(false);
  const [websiteSeq, setWebsiteSeq] = useState(0);
  const [shareSeq, setShareSeq] = useState(0);

  const curRef = useRef(cur);
  curRef.current = cur;
  const viewRef = useRef(view);
  viewRef.current = view;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const mapRouteRef = useRef(mapRoute);
  mapRouteRef.current = mapRoute;
  const boardPageRef = useRef<string | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  const leftHidden = mob ? mobHideLeft : deskHideLeft;
  const inMap = mapRoute !== null;

  const toast = useCallback((t: string) => {
    setToastText(t);
    setToastOn(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastOn(false), 4000);
  }, []);

  const allFrames = useCallback((): HTMLIFrameElement[] => {
    const mapFrames = [...document.querySelectorAll<HTMLIFrameElement>("#map iframe[src]")];
    return [fr1Ref.current, fr2Ref.current, ...mapFrames].filter(Boolean) as HTMLIFrameElement[];
  }, []);

  const sendToFrames = useCallback(
    (m: unknown) => {
      allFrames().forEach((f) => f.contentWindow?.postMessage(m, "*"));
    },
    [allFrames]
  );

  const setFrameMode = useCallback((frame: HTMLIFrameElement) => {
    frame.contentWindow?.postMessage({
      cd: "mode",
      mode: frame.closest("#map") ? null : modeRef.current,
      tab: tabIdRef.current,
    }, "*");
  }, []);

  const applyThemeToFrame = useCallback((f: HTMLIFrameElement, t: string) => {
    try {
      f.contentDocument?.documentElement.setAttribute("data-theme", t);
    } catch {}
  }, []);

  const report = useCallback(() => {
    fetch("/__cd/page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId: tabIdRef.current, file: boardPageRef.current ?? curRef.current }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const loadFrame = (f: HTMLIFrameElement | null, url: string) => {
    if (!f) return;
    try {
      f.contentWindow?.location.replace(url);
    } catch {
      f.src = url;
    }
  };

  const loadPreview = useCallback((file: string | null, v = viewRef.current, state = "") => {
    if (!file) return;
    const url = previewPath(state ? file + "#" + state : file);
    loadFrame(fr1Ref.current, url);
    if (v === "split") loadFrame(fr2Ref.current, url);
  }, []);

  /** A flow step may open its page with a URL state (`page.tsx#venda/cliente`): the viewer keeps the plain file as the current page and passes the state to the preview only. */
  const setCur = useCallback(
    (ref: string) => {
      const [p, state] = splitState(ref);
      boardPageRef.current = null;
      curRef.current = p;
      setCurState(p);
      setCurFragment(state);
      setMapRoute(null);
      if (pageHash() !== p) location.hash = pagePath(p);
      loadPreview(p, viewRef.current, state);
      report();
    },
    [loadPreview, report]
  );

  const setMode = useCallback(
    (m: Exclude<ViewerMode, null>, toggle = true) => {
      const next: ViewerMode = toggle && modeRef.current === m ? null : m;
      modeRef.current = next;
      setModeState(next);
      if (!mapRouteRef.current && next !== "select") sendToFrames({ cd: "clear" });
      allFrames().forEach(setFrameMode);
    },
    [allFrames, sendToFrames, setFrameMode]
  );

  const goMap = useCallback(() => {
    location.hash = lastMapRef.current || ssGet("cd-last-map") || "map:flows";
  }, []);

  const changeBoardTool = useCallback((tool: "select" | "comment") => {
    setMode(tool, false);
  }, [setMode]);

  const selectBoardElement = useCallback((selection: BoardElement | null) => {
    boardPageRef.current = selection?.page ?? null;
    fetch("/__cd/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId: tabIdRef.current, selection }),
    }).catch(() => {});
  }, []);

  const fetchFiles = useCallback(async () => {
    const l: string[] = await (await fetch("/__cd/files")).json();
    setFiles(l);
    const had = curRef.current;
    let next = had;
    if (!next || !l.includes(next)) next = l[0] ?? null;
    if (next !== had) {
      curRef.current = next;
      setCurState(next);
      if (next && !isMapHash(pageHash())) history.replaceState(null, "", "#" + pagePath(next));
      report();
    }
    return next;
  }, [report]);

  const fetchComments = useCallback(async () => {
    const l: CommentItem[] = await (await fetch("/__cd/comments")).json();
    setComments(l);
    return l;
  }, []);

  const fetchAgent = useCallback(async () => {
    const on = (await (await fetch("/__cd/agent")).json()).listening;
    if (on) return setAgentState("on");
    const l: CommentItem[] = await (await fetch("/__cd/comments")).json();
    setAgentState(l.some((c) => c.status === "sent") ? "working" : "");
  }, []);

  const fetchMap = useCallback(async () => {
    const d: FlowsData | null = await fetch("/__cd/flows").then((r) => r.ok ? r.json() : null).catch(() => null);
    if (!d) return { changed: false, hasFlows: false };
    const key = JSON.stringify(d);
    const changed = key !== mapKeyRef.current;
    mapKeyRef.current = key;
    if (changed) setFlowsData(d);
    return { changed, hasFlows: d.flows.length > 0 };
  }, []);

  const refreshMap = useCallback(async () => {
    const { changed } = await fetchMap();
    if (!mapRouteRef.current) return;
    if (!changed) {
      for (const f of document.querySelectorAll<HTMLIFrameElement>("#map iframe[src]")) {
        try {
          f.contentWindow?.location.reload();
        } catch {}
      }
    }
  }, [fetchMap]);

  const syncAction = useCallback(
    async (action: "done" | "outdated" | "clear", file: string, note?: string) => {
      const r = await fetch("/__cd/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, file, note }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return toast(j.error || "Sync update failed");
      setFlowsData((prev) => ({ ...prev, sync: j.sync }));
      toast(action === "done" ? "Marked in sync" : action === "outdated" ? "Marked outdated" : "Mark cleared");
    },
    [toast]
  );

  // Sync body classes and CSS variables
  useEffect(() => {
    document.body.classList.toggle("hl", leftHidden);
    document.body.classList.toggle("map", inMap);
    document.body.classList.toggle("resp", view === "resp");
    document.body.classList.toggle("phone", view === "phone");
    document.body.classList.toggle("split", view === "split");
    document.body.classList.toggle("bar", barOpen);
    document.body.classList.toggle("bb", barBottom);
    document.body.classList.toggle("remote", remote);
    document.body.classList.toggle("nop", currentProject === null);
  }, [leftHidden, inMap, view, barOpen, barBottom, remote, currentProject]);

  // Theme application
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#000000" : "#ffffff");
    for (const f of allFrames()) applyThemeToFrame(f, theme);
  }, [theme, allFrames, applyThemeToFrame]);

  // Sidebar width init
  useEffect(() => {
    const w = +(lsGet("cd-lw") || 0) || 340;
    document.body.style.setProperty("--lw", Math.round(Math.min(Math.max(w, 200), Math.max(260, innerWidth - 500))) + "px");
  }, []);

  // Mobile media query listener
  useEffect(() => {
    const mq = matchMedia("(max-width:700px)");
    const onChange = () => setMob(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Preview sizing
  const applySize = useCallback(() => {
    const d = d1Ref.current, f = fr1Ref.current;
    if (!d || !f) return;
    if (view === "phone") {
      const [w, h] = rot ? [...DEVICES[dev]].reverse() : DEVICES[dev];
      const s = fit ? Math.min(1, ((mainRef.current?.clientHeight ?? innerHeight) - 24) / h) : 1;
      f.style.setProperty("--dw", w + "px");
      f.style.setProperty("--dh", h + "px");
      f.style.setProperty("--ds", String(s));
      d.style.width = Math.round(w * s) + "px";
      d.style.height = Math.round(h * s) + "px";
      return;
    }
    f.style.removeProperty("--dw");
    f.style.removeProperty("--dh");
    f.style.removeProperty("--ds");
    d.style.width = view === "resp" ? rsRef.current.w + "px" : view === "split" ? "" : view;
    d.style.height = view === "resp" ? rsRef.current.h + "px" : "";
    setDimText(`${Math.round(rsRef.current.w)} × ${Math.round(rsRef.current.h)}`);
  }, [view, dev, rot, fit]);

  useEffect(() => {
    applySize();
  }, [applySize]);

  useEffect(() => {
    const onResize = () => {
      if (view === "phone" && fit) applySize();
      if (mob) placePill();
    };
    addEventListener("resize", onResize);
    return () => addEventListener("resize", onResize);
  }, [view, fit, mob, applySize]);

  // Mobile pill placement
  const placeBar = () => {
    const p = pillRef.current, b = barRef.current;
    if (!p || !b) return;
    const r = p.getBoundingClientRect();
    if (r.top + r.height / 2 > innerHeight / 2) Object.assign(b.style, { bottom: innerHeight - r.top + 8 + "px", top: "auto" });
    else Object.assign(b.style, { top: r.bottom + 8 + "px", bottom: "auto" });
  };

  const placePill = () => {
    const p = pillRef.current;
    if (!p) return;
    let pos: { x: number; y: number } | null = null;
    try {
      pos = JSON.parse(lsGet("cd-pill") || "null");
    } catch {}
    const r = p.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    if (pos) {
      const x = Math.max(4, Math.min(W - r.width - 4, pos.x * W - r.width / 2));
      const y = Math.max(4, Math.min(H - r.height - 4, pos.y * H - r.height / 2));
      Object.assign(p.style, { left: x + "px", top: y + "px", bottom: "auto", transform: "none" });
    }
    placeBar();
  };

  useEffect(() => {
    placePill();
  }, []);

  // Project tools popover positioning
  useEffect(() => {
    const pop = toolsPopoverRef.current;
    if (!pop) return;
    const onBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open") return;
      const trigger = toolsToggleRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const below = trigger.top < innerHeight / 2;
      pop.style.left = Math.max(8, Math.min(trigger.left, innerWidth - 192)) + "px";
      pop.style.top = below ? trigger.bottom + 6 + "px" : "auto";
      pop.style.bottom = below ? "auto" : innerHeight - trigger.top + 6 + "px";
    };
    const onClick = (event: Event) => {
      if ((event.target as HTMLElement).closest("button")) (pop as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
    };
    pop.addEventListener("beforetoggle", onBeforeToggle);
    pop.addEventListener("click", onClick, { capture: true });
    return () => {
      pop.removeEventListener("beforetoggle", onBeforeToggle);
      pop.removeEventListener("click", onClick, { capture: true });
    };
  }, []);

  // Tunnel & Update status
  const fetchTunnelStatus = useCallback(async () => {
    if (remoteRef.current) return;
    try {
      const r = await fetch("/__cd/tunnel");
      if (!r.ok) return;
      setTunnel(await r.json());
    } catch {}
  }, []);

  const fetchUpdateStatus = useCallback(async () => {
    if (remoteRef.current) return;
    try {
      const r = await fetch("/__cd/update", { cache: "no-store" });
      if (!r.ok) return;
      const { available, instance } = await r.json();
      if (viewerInstanceRef.current && instance && viewerInstanceRef.current !== instance) return location.reload();
      viewerInstanceRef.current = instance;
      setUpdateAvailable(Boolean(available));
    } catch {}
  }, []);

  const applyUpdate = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    setUpdateBusy(true);
    setUpdateMessage("Updating cdesign…");
    updateDialogRef.current?.showModal();
    try {
      const r = await fetch("/__cd/update", { method: "POST" });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      setUpdateMessage("Reconnecting to cdesign…");
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const st = await fetch("/__cd/update", { cache: "no-store", signal: AbortSignal.timeout(1000) })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null);
        if (st?.instance && st.instance !== result.instance) return location.reload();
      }
      throw new Error("The update finished, but cdesign did not reconnect. Open cdesign again to restart the viewer.");
    } catch (error: unknown) {
      setUpdateMessage((error as Error).message);
    } finally {
      setUpdateBusy(false);
    }
  };

  // PWA install prompt & SW
  useEffect(() => {
    const syncInstall = () => {
      const standalone =
        matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      setInstallVisible(Boolean(installPromptRef.current) && !standalone);
    };
    const onBefore = (e: Event) => {
      e.preventDefault();
      installPromptRef.current = e as unknown as { prompt: () => Promise<void>; userChoice: Promise<unknown> };
      syncInstall();
    };
    const onInstalled = () => {
      installPromptRef.current = null;
      syncInstall();
    };
    window.addEventListener("beforeinstallprompt", onBefore);
    window.addEventListener("appinstalled", onInstalled);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    syncInstall();
    return () => {
      window.removeEventListener("beforeinstallprompt", onBefore);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const triggerInstall = async () => {
    if (!installPromptRef.current) return;
    await installPromptRef.current.prompt();
    await installPromptRef.current.userChoice.catch(() => null);
    installPromptRef.current = null;
    setInstallVisible(false);
  };

  // Initial boot: projects, SSE, polling
  useEffect(() => {
    let es: EventSource | null = null;
    let updateTimer: ReturnType<typeof setInterval> | null = null;
    const tunnelTimer = setInterval(fetchTunnelStatus, 5000);

    (async () => {
      const { current, projects: l, remote: rem, instance } = await (await fetch("/__cd/projects")).json();
      if (viewerInstanceRef.current && instance && viewerInstanceRef.current !== instance) return location.reload();
      if (instance) viewerInstanceRef.current = instance;
      remoteRef.current = !!rem;
      setRemote(!!rem);
      setProjectList(l);
      setCurrentProject(current || null);
      fetchTunnelStatus();
      fetchUpdateStatus();
      updateTimer = setInterval(fetchUpdateStatus, 5000);

      if (!current) return;

      es = new EventSource("/__cd/events?tab=" + tabIdRef.current);
      es.onopen = report;
      es.onmessage = (e) => {
        if (e.data.startsWith("instance:")) {
          const next = e.data.slice("instance:".length);
          if (viewerInstanceRef.current && next && viewerInstanceRef.current !== next) return location.reload();
          if (next) viewerInstanceRef.current = next;
          return;
        }
        if (e.data === "reload") {
          try { fr1Ref.current?.contentWindow?.location.reload(); } catch {}
          if (viewRef.current === "split") {
            try { fr2Ref.current?.contentWindow?.location.reload(); } catch {}
          }
          fetchFiles();
          refreshMap();
        }
        if (e.data === "comments") {
          fetchComments();
          sendToFrames({ cd: "pins" });
          fetchAgent();
        }
        if (e.data === "agent") fetchAgent();
      };

      const initialFile = await fetchFiles();
      loadPreview(initialFile);
      fetchComments();
      fetchAgent();
      const { hasFlows } = await fetchMap();
      const h = pageHash();
      if (isMapHash(h)) {
        lastMapRef.current = h;
        ssSet("cd-last-map", h);
        setMapRoute(h);
      } else if (openedWithoutHashRef.current && hasFlows && (!h || h === initialFile)) {
        location.replace("#map:flows");
      }
    })();

    return () => {
      es?.close();
      clearInterval(tunnelTimer);
      if (updateTimer) clearInterval(updateTimer);
    };
  }, []);

  // Global events: hashchange, keydown, focus, visibilitychange, message
  useEffect(() => {
    const onHash = () => {
      const h = pageHash();
      if (isMapHash(h)) {
        lastMapRef.current = h;
        ssSet("cd-last-map", h);
        setMapRoute(h);
        return;
      }
      setMapRoute(null);
      if (h && h !== curRef.current) setCur(h);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleLeft();
        return;
      }
      const webOpen = (document.getElementById("website-dialog") as HTMLDialogElement | null)?.open;
      const shareOpen = (document.getElementById("share-dialog") as HTMLDialogElement | null)?.open;
      if (webOpen || shareOpen || /input|textarea/i.test((e.target as HTMLElement)?.tagName || "")) return;
      if (e.key === "m" && !e.ctrlKey && !e.metaKey) {
        if (mapRouteRef.current && curRef.current) setCur(curRef.current);
        else goMap();
        return;
      }
      if (mapRouteRef.current && e.key === "Escape") {
        if (modeRef.current) setMode(modeRef.current);
        else if (curRef.current) setCur(curRef.current);
        return;
      }
      if (e.key === "c" && !mapRouteRef.current) setMode("comment");
      if (e.key === "s" && !mapRouteRef.current) setMode("select");
      if (e.key === "Escape") {
        if (modeRef.current) setMode(modeRef.current);
        else goMap();
      }
    };
    const onVis = () => { if (!document.hidden) report(); };
    const onMsg = (e: MessageEvent) => {
      if (e.data?.cd === "picked") {
        allFrames().forEach((f) => f.contentWindow !== e.source && f.contentWindow?.postMessage({ cd: "unpick" }, "*"));
      }
      if (e.data?.cd === "sidebar" && e.source && allFrames().some((f) => f.contentWindow === e.source)) toggleLeft();
    };
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    addEventListener("focus", report);
    document.addEventListener("visibilitychange", onVis);
    addEventListener("message", onMsg);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      removeEventListener("focus", report);
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("message", onMsg);
    };
  }, [allFrames, goMap, report, setCur, setMode]);

  const toggleLeft = () => {
    if (mob) setMobHideLeft((h) => !h);
    else {
      setDeskHideLeft((h) => {
        lsSet("cd-hide-l", h ? "0" : "1");
        return !h;
      });
    }
  };

  const selectTab = (t: SidebarTab) => {
    setActiveTab(t);
    lsSet("cd-ltab", t);
  };

  const setWidth = (w: string) => {
    if (w === "resp" && view !== "resp" && d1Ref.current) {
      const r = d1Ref.current.getBoundingClientRect();
      if (!rsRef.current.set) rsRef.current = { w: Math.round(r.width) || rsRef.current.w, h: Math.round(r.height) || rsRef.current.h };
    }
    setView(w);
    ssSet("cd-width", w);
    if (w === "split") {
      if (curRef.current) loadFrame(fr2Ref.current, previewPath(curRef.current));
    } else {
      loadFrame(fr2Ref.current, "about:blank");
    }
  };

  const startResize = (dx: number, dy: number) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const h = e.currentTarget;
    h.setPointerCapture(e.pointerId);
    document.body.classList.add("drag");
    const x0 = e.clientX, y0 = e.clientY, w0 = rsRef.current.w, h0 = rsRef.current.h;
    const onMove = (m: PointerEvent) => {
      if (dx) rsRef.current.w = Math.max(200, Math.min(4000, w0 + m.clientX - x0));
      if (dy) rsRef.current.h = Math.max(200, Math.min(4000, h0 + m.clientY - y0));
      rsRef.current.set = true;
      applySize();
    };
    const onUp = () => {
      h.removeEventListener("pointermove", onMove);
      h.removeEventListener("pointerup", onUp);
      h.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("drag");
      ssSet("cd-resp", `${Math.round(rsRef.current.w)}x${Math.round(rsRef.current.h)}`);
    };
    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerup", onUp);
    h.addEventListener("pointercancel", onUp);
  };

  const startSidebarResize = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const left = lsideRef.current?.getBoundingClientRect().left ?? 0;
    document.body.classList.add("drag");
    const move = (m: PointerEvent) => {
      const w = Math.round(Math.min(Math.max(m.clientX - left, 200), Math.max(260, innerWidth - 500)));
      document.body.style.setProperty("--lw", w + "px");
    };
    const up = () => {
      document.body.classList.remove("drag");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      lsSet("cd-lw", String(parseInt(document.body.style.getPropertyValue("--lw"))));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };

  const addFolder = async () => {
    const root = prompt("Absolute path of the project folder");
    if (!root) return;
    const setupRes = await fetch("/__cd/setup?root=" + encodeURIComponent(root));
    const setup = await setupRes.json();
    if (!setupRes.ok) return alert(setup.error);
    const options: Record<string, unknown> = {};
    if (!setup.existing) {
      const m = prompt("Project mode: react or html", "react");
      if (m === null) return;
      if (!["react", "html"].includes(m.trim().toLowerCase())) return alert("Choose react or html");
      options.mode = m.trim().toLowerCase();
      const tw = prompt("Use Tailwind CSS? yes or no", "yes");
      if (tw === null) return;
      if (!["yes", "no", "y", "n"].includes(tw.trim().toLowerCase())) return alert("Choose yes or no");
      options.tailwind = ["yes", "y"].includes(tw.trim().toLowerCase());
    }
    const r = await fetch("/__cd/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, ...options }),
    });
    const j = await r.json();
    if (!r.ok) return toast(j.error || "could not add folder");
    location.href = j.url;
  };

  const tunnelAction = async (path: string, label: string) => {
    if (tunnelBusy) return;
    setTunnelBusy(true);
    setTunnelBusyLabel(label);
    try {
      const r = await fetch(path, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Tunnel request failed");
    } catch (e: unknown) {
      toast((e as Error).message || String(e));
    } finally {
      setTunnelBusy(false);
      await fetchTunnelStatus();
    }
  };

  const fileTree = useMemo(() => buildTree(files), [files]);

  const recent = (a: CommentItem, b: CommentItem) => (b.createdAt || "").localeCompare(a.createdAt || "");
  const openComments = useMemo(() => comments.filter((c) => c.status !== "done").sort(recent), [comments]);
  const doneComments = useMemo(() => comments.filter((c) => c.status === "done").sort(recent), [comments]);

  const agentLabel = agentState === "on" ? "Agent listening" : agentState === "working" ? "Agent working" : "No agent listening";
  const currentProjUrl = projectList.find((p) => p.id === currentProject)?.url ?? "";
  const tunnelMsg = tunnel?.starting
    ? "Starting tunnel…"
    : tunnel?.error
      ? "Tunnel unavailable: " + tunnel.error
      : tunnel?.url
        ? "Tunnel: "
        : "Tunnel offline";

  const onFrameLoad = useCallback(
    (f: HTMLIFrameElement) => {
      applyThemeToFrame(f, document.documentElement.dataset.theme || theme);
      setFrameMode(f);
      f.contentWindow?.postMessage({ cd: "pins" }, "*");
    },
    [applyThemeToFrame, setFrameMode, theme]
  );

  const renderCommentCard = (c: CommentItem) => (
    <div
      key={c.id}
      className={`c ${c.status}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).tagName !== "BUTTON" && c.file !== cur) setCur(c.file);
      }}
    >
      <span className="st">{c.status}</span>
      <small>
        {c.file}:{c.cdId}
      </small>
      <div>{c.text}</div>
      <button onClick={() => fetch(`/__cd/comments/${c.id}/${c.status === "done" ? "open" : "done"}`, { method: "POST" })}>
        {c.status === "done" ? "Reopen" : "Done"}
      </button>
      <button onClick={() => fetch(`/__cd/comments/${c.id}/delete`, { method: "POST" })}>Delete</button>
    </div>
  );

  return (
    <>
      <UpdateDialog dialogRef={updateDialogRef} message={updateMessage} />

      <header className="viewer-bar">
        <button
          id="tl"
          className={`ic${!leftHidden ? " on" : ""}`}
          title="Hide/show sidebar (Ctrl+B)"
          aria-keyshortcuts="Control+B"
          onClick={toggleLeft}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
            <path d="M6 3v10" />
          </svg>
        </button>
        <b>cdesign</b>
        <button
          id="more"
          className={`ic${barOpen ? " on" : ""}`}
          title="Show/hide toolbar"
          onClick={() => setBarOpen((o) => !o)}
        >
          <svg viewBox="0 0 16 16" fill="currentColor">
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>

        <div id="bar" ref={barRef}>
          <button
            id="back"
            className="ic"
            title="Back to the map (Esc)"
            aria-label="Back to the map"
            hidden={inMap}
            onClick={() => goMap()}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3 5 8l5 5" />
            </svg>
          </button>

          <span id="views" className="grp seg" role="group" aria-label="View">
            <button data-v="flows" aria-pressed={inMap} title="Flow map (M)" onClick={goMap}>
              Flows
            </button>
            <button
              data-v="files"
              aria-pressed={!inMap}
              title="Open page with the file list"
              onClick={() => {
                if (cur) {
                  if (pageHash() !== cur) location.hash = pagePath(cur);
                  setMapRoute(null);
                } else {
                  setMapRoute(null);
                }
                selectTab("files");
                if (leftHidden) toggleLeft();
              }}
            >
              Files
            </button>
          </span>

          <div className="bar-context">
            <select
              id="proj"
              title="Switch project"
              value={currentProjUrl}
              onChange={async (e) => {
                const v = e.target.value;
                if (v === "#add") return addFolder();
                if (v === "#close" && currentProject) {
                  await fetch(`/__cd/projects/${currentProject}/remove`, { method: "POST" });
                  location.href = location.origin.replace(/^(https?:\/\/)[^.]+\.localhost/, "$1localhost");
                  return;
                }
                if (v) location.href = v;
              }}
            >
              {projectList.map((p) => (
                <option key={p.id} value={p.url}>
                  {p.name}
                </option>
              ))}
              {!remote && <option value="#add">Add folder…</option>}
              {currentProject && !remote && <option value="#close">Close this project</option>}
            </select>

            <button type="button" className="install-app" hidden={!installVisible} onClick={triggerInstall}>
              Install app
            </button>
            <button type="button" className="update-app" hidden={!updateAvailable} disabled={updateBusy} onClick={applyUpdate}>
              Update cdesign
            </button>
            <button
              id="project-tools-toggle"
              ref={toolsToggleRef}
              className="ic"
              popoverTarget="project-tools"
              aria-label="Project tools"
              title="Project tools"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="3" cy="8" r="1.4" />
                <circle cx="8" cy="8" r="1.4" />
                <circle cx="13" cy="8" r="1.4" />
              </svg>
            </button>
            <span id="agent" className={agentState} role="img" aria-label={agentLabel} title={agentLabel}>
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="5" width="11" height="8.5" rx="2" />
                <path d="M8 5V2m-2.5 7h.01m5 0h.01" />
              </svg>
            </span>
          </div>

          <span id="w" className="grp">
            <button className={`ic${view === "100%" ? " on" : ""}`} data-w="100%" title="Full width" onClick={() => setWidth("100%")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.75" y="3" width="12.5" height="8" rx="1.5" />
                <path d="M5.5 13.5h5" />
              </svg>
            </button>
            <button className={`ic${view === "768px" ? " on" : ""}`} data-w="768px" title="Tablet (768px)" onClick={() => setWidth("768px")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="1.75" width="10" height="12.5" rx="1.5" />
                <path d="M7 12.25h2" />
              </svg>
            </button>
            <button className={`ic${view === "phone" ? " on" : ""}`} data-w="phone" title="Phone: pick a device, exact screen size" onClick={() => setWidth("phone")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" />
                <path d="M7 12.25h2" />
              </svg>
            </button>
            <button className={`ic${view === "resp" ? " on" : ""}`} data-w="resp" title="Responsive: drag the edges to resize width and height" onClick={() => setWidth("resp")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.75" y="2.75" width="9.5" height="9.5" rx="1.5" />
                <path d="M14.25 7.5v6.75H7.5M10.5 14.25l3.75-3.75" />
              </svg>
            </button>
            <button className={`ic${view === "split" ? " on" : ""}`} data-w="split" title="Split: mobile on the left, full width on the right" onClick={() => setWidth("split")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.75" y="3.25" width="4" height="9.5" rx="1" />
                <rect x="7.75" y="3.25" width="6.5" height="9.5" rx="1" />
              </svg>
            </button>
          </span>

          <span id="devs" className="grp">
            <select
              id="dev"
              title="Phone screen size (CSS px)"
              value={dev}
              onChange={(e) => {
                setDev(e.target.value);
                ssSet("cd-dev", e.target.value);
              }}
            >
              {Object.entries(DEVICES).map(([k, [w, h]]) => (
                <option key={k} value={k}>
                  {k} · {w}×{h}
                </option>
              ))}
            </select>
            <button
              id="rot"
              className="ic"
              title="Rotate screen"
              onClick={() => {
                setRot((r) => {
                  ssSet("cd-rot", !r ? "1" : "");
                  return !r;
                });
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" transform="rotate(45 8 8)" />
              </svg>
            </button>
            <button
              id="fit"
              className={`ic${fit ? " on" : ""}`}
              aria-label="Fit preview height"
              aria-pressed={fit}
              title="Fit preview height"
              onClick={() => {
                setFit((f) => {
                  ssSet("cd-fit", !f ? "1" : "");
                  return !f;
                });
              }}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 2h12M2 14h12M8 4v8M6 6l2-2 2 2m-4 4 2 2 2-2" />
              </svg>
            </button>
          </span>

          <button
            id="bb"
            title="Move the toolbar to the bottom/top of the screen"
            onClick={() => {
              setBarBottom((b) => {
                lsSet("cd-bar-bottom", !b ? "1" : "0");
                return !b;
              });
            }}
          >
            {barBottom ? "Toolbar: bottom" : "Toolbar: top"}
          </button>

          <div className="bar-actions">
            <button
              id="full-page"
              className="ic"
              aria-label="Full page"
              title="Open full-page preview"
              disabled={!cur}
              onClick={() => cur && (location.href = previewPath(cur) + "?full=1")}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" />
              </svg>
            </button>
            <button
              id="theme"
              className={`ic${theme === "dark" ? " on" : ""}`}
              aria-label="Dark preview"
              aria-pressed={theme === "dark"}
              title="Toggle light/dark preview"
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                lsSet("cd-theme", next);
                setTheme(next);
              }}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="2.75" />
                <path d="M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.5 1.5m7 7L13 13m0-10-1.5 1.5m-7 7L3 13" />
              </svg>
            </button>
            <button
              id="sel"
              className={`ic${mode === "select" ? " on" : ""}`}
              title="Select element for the agent (S)"
              aria-label="Select element for the agent (S)"
              aria-pressed={mode === "select"}
              onClick={() => setMode("select")}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="M3.5 2.5l9 4.2-3.9 1.3-1.3 3.9z" />
                <path d="M8.6 8l3 3.2" />
              </svg>
            </button>
            <button
              id="mode"
              aria-label="Comment (C)"
              aria-pressed={mode === "comment"}
              className={`ic${mode === "comment" ? " on" : ""}`}
              title="Comment (C)"
              onClick={() => setMode("comment")}
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3H2v8h3v3l4-3h5z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <aside className="l" id="lside" ref={lsideRef} data-tab={activeTab}>
        <div id="ltabs" role="tablist">
          <button id="tab-chat" role="tab" aria-selected={activeTab === "chat"} onClick={() => selectTab("chat")}>
            Chat
          </button>
          <button id="tab-files" role="tab" aria-selected={activeTab === "files"} onClick={() => selectTab("files")}>
            Files
          </button>
          <button id="tab-comments" role="tab" aria-selected={activeTab === "comments"} onClick={() => selectTab("comments")}>
            {openComments.length ? `Comments (${openComments.length})` : "Comments"}
          </button>
        </div>

        <div id="files" role="tabpanel">
          {!files.length ? (
            "No preview entries. Add a page or component preview."
          ) : (
            <FileTree
              node={fileTree}
              prefix="design/"
              cur={cur}
              opened={openedDirs}
              onToggle={(key, open) => {
                setOpenedDirs((prev) => {
                  const next = new Set(prev);
                  if (open) next.add(key);
                  else next.delete(key);
                  ssSet("cd-opened", JSON.stringify([...next]));
                  return next;
                });
              }}
              onSelect={(path) => {
                setCur(path);
                if (mob) setMobHideLeft(true);
              }}
            />
          )}
        </div>

        <ChatPane tabId={tabIdRef.current} activeTab={activeTab} comments={comments} />

        <div id="cm" role="tabpanel">
          {!comments.length ? (
            <small style={{ color: "var(--mut)" }}>No comments yet. Toggle Comment and click an element.</small>
          ) : (
            <>
              {openComments.map(renderCommentCard)}
              {doneComments.length > 0 && (
                <details className="cdone" open={doneOpen} onToggle={(e) => setDoneOpen(e.currentTarget.open)}>
                  <summary>Done ({doneComments.length})</summary>
                  {doneComments.map(renderCommentCard)}
                </details>
              )}
            </>
          )}
        </div>

        <i id="lrs" title="Drag to resize" role="separator" aria-orientation="vertical" onPointerDown={startSidebarResize} />
      </aside>

      <ProjectMap
        visible={inMap}
        route={mapRoute ?? "map:flows"}
        data={flowsData}
        mode={mode}
        onToolChange={changeBoardTool}
        onElementSelect={selectBoardElement}
        onOpen={(file) => {
          lastMapRef.current = pageHash();
          setCur(file);
        }}
        onSyncAction={syncAction}
        onFrameLoad={onFrameLoad}
        onNavigateHash={(h) => {
          location.hash = h;
        }}
      />

      <main ref={mainRef}>
        <FlowBar
          cur={cur && curFragment ? cur + "#" + curFragment : cur}
          inMap={inMap}
          data={flowsData}
          onSelectFile={setCur}
          onNavigateHash={(h) => {
            location.hash = h;
          }}
          onSyncAction={syncAction}
        />
        <div id="stage">
          <div className="dev" id="d1" ref={d1Ref}>
            <iframe id="fr" ref={fr1Ref} onLoad={(e) => onFrameLoad(e.currentTarget)} />
            <i className="rh" id="rx" onPointerDown={startResize(1, 0)} />
            <i className="rh" id="ry" onPointerDown={startResize(0, 1)} />
            <i className="rh" id="rxy" onPointerDown={startResize(1, 1)} />
            <span id="dim">{dimText}</span>
          </div>
          <div className="dev" id="d2">
            <iframe id="fr2" ref={fr2Ref} onLoad={(e) => onFrameLoad(e.currentTarget)} />
          </div>
        </div>
      </main>

      <div
        id="pill"
        ref={pillRef}
        onPointerDown={(e) => {
          const p = pillRef.current;
          if (!p) return;
          const r = p.getBoundingClientRect();
          const dx = e.clientX - r.left, dy = e.clientY - r.top, x0 = e.clientX, y0 = e.clientY;
          let moved = false;
          p.setPointerCapture(e.pointerId);
          const onMove = (m: PointerEvent) => {
            if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
            moved = true;
            document.body.classList.add("pdrag");
            const x = Math.max(4, Math.min(innerWidth - r.width - 4, m.clientX - dx));
            const y = Math.max(4, Math.min(innerHeight - r.height - 4, m.clientY - dy));
            Object.assign(p.style, { left: x + "px", top: y + "px", bottom: "auto", transform: "none" });
            placeBar();
          };
          const onUp = () => {
            p.removeEventListener("pointermove", onMove);
            p.removeEventListener("pointerup", onUp);
            p.removeEventListener("pointercancel", onUp);
            document.body.classList.remove("pdrag");
            if (!moved) return;
            const b = p.getBoundingClientRect();
            lsSet("cd-pill", JSON.stringify({ x: (b.left + b.width / 2) / innerWidth, y: (b.top + b.height / 2) / innerHeight }));
            const eat = (c: Event) => c.stopPropagation();
            p.addEventListener("click", eat, true);
            setTimeout(() => p.removeEventListener("click", eat, true), 0);
          };
          p.addEventListener("pointermove", onMove);
          p.addEventListener("pointerup", onUp);
          p.addEventListener("pointercancel", onUp);
        }}
      >
        <button
          id="pl"
          className={!leftHidden || barOpen ? "on" : undefined}
          title="Files and tools"
          onClick={() => {
            const open = !leftHidden || barOpen;
            setMobHideLeft(open);
            setBarOpen(!open);
          }}
        >
          <svg className="o" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
            <path d="M6 3v10" />
          </svg>
          <svg className="x" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div id="pick">
        {currentProject === null && (
          <>
            <h2>cdesign</h2>
            <button type="button" className="install-app" hidden={!installVisible} onClick={triggerInstall}>
              Install app
            </button>
            <button type="button" className="update-app" hidden={!updateAvailable} disabled={updateBusy} onClick={applyUpdate}>
              Update cdesign
            </button>
            <p id="pick-tunnel" className="tunnel-status" role="status" aria-live="polite" title={tunnel?.url || tunnelMsg}>
              {tunnelMsg}
              {tunnel?.url && (
                <a href={tunnel.url} target="_blank" rel="noopener">
                  {tunnel.url}
                </a>
              )}
            </p>
            {projectList.map((p) => (
              <button key={p.id} className="f" onClick={() => (location.href = p.url)}>
                {p.name}
                <br />
                <small>{p.root}</small>
              </button>
            ))}
            <button onClick={addFolder}>Add folder…</button>
          </>
        )}
      </div>

      <div id="toast" className={toastOn ? "on" : undefined}>
        {toastText}
      </div>

      <div id="project-tools" ref={toolsPopoverRef} popover="auto" aria-label="Project tools">
        <button id="share" aria-label="Share screen" title="Create a private link to the open screen" onClick={() => setShareSeq((s) => s + 1)}>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 10V2m-3 3 3-3 3 3M4 8H2.5v6h11V8H12" />
          </svg>
          <span>Share screen</span>
        </button>
        <button id="website" aria-label="Export website" title="Export website" onClick={() => setWebsiteSeq((s) => s + 1)}>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <path d="M2 6h12m-8 4h4" />
          </svg>
          <span>Export website</span>
        </button>
        <button
          id="tunnel"
          className={tunnel?.url ? "on" : undefined}
          aria-label="Tunnel details"
          title="Tunnel details"
          onClick={() => {
            fetchTunnelStatus();
            tunnelDialogRef.current?.showModal();
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" />
            <ellipse cx="8" cy="8" rx="2.75" ry="6" />
            <path d="M2 8h12" />
          </svg>
          <span>Tunnel details</span>
        </button>
      </div>

      <TunnelDialog
        dialogRef={tunnelDialogRef}
        remote={remote}
        tunnel={tunnel}
        busy={tunnelBusy}
        busyLabel={tunnelBusyLabel}
        onAction={tunnelAction}
        onCopy={() =>
          tunnel?.url &&
          navigator.clipboard.writeText(tunnel.url).then(() => toast("Tunnel link copied"), () => toast(tunnel.url!))
        }
      />
      <WebsiteDialog openSeq={websiteSeq} onToast={toast} />
      <ShareDialog openSeq={shareSeq} cur={cur} onToast={toast} />
    </>
  );
}
