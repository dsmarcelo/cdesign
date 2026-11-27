import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPane } from "./Chat";
import { ShareDialog, TunnelDialog, UpdateDialog, WebsiteDialog } from "./Dialogs";
import {
  DEVICES,
  flowOfHash,
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
  type FlowFrame,
  type FlowsData,
  type ProjectInfo,
  type SidebarTab,
  type TunnelInfo,
  type ViewerMode,
} from "./lib";
import { Canvas } from "./Canvas";

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
  forceOpen,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  prefix: string;
  cur: string | null;
  opened: Set<string>;
  forceOpen?: boolean;
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
              open={forceOpen || opened.has(key)}
              onToggle={(e) => onToggle(key, e.currentTarget.open)}
            >
              <summary>{label}</summary>
              <div className="kids">
                <FileTree
                  node={curNode}
                  prefix={key + "/"}
                  cur={cur}
                  opened={opened}
                  forceOpen={forceOpen}
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
  const stageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const lsideRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const toolsPopoverRef = useRef<HTMLDivElement>(null);
  const toolsToggleRef = useRef<HTMLButtonElement>(null);
  const updateDialogRef = useRef<HTMLDialogElement>(null);
  const tunnelDialogRef = useRef<HTMLDialogElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentProject, setCurrentProject] = useState<string | null | undefined>(undefined);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [remote, setRemote] = useState(false);

  const [files, setFiles] = useState<string[]>([]);
  const [fileFilter, setFileFilter] = useState("");
  const [cur, setCurState] = useState<string | null>(() => {
    const h = pageHash();
    return isMapHash(h) ? null : h || null;
  });
  const [curFragment, setCurFragment] = useState("");
  const [mapRoute, setMapRoute] = useState<string | null>(() => {
    const h = pageHash();
    return isMapHash(h) ? h : null;
  });
  const [flowsData, setFlowsData] = useState<FlowsData>({ flows: [] });
  const [interact, setInteract] = useState(() => ssGet("cd-interact") === "1");
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
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
  const curFragmentRef = useRef(curFragment);
  curFragmentRef.current = curFragment;
  const viewRef = useRef(view);
  viewRef.current = view;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const mapRouteRef = useRef(mapRoute);
  mapRouteRef.current = mapRoute;
  const boardPageRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ file: string; cdId: string } | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  const leftHidden = mob ? mobHideLeft : deskHideLeft;
  const inMap = mapRoute !== null;
  const activeFlow = flowsData.flows.find((f) => f.id === flowOfHash(mapRoute)) ?? flowsData.flows[0] ?? null;

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

  const setInteractMode = useCallback((on: boolean) => {
    setInteract(on);
    ssSet("cd-interact", on ? "1" : "");
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

  /** A source file changed: reload the canvas previews (flow layout changes arrive as "flows" and keep them). */
  const refreshMap = useCallback(async () => {
    await fetchMap();
    if (!mapRouteRef.current) return;
    for (const f of document.querySelectorAll<HTMLIFrameElement>("#map iframe[src]")) {
      try {
        f.contentWindow?.location.reload();
      } catch {}
    }
  }, [fetchMap]);

  const flowRequest = useCallback(
    async (path: string, body: unknown) => {
      const r = await fetch("/__cd/flows" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(j.error || "Could not update the tab");
        fetchMap();
        return null;
      }
      return j as { flow?: { id: string } };
    },
    [toast, fetchMap]
  );

  const saveFrames = useCallback(
    (id: string, frames: FlowFrame[]) => {
      setFlowsData((d) => ({ flows: d.flows.map((f) => (f.id === id ? { ...f, frames } : f)) }));
      flowRequest("/" + id, { frames });
    },
    [flowRequest]
  );

  const newTab = useCallback(async () => {
    const j = await flowRequest("", { title: "Untitled" });
    if (!j?.flow) return;
    await fetchMap();
    location.hash = "flow:" + j.flow.id;
    setRenamingTab(j.flow.id);
  }, [flowRequest, fetchMap]);

  const renameTab = useCallback(
    async (id: string, title: string) => {
      setRenamingTab(null);
      const t = title.trim();
      if (!t || t === flowsData.flows.find((f) => f.id === id)?.title) return;
      setFlowsData((d) => ({ flows: d.flows.map((f) => (f.id === id ? { ...f, title: t } : f)) }));
      await flowRequest("/" + id, { title: t });
    },
    [flowRequest, flowsData]
  );

  const closeTab = useCallback(
    async (id: string) => {
      const f = flowsData.flows.find((x) => x.id === id);
      if (!f || !confirm(`Delete the tab “${f.title}”? Its pages stay; only design/flows/${id}.json is removed.`)) return;
      if (!(await flowRequest(`/${id}/delete`, {}))) return;
      const rest = flowsData.flows.filter((x) => x.id !== id);
      await fetchMap();
      if (flowOfHash(mapRouteRef.current) === id || !mapRouteRef.current) location.hash = rest[0] ? "flow:" + rest[0].id : "map:flows";
    },
    [flowRequest, fetchMap, flowsData]
  );

  // Sync body classes and CSS variables
  useEffect(() => {
    document.body.classList.toggle("hl", leftHidden);
    document.body.classList.toggle("map", inMap);
    document.body.classList.toggle("resp", view === "resp");
    document.body.classList.toggle("tablet", view === "768px");
    document.body.classList.toggle("phone", view === "phone");
    document.body.classList.toggle("split", view === "split");
    document.body.classList.toggle("remote", remote);
    document.body.classList.toggle("nop", currentProject === null);
  }, [leftHidden, inMap, view, remote, currentProject]);

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
    if (innerWidth <= 480) {
      f.style.removeProperty("--dw");
      f.style.removeProperty("--dh");
      f.style.removeProperty("--ds");
      d.style.width = "100%";
      d.style.height = "100%";
      return;
    }
    const availW = Math.max(200, (stageRef.current?.clientWidth ?? mainRef.current?.clientWidth ?? innerWidth) - 16);
    const availH = Math.max(200, (stageRef.current?.clientHeight ?? mainRef.current?.clientHeight ?? innerHeight) - 16);
    if (view === "phone") {
      const [w, h] = rot ? [...DEVICES[dev]].reverse() : DEVICES[dev];
      const sw = Math.min(1, availW / w);
      const sh = fit ? Math.min(1, availH / h) : 1;
      const s = Math.min(sw, sh);
      f.style.setProperty("--dw", w + "px");
      f.style.setProperty("--dh", h + "px");
      f.style.setProperty("--ds", String(s));
      d.style.width = Math.round(w * s) + "px";
      d.style.height = Math.round(h * s) + "px";
      return;
    }
    if (view === "768px") {
      if (availW < 768) {
        const s = availW / 768;
        f.style.setProperty("--dw", "768px");
        f.style.setProperty("--dh", Math.round(availH / s) + "px");
        f.style.setProperty("--ds", String(s));
        d.style.width = Math.round(768 * s) + "px";
        d.style.height = availH + "px";
      } else {
        f.style.removeProperty("--dw");
        f.style.removeProperty("--dh");
        f.style.removeProperty("--ds");
        d.style.width = "768px";
        d.style.height = "";
      }
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
      setMob(matchMedia("(max-width:700px)").matches);
      applySize();
    };
    addEventListener("resize", onResize);
    let raf = 0;
    const ro = stageRef.current
      ? new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(applySize);
        })
      : null;
    if (ro && stageRef.current) ro.observe(stageRef.current);
    return () => {
      removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [applySize]);

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
        if (e.data === "flows") fetchMap();
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
      await fetchMap();
      const h = pageHash();
      if (isMapHash(h)) {
        lastMapRef.current = h;
        ssSet("cd-last-map", h);
        setMapRoute(h);
      } else if (openedWithoutHashRef.current && (!h || h === initialFile)) {
        location.replace("#" + (ssGet("cd-last-map") || "map:flows"));
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
      if (mapRouteRef.current) return; // the canvas handles its own keys
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
      if (e.data?.cd === "hash" && viewRef.current === "split") {
        const other = e.source === fr1Ref.current?.contentWindow ? fr2Ref.current : e.source === fr2Ref.current?.contentWindow ? fr1Ref.current : null;
        try {
          if (other?.contentWindow && other.contentWindow.location.hash !== e.data.hash) {
            other.contentWindow.location.hash = e.data.hash;
          }
        } catch {}
      }
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
    if (w === "split" && !mob && !deskHideLeft && innerWidth < 1280) {
      setDeskHideLeft(true);
    }
    setView(w);
    ssSet("cd-width", w);
    if (w === "split") {
      if (curRef.current) {
        let liveHash = "";
        try { liveHash = fr1Ref.current?.contentWindow?.location.hash || ""; } catch {}
        if (!liveHash && curFragmentRef.current) liveHash = "#" + curFragmentRef.current;
        loadFrame(fr2Ref.current, previewPath(curRef.current + liveHash));
      }
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

  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    return q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
  }, [files, fileFilter]);
  const fileTree = useMemo(() => buildTree(filteredFiles), [filteredFiles]);

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
      if (f === fr1Ref.current && pendingFocusRef.current) {
        f.contentWindow?.postMessage({ cd: "focus", ...pendingFocusRef.current }, "*");
        pendingFocusRef.current = null;
      }
    },
    [applyThemeToFrame, setFrameMode, theme]
  );

  const jumpToComment = useCallback(
    (c: CommentItem) => {
      pendingFocusRef.current = { file: c.file, cdId: c.cdId };
      if (!inMap && curRef.current && (c.file === curRef.current || !files.includes(c.file))) {
        fr1Ref.current?.contentWindow?.postMessage({ cd: "focus", file: c.file, cdId: c.cdId }, "*");
        pendingFocusRef.current = null;
      } else {
        setCur(c.file);
      }
      if (mob) setMobHideLeft(true);
    },
    [files, inMap, mob, setCur]
  );

  const renderCommentCard = (c: CommentItem) => (
    <div
      key={c.id}
      className={`c ${c.status}`}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) jumpToComment(c);
      }}
    >
      <span className="st">{c.status}</span>
      <button
        type="button"
        className="c-loc link"
        title={`Jump to ${c.file}:${c.cdId}`}
        onClick={() => jumpToComment(c)}
      >
        {c.file}:{c.cdId}
      </button>
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
        <button
          id="pl"
          type="button"
          className={`ic${!leftHidden ? " on" : ""}`}
          title="Chat, files and comments"
          aria-label="Chat, files and comments"
          aria-expanded={!leftHidden}
          onClick={() => {
            const isMob = matchMedia("(max-width:700px)").matches;
            if (isMob && !mob) setMob(true);
            setMobHideLeft((h) => !h);
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
          </svg>
        </button>
        <div className="bar-proj">
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

        </div>
        <nav className="tabs" role="tablist" aria-label="Flows">
          {flowsData.flows.map((f) => {
            const on = inMap && f.id === activeFlow?.id;
            return (
              <div
                key={f.id}
                role="tab"
                tabIndex={0}
                aria-selected={on}
                className={`tab${on ? " on" : ""}${!inMap && f.id === activeFlow?.id ? " last" : ""}${f.errors.length ? " bad" : ""}`}
                title={f.errors.length ? f.errors.join("\n") : f.description || f.title}
                onClick={() => { if (renamingTab !== f.id) location.hash = "flow:" + f.id; }}
                onDoubleClick={() => setRenamingTab(f.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.hash = "flow:" + f.id; }
                  if (e.key === "F2") setRenamingTab(f.id);
                }}
              >
                {renamingTab === f.id ? (
                  <input
                    autoFocus
                    aria-label="Tab name"
                    defaultValue={f.title}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => renameTab(f.id, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenamingTab(null);
                    }}
                  />
                ) : (
                  <span>{f.title}</span>
                )}
                <button
                  type="button"
                  className="x"
                  aria-label={`Delete tab ${f.title}`}
                  title="Delete tab"
                  onClick={(e) => { e.stopPropagation(); closeTab(f.id); }}
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4.5 4.5l7 7m0-7-7 7" /></svg>
                </button>
              </div>
            );
          })}
          <button type="button" className="ic tab-add" title="New tab" aria-label="New tab" onClick={newTab}>
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          </button>
        </nav>
        <div className="bar-right">
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
            Comments{openComments.length > 0 && <span className="tab-badge">{openComments.length}</span>}
          </button>
        </div>

        <div id="files" role="tabpanel">
          {!files.length ? (
            "No preview entries. Add a page or component preview."
          ) : (
            <>
              <input
                type="search"
                className="file-filter"
                placeholder="Filter files…"
                aria-label="Filter files"
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
              />
              {!filteredFiles.length ? (
                <small style={{ color: "var(--mut)" }}>No files match “{fileFilter.trim()}”.</small>
              ) : (
                <FileTree
                  node={fileTree}
                  prefix="design/"
                  cur={cur}
                  opened={openedDirs}
                  forceOpen={Boolean(fileFilter.trim())}
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
            </>
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

      <Canvas
        visible={inMap}
        flow={activeFlow}
        files={files}
        mode={mode}
        interact={interact}
        onInteract={setInteractMode}
        onToolChange={changeBoardTool}
        onElementSelect={selectBoardElement}
        onOpen={(file) => {
          lastMapRef.current = activeFlow ? "flow:" + activeFlow.id : pageHash();
          ssSet("cd-last-map", lastMapRef.current);
          setCur(file);
        }}
        onSave={saveFrames}
        onToast={toast}
        onFrameLoad={onFrameLoad}
        onNewTab={newTab}
      />

      <main ref={mainRef}>
        <div id="bar" className="page-bar">
          <button id="back" type="button" title="Back to the canvas (Esc)" aria-label="Back to the canvas" onClick={() => goMap()}>
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3 5 8l5 5" />
            </svg>
            <span>{activeFlow?.title ?? "Canvas"}</span>
          </button>
          <span className="page-name" title={cur ?? undefined}>
            {cur?.replace(/^design\//, "")}
            {curFragment && <small>#{curFragment}</small>}
          </span>
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
        <div id="stage" ref={stageRef}>
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

      {mob && !leftHidden && <div id="mob-backdrop" onClick={() => setMobHideLeft(true)} />}

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
