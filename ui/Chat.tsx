import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { lsGet, lsSet, type CommentItem, type SidebarTab } from "./lib";

type CapabilityModel = { id: string; label: string; efforts?: string[] };
type Capabilities = { source: string; note: string; models: CapabilityModel[]; efforts: string[]; defaultLabel: string };
type Provider = { id: string; label: string; state: string; message?: string; capabilities?: Capabilities };
type ChatItem = { id: string; kind: string; text?: string; output?: string; status?: string; context?: unknown };
type Approval = { id: string; tool: string; detail: string; reason?: string };
type Conv = {
  id: string;
  title: string;
  provider: string;
  sessionId?: string;
  fullAccess: boolean;
  model: string | null;
  effort: string | null;
  turnId?: string | null;
  items: ChatItem[];
  approvals: Approval[];
  error?: string | null;
  last?: string | null;
};
type ConvSummary = { id: string; title: string };
type ContextItem = { file: string; state: string; cdId?: string; selector?: string; tag?: string };
type SlashCmd = { name: string; hint?: string; local?: boolean; description?: string };

const RESUME: Record<string, string> = { claude: "claude --resume", codex: "codex resume" };
const MODE_HELP = {
  full: "Full access: the agent can read, write and run commands in this project without asking. Provider or managed restrictions may still apply.",
  normal: "Normal: the agent works in the project sandbox with your provider's permission rules; actions that need approval pause here for Allow once or Deny.",
};
const ICONS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  up: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  chevron: "M6 9l6 6 6-6",
  terminal: "M4 17l6-6-6-6M12 19h8",
};
const STATUS: Record<string, string> = {
  empty: "New chat: nothing sent yet",
  starting: "Starting the agent…",
  approval: "Waiting for your approval",
  streaming: "Working…",
  other: "Working in another chat",
  completed: "Done",
  stopped: "Stopped",
  interrupted: "Interrupted",
  failed: "Failed",
  idle: "Ready",
};
const PROV_STATE: Record<string, string> = {
  missing: "not installed",
  login: "not logged in",
  unsupported: "update needed",
  error: "error",
};
const WHY: Record<string, string> = { missing: "file no longer exists", stale: "element no longer exists" };
const NONE_CAPS: Capabilities = { source: "fallback", note: "", models: [], efforts: [], defaultLabel: "Default" };

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const safeHref = (u: string) => {
  try {
    const x = new URL(u);
    return /^(https?:|mailto:)$/.test(x.protocol) ? x.href : null;
  } catch {
    return null;
  }
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function renderInline(text: string) {
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  const out: React.ReactNode[] = [];
  let at = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k++}>{m[2]}</strong>);
    else {
      const href = safeHref(m[4]);
      if (href) out.push(<a key={k++} href={href} target="_blank" rel="noopener noreferrer nofollow">{m[3]}</a>);
      else out.push(m[3] + " (" + m[4] + ")");
    }
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  let k = 0;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(
        <pre key={k++} className="cc-code" tabIndex={0}>
          <code>{code.join("\n")}</code>
        </pre>
      );
    } else if (/^\s*#{1,6}\s+\S/.test(line)) {
      out.push(
        <p key={k++} className="cc-h">
          {renderInline(line.replace(/^\s*#{1,6}\s+/, ""))}
        </p>
      );
      i++;
    } else if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        <div key={k++} className="cc-tablewrap">
          <table className="cc-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{renderInline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ""));
      }
      const Tag = ordered ? "ol" : "ul";
      out.push(
        <Tag key={k++}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </Tag>
      );
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*```/.test(lines[i]) &&
        !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) &&
        !/^\s*#{1,6}\s+\S/.test(lines[i]) &&
        !/^\s*\|/.test(lines[i])
      ) {
        para.push(lines[i++]);
      }
      out.push(
        <p key={k++}>
          {para.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {renderInline(l)}
            </Fragment>
          ))}
        </p>
      );
    }
  }
  return <>{out}</>;
}

const api = (p: string, o?: RequestInit) => fetch("/__cd/chat" + p, o);
const post = (p: string, body: unknown) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function ChatPane({
  tabId,
  activeTab,
  comments,
}: {
  tabId: string;
  activeTab: SidebarTab;
  comments: CommentItem[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const titleBtnRef = useRef<HTMLButtonElement>(null);
  const pickBtnRef = useRef<HTMLButtonElement>(null);
  const smenuRef = useRef<HTMLDivElement>(null);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [conv, setConv] = useState<Conv | null>(null);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posting, setPosting] = useState(false);
  const [fresh, setFresh] = useState<{ fullAccess: boolean; model: string | null; effort: string | null }>({
    fullAccess: true,
    model: null,
    effort: null,
  });
  const [note, setNote] = useState<{ text: string; err: boolean; go?: string }>({ text: "", err: false });
  const [menu, setMenu] = useState<null | "convs" | "picker">(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [answeredApprovals, setAnsweredApprovals] = useState<Set<string>>(() => new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [draftText, setDraftText] = useState("");

  const [autoCtx, setAutoCtx] = useState<{ page: ContextItem | null; selection: ContextItem | null }>({ page: null, selection: null });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const [slashAt, setSlashAt] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [commandsTick, setCommandsTick] = useState(0);
  const cmdCacheRef = useRef<Map<string, { at: number; list: SlashCmd[] }>>(new Map());

  const stateRef = useRef({
    conv: null as Conv | null,
    convs: [] as ConvSummary[],
    activeId: null as string | null,
    busy: false,
    posting: false,
    draft: false,
    seq: 0,
    epoch: "",
    selectedProvider: "",
    providers: [] as Provider[],
    fresh: { fullAccess: true, model: null as string | null, effort: null as string | null },
    renderedId: null as string | null,
    stickNext: true,
    es: null as EventSource | null,
    armedTimer: 0 as unknown as ReturnType<typeof setTimeout>,
  });
  stateRef.current.conv = conv;
  stateRef.current.convs = convs;
  stateRef.current.activeId = activeId;
  stateRef.current.busy = busy;
  stateRef.current.posting = posting;
  stateRef.current.selectedProvider = selectedProvider;
  stateRef.current.providers = providers;
  stateRef.current.fresh = fresh;

  const addedComments = comments.filter((c) => c.status === "draft" || c.status === "queued");
  const addedIds = new Set(addedComments.map((c) => c.id));

  useEffect(() => {
    setDismissed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const k of next) {
        if (k.startsWith("c:") && !addedIds.has(k.slice(2))) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [comments]);

  const activeProvider = conv?.provider ?? selectedProvider;
  const providerObj = providers.find((p) => p.id === activeProvider);
  const caps = providerObj?.capabilities ?? NONE_CAPS;
  const isReady = providers.find((p) => p.id === selectedProvider)?.state === "ready";
  const curSettings = conv ?? fresh;
  const mine = !!conv && busy && activeId === conv.id;

  const effortsFor = (c: Capabilities, model: string | null) =>
    model ? c.models.find((m) => m.id === model)?.efforts ?? c.efforts : c.efforts;

  const chipList = [
    ...(autoCtx.page ? [{ k: "page:" + autoCtx.page.file, type: "page" as const, label: autoCtx.page.file, c: autoCtx.page }] : []),
    ...(autoCtx.selection
      ? [
          {
            k: "el:" + autoCtx.selection.file + ":" + autoCtx.selection.cdId,
            type: "selection" as const,
            label: `${autoCtx.selection.file} ${autoCtx.selection.cdId}${autoCtx.selection.tag ? " <" + autoCtx.selection.tag + ">" : ""}`,
            c: autoCtx.selection,
          },
        ]
      : []),
  ].filter((x) => !dismissed.has(x.k));

  const visibleCommentChips = addedComments.filter((c) => !dismissed.has("c:" + c.id));
  const commentIds = () => visibleCommentChips.map((c) => c.id);

  const showNote = (text: string, err = false, go?: string) => setNote({ text, err, go });

  const refreshNote = (
    nextBusy = stateRef.current.busy,
    nextActive = stateRef.current.activeId,
    nextConv = stateRef.current.conv,
    nextConvs = stateRef.current.convs,
    nextProv = stateRef.current.selectedProvider,
    nextProviders = stateRef.current.providers
  ) => {
    if (nextBusy && nextActive && nextActive !== nextConv?.id) {
      return showNote(
        `The agent is working in "${nextConvs.find((c) => c.id === nextActive)?.title ?? "another chat"}". Click to open it, where you can Stop it or answer requests.`,
        false,
        nextActive
      );
    }
    if (nextConv?.error && !nextBusy) return showNote(nextConv.error, true);
    const p = nextProviders.find((x) => x.id === nextProv);
    showNote(!nextConv && p && p.state !== "ready" ? p.message || "" : "", true);
  };

  /** Without a project (bare localhost) the server answers 404 `{error}`; throw rather than store an undefined list, which would crash the render and blank the viewer. */
  const snapshot = async (q: string) => {
    const r = await api("?c=" + encodeURIComponent(q));
    const s = await r.json();
    if (!r.ok || !Array.isArray(s.conversations)) throw new Error(s.error || "Could not load the chat");
    return s;
  };

  const refreshList = async () => {
    try {
      const curId = stateRef.current.conv?.id ?? "";
      const s = await snapshot(curId);
      setConvs(s.conversations);
      if (curId && s.conversation?.id === curId && s.conversation.sessionId) {
        setConv((prev) => (prev && prev.id === curId ? { ...prev, sessionId: s.conversation.sessionId } : prev));
      }
    } catch {}
  };

  const load = async (cid?: string) => {
    const st = stateRef.current;
    const q = st.draft ? "" : cid ?? st.conv?.id ?? lsGet("cd-conv") ?? "";
    const s = await snapshot(q);
    st.seq = s.seq;
    st.epoch = s.epoch;
    const nextConv: Conv | null = st.draft ? null : s.conversation;
    if (nextConv) lsSet("cd-conv", nextConv.id);
    setConvs(s.conversations);
    setActiveId(s.activeId);
    setBusy(s.busy);
    setConv(nextConv);
    if (nextConv) setSelectedProvider(nextConv.provider);
    refreshNote(s.busy, s.activeId, nextConv, s.conversations, nextConv ? nextConv.provider : st.selectedProvider, st.providers);
  };

  const openChat = (id: string) => {
    stateRef.current.draft = false;
    return load(id).catch(() => showNote("Could not open that chat", true));
  };

  const newChat = () => {
    stateRef.current.draft = true;
    setConv(null);
    setFresh({ fullAccess: true, model: null, effort: null });
    refreshNote(stateRef.current.busy, stateRef.current.activeId, null);
    boxRef.current?.focus();
  };

  const loadCommands = async (pid: string) => {
    const hit = cmdCacheRef.current.get(pid);
    if (hit && Date.now() - hit.at < 60000) return;
    try {
      const r = await api("/commands?provider=" + encodeURIComponent(pid));
      cmdCacheRef.current.set(pid, { at: Date.now(), list: r.ok ? (await r.json()).commands ?? [] : [] });
      setCommandsTick((t) => t + 1);
    } catch {}
  };

  const refreshContext = async () => {
    if (document.hidden || activeTab !== "chat") return;
    try {
      const r = await fetch("/__cd/chat/context?tab=" + encodeURIComponent(tabId));
      if (!r.ok) return;
      const next = await r.json();
      setAutoCtx((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch {}
  };

  useEffect(() => {
    const id = setInterval(refreshContext, 1000);
    return () => clearInterval(id);
  }, [tabId, activeTab]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement)?.closest(".cc-menu, .cc-title, .cc-pick")) {
        setMenu(null);
        setSlashOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  useEffect(() => {
    const st = stateRef.current;
    const checkStick = () => {
      const el = logRef.current;
      st.stickNext = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    const reduce = (ev: any) => {
      const curConv = st.conv;
      if (ev.cid && ev.cid !== curConv?.id && !["turn.begin", "turn.completed"].includes(ev.type)) return;
      checkStick();
      switch (ev.type) {
        case "turn.begin": {
          setBusy(true);
          setActiveId(ev.conversation.id);
          if (curConv?.id !== ev.conversation.id) {
            if (!(st.draft && st.posting)) break;
            st.draft = false;
            lsSet("cd-conv", ev.conversation.id);
          }
          showNote("");
          setAnsweredApprovals(new Set());
          setConv((prev) => {
            const base: Conv =
              prev && prev.id === ev.conversation.id
                ? { ...prev, items: [...prev.items], approvals: [] }
                : { ...ev.conversation, items: [], approvals: [], error: null, last: null };
            base.turnId = null;
            base.fullAccess = ev.conversation.fullAccess;
            base.model = ev.conversation.model;
            base.effort = ev.conversation.effort;
            base.items.push({ id: ev.itemId, kind: "user", text: ev.text, context: ev.context });
            return base;
          });
          break;
        }
        case "turn.started":
          setConv((prev) => (prev ? { ...prev, turnId: ev.turnId } : prev));
          break;
        case "item.started":
          setConv((prev) => {
            if (!prev || prev.items.some((i) => i.id === ev.item.id)) return prev;
            return { ...prev, items: [...prev.items, { ...ev.item }] };
          });
          break;
        case "item.delta":
          setConv((prev) => {
            if (!prev) return prev;
            const idx = prev.items.findIndex((i) => i.id === ev.itemId);
            if (idx < 0) return prev;
            const items = [...prev.items];
            const it = { ...items[idx] };
            if (it.kind === "message") it.text = (it.text || "") + ev.text;
            else it.output = (it.output || "") + ev.text;
            items[idx] = it;
            return { ...prev, items };
          });
          break;
        case "item.completed":
          setConv((prev) => {
            if (!prev) return prev;
            const idx = prev.items.findIndex((i) => i.id === ev.item.id);
            const items = [...prev.items];
            if (idx < 0) items.push({ ...ev.item });
            else {
              const curIt = items[idx];
              items[idx] = {
                ...curIt,
                ...ev.item,
                ...(curIt.kind === "message"
                  ? ev.item.text ? {} : { text: curIt.text }
                  : ev.item.output ? {} : { output: curIt.output }),
              };
            }
            return { ...prev, items };
          });
          break;
        case "approval.requested":
          setConv((prev) => {
            if (!prev || prev.approvals.some((a) => a.id === ev.approval.id)) return prev;
            return { ...prev, approvals: [...prev.approvals, { ...ev.approval }] };
          });
          break;
        case "approval.resolved":
          setConv((prev) => (prev ? { ...prev, approvals: prev.approvals.filter((a) => a.id !== ev.id) } : prev));
          break;
        case "list":
          load().catch(() => {});
          break;
        case "settings":
          if (ev.conversationId) {
            setConv((prev) =>
              prev && prev.id === ev.conversationId
                ? { ...prev, fullAccess: ev.fullAccess, model: ev.model ?? null, effort: ev.effort ?? null }
                : prev
            );
          }
          break;
        case "turn.completed":
          setBusy(false);
          setActiveId(null);
          setConv((prev) => {
            if (!prev || ev.cid !== prev.id) return prev;
            return {
              ...prev,
              turnId: null,
              approvals: [],
              last: ev.status,
              error: ev.status === "failed" ? ev.error ?? "The turn failed" : null,
              items: prev.items.map((it) =>
                it.status === "inProgress" ? { ...it, status: ev.status === "completed" ? "completed" : ev.status } : it
              ),
            };
          });
          refreshList();
          if (ev.cid !== st.conv?.id) {
            refreshNote(false, null);
            break;
          }
          if (ev.status === "failed") showNote(ev.error || "The turn failed", true);
          else if (ev.status === "interrupted") showNote("Stopped. What the agent said so far is kept.");
          break;
      }
    };

    const connect = () => {
      st.es?.close();
      const es = new EventSource(`/__cd/chat/events?after=${st.seq}&epoch=${encodeURIComponent(st.epoch)}`);
      st.es = es;
      es.onmessage = async (m) => {
        const ev = JSON.parse(m.data);
        if (ev.type === "reset") {
          await load().catch(() => {});
          connect();
          return;
        }
        if (ev.seq <= st.seq) return;
        st.seq = ev.seq;
        reduce(ev);
      };
    };

    const discover = async () => {
      let list: Provider[] = [];
      try {
        const found = await (await api("/providers")).json();
        if (!Array.isArray(found.providers)) throw new Error("Agent discovery unavailable");
        list = found.providers;
        setProjectRoot(found.root || "");
      } catch {
        showNote("Could not look for installed agents", true);
      }
      setProviders(list);
      const nextProv = st.conv ? st.conv.provider : list.find((p) => p.state === "ready")?.id ?? list[0]?.id ?? "";
      setSelectedProvider(nextProv);
      refreshNote(st.busy, st.activeId, st.conv, st.convs, nextProv, list);
      if (nextProv) loadCommands(nextProv);
    };

    (async () => {
      await load().catch(() => showNote("Could not load the chat", true));
      await discover();
      connect();
    })();

    return () => {
      st.es?.close();
      clearTimeout(st.armedTimer);
    };
  }, []);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const st = stateRef.current;
    const switched = st.renderedId !== (conv?.id ?? null);
    st.renderedId = conv?.id ?? null;
    if (switched || st.stickNext) {
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    } else {
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    }
  }, [conv?.id, conv?.items, conv?.approvals]);

  const slashMatch = draftText.match(/^\/([^\s]*)$/);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const slashRows: SlashCmd[] = (() => {
    void commandsTick;
    if (slashQuery === null || !isReady || !slashOpen) return [];
    const list = cmdCacheRef.current.get(activeProvider)?.list ?? [];
    return [
      ...list.filter((c) => c.name.toLowerCase().startsWith(slashQuery)),
      ...list.filter((c) => !c.name.toLowerCase().startsWith(slashQuery) && c.name.toLowerCase().includes(slashQuery)),
    ].slice(0, 60);
  })();
  const safeSlashAt = Math.min(slashAt, Math.max(0, slashRows.length - 1));

  useEffect(() => {
    if (slashRows.length && smenuRef.current) {
      (smenuRef.current.children[safeSlashAt] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    }
  }, [safeSlashAt, slashRows.length]);

  const chooseSlash = (c: SlashCmd) => {
    const val = "/" + c.name + " ";
    if (boxRef.current) boxRef.current.value = val;
    setDraftText(val);
    setSlashOpen(false);
    boxRef.current?.focus();
  };

  const send = async () => {
    const raw = boxRef.current?.value ?? draftText;
    const text = raw.trim() || (commentIds().length ? "Apply the attached comments." : "");
    if (!text || busy || posting || !isReady) return;
    setPosting(true);
    stateRef.current.posting = true;
    try {
      await refreshContext();
      const ctx: Record<string, unknown> = {};
      for (const x of chipList) {
        if (x.c.state === "ok") {
          ctx[x.type] = x.type === "page" ? { file: x.c.file } : { file: x.c.file, cdId: x.c.cdId, selector: x.c.selector, tag: x.c.tag };
        }
      }
      const cs = commentIds();
      if (cs.length) ctx.comments = cs;
      const context = Object.keys(ctx).length ? ctx : undefined;
      const r = await post(
        "/send",
        conv
          ? { text, provider: selectedProvider, conversationId: conv.id, context }
          : { text, provider: selectedProvider, fullAccess: fresh.fullAccess, model: fresh.model, effort: fresh.effort, context }
      );
      if (r.ok) {
        if (boxRef.current) boxRef.current.value = "";
        setDraftText("");
        const { conversationId } = await r.json().catch(() => ({}));
        if (stateRef.current.draft && conversationId) {
          stateRef.current.draft = false;
          await load(conversationId).catch(() => {});
        }
      } else {
        const j = await r.json().catch(() => ({}));
        showNote(j.error || "Could not send", true, j.activeConversationId);
      }
    } catch {
      showNote("Could not reach cdesign", true);
    }
    setPosting(false);
    stateRef.current.posting = false;
  };

  const stop = () =>
    post("/stop", { conversationId: conv?.id, turnId: conv?.turnId }).then(async (r) => {
      if (!r.ok) showNote((await r.json().catch(() => ({}))).error || "Could not stop", true);
    });

  const chooseSetting = async (patch: { model?: string | null; effort?: string | null }) => {
    const next = { model: curSettings.model, effort: curSettings.effort, ...patch };
    if (patch.model !== undefined && next.effort && !effortsFor(caps, next.model).includes(next.effort)) {
      showNote(`"${next.effort}" effort is not available for ${next.model || "the default model"}, so effort went back to the default.`);
      next.effort = null;
    }
    if (!conv) {
      setFresh((f) => ({ ...f, ...next }));
      return;
    }
    const r = await post("/settings", { conversationId: conv.id, model: next.model, effort: next.effort }).catch(() => null);
    if (r?.ok) setConv((prev) => (prev ? { ...prev, model: next.model, effort: next.effort } : prev));
    else showNote(r ? (await r.json().catch(() => ({}))).error || "Could not change the setting" : "Could not reach cdesign", true);
  };

  const chooseModel = async (pid: string, model: string) => {
    if (pid === activeProvider) return chooseSetting({ model: model || null });
    const label = providers.find((p) => p.id === pid)?.label ?? pid;
    const from = !!conv;
    setSelectedProvider(pid);
    if (conv) newChat();
    setFresh((f) => ({ ...f, model: model || null, effort: null }));
    if (from) showNote(`A chat keeps its agent, so this is a new chat with ${label}.`);
    loadCommands(pid);
  };

  const armDelete = async (c: ConvSummary) => {
    if (c.id === activeId && busy) return;
    if (armed !== c.id) {
      setArmed(c.id);
      clearTimeout(stateRef.current.armedTimer);
      stateRef.current.armedTimer = setTimeout(() => setArmed(null), 3000);
      return;
    }
    clearTimeout(stateRef.current.armedTimer);
    setArmed(null);
    const r = await post("/delete", { conversationId: c.id }).catch(() => null);
    if (!r?.ok) {
      return showNote(r ? (await r.json().catch(() => ({}))).error || "Could not delete" : "Could not reach cdesign", true);
    }
    if (c.id === conv?.id) {
      stateRef.current.draft = false;
      setConv(null);
      lsSet("cd-conv", "");
      await load().catch(() => {});
    } else {
      await refreshList();
    }
  };

  const statusKey = (() => {
    if (busy && mine) return conv!.approvals?.length ? "approval" : !conv!.turnId ? "starting" : "streaming";
    if (busy) return "other";
    if (!conv || !conv.items.length) return "empty";
    if (conv.last === "failed") return "failed";
    if (conv.last === "interrupted") return conv.error?.startsWith("Interrupted") ? "interrupted" : "stopped";
    return conv.last === "completed" ? "completed" : "idle";
  })();

  const savedConv = convs.find((c) => c.id === conv?.id);
  const titleLabel =
    (savedConv && savedConv.id === activeId && busy ? "● " : "") + (savedConv?.title ?? conv?.title ?? "New chat");

  const pickNameText = curSettings.model
    ? caps.models.find((m) => m.id === curSettings.model)?.label ?? curSettings.model
    : `${providerObj?.label ?? "Agent"} ${caps.defaultLabel}`;
  const pickEffortText = curSettings.effort ? cap(curSettings.effort) : "";
  const pickDisabled = busy || posting;

  const visibleItems = (conv?.items ?? []).filter((it) => it.kind === "user" || it.kind === "message" || it.kind === "notice");

  return (
    <div
      id="chat"
      ref={rootRef}
      role="tabpanel"
      onKeyDown={(e) => {
        if (e.key === "Escape" && menu) {
          const t = menu === "convs" ? titleBtnRef.current : pickBtnRef.current;
          setMenu(null);
          t?.focus();
        }
      }}
    >
      <div className="cc-convs">
        <button
          ref={titleBtnRef}
          type="button"
          className="cc-title"
          aria-haspopup="menu"
          aria-expanded={menu === "convs"}
          title="Switch chat"
          onClick={() => setMenu((m) => (m === "convs" ? null : "convs"))}
        >
          <span className="cc-title-text">{titleLabel}</span>
          <Icon name="chevron" />
        </button>
        <button
          type="button"
          className="cc-icon"
          aria-label="New chat"
          title="New chat"
          onClick={() => {
            setMenu(null);
            newChat();
          }}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="cc-icon"
          aria-label="Copy the command that continues this chat in a terminal"
          title="Copy the command that continues this chat in a terminal"
          disabled={!conv?.sessionId || !RESUME[conv.provider]}
          onClick={async () => {
            if (!conv?.sessionId || !RESUME[conv.provider]) return;
            const quote = (t: string) => "'" + t.replace(/'/g, "'\\''") + "'";
            const cmd = (projectRoot ? `cd ${quote(projectRoot)} && ` : "") + `${RESUME[conv.provider]} ${conv.sessionId}`;
            const label = providers.find((p) => p.id === conv.provider)?.label ?? "the agent";
            try {
              await Promise.race([navigator.clipboard.writeText(cmd), new Promise((_, no) => setTimeout(no, 1000))]);
              showNote(`Copied. Paste it in a terminal to continue this chat in ${label}: ${cmd}`);
            } catch {
              showNote(`Run this in a terminal to continue this chat in ${label}: ${cmd}`);
            }
          }}
        >
          <Icon name="terminal" />
        </button>
        <div className="cc-menu" hidden={menu !== "convs"} role="menu" aria-label="Chats">
          {!convs.length ? (
            <div className="cc-hint">No saved chats yet</div>
          ) : (
            convs.map((c) => {
              const running = c.id === activeId && busy;
              return (
                <div key={c.id} className={`cc-row${c.id === conv?.id ? " on" : ""}`} data-id={c.id}>
                  <button
                    type="button"
                    className="cc-open"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      openChat(c.id);
                    }}
                  >
                    {(running ? "● " : "") + c.title}
                  </button>
                  <button
                    type="button"
                    className={`cc-trash${armed === c.id ? " armed" : ""}`}
                    aria-label={armed === c.id ? "Click again to delete " + c.title : "Delete " + c.title}
                    title={running ? "Stop the agent before deleting this chat" : "Delete this chat (cdesign's saved copy only)"}
                    disabled={running}
                    onClick={() => armDelete(c)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="cc-meta">
        <div className="cc-status" role="status" data-state={statusKey}>
          {STATUS[statusKey]}
        </div>
        <select
          className={`cc-badge${curSettings.fullAccess ? " full" : ""}`}
          aria-label="Access mode"
          value={curSettings.fullAccess ? "full" : "normal"}
          title={MODE_HELP[curSettings.fullAccess ? "full" : "normal"]}
          disabled={busy || posting}
          onChange={async (e) => {
            const want = e.target.value === "full";
            if (!conv) {
              setFresh((f) => ({ ...f, fullAccess: want }));
              return;
            }
            const res = await post("/settings", { fullAccess: want, conversationId: conv.id }).catch(() => null);
            if (res?.ok) {
              setConv((prev) => (prev ? { ...prev, fullAccess: want } : prev));
              refreshNote();
            } else {
              showNote(res ? (await res.json().catch(() => ({}))).error || "Could not change the access mode" : "Could not reach cdesign", true);
            }
          }}
        >
          <option value="full">Full access</option>
          <option value="normal">Normal</option>
        </select>
      </div>

      <div
        className={`cc-note${note.err ? " err" : ""}`}
        hidden={!note.text}
        role="status"
        data-go={note.go}
        onClick={() => note.go && openChat(note.go)}
      >
        {note.text}
      </div>

      <div className="cc-logwrap">
        <div
          className="cc-log"
          ref={logRef}
          aria-live="polite"
          tabIndex={0}
          aria-label="Conversation"
          onScroll={() => {
            const el = logRef.current;
            if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
        >
          {!conv?.items.length ? (
            <div className="cc-empty">
              Ask the agent to change this design. Your project&apos;s files are edited directly and the preview reloads.
            </div>
          ) : (
            visibleItems.map((it) => {
              const live = it.kind === "message" && busy && conv.items.at(-1)?.id === it.id;
              return (
                <div
                  key={it.id}
                  className={`cc-msg ${it.kind}${live ? " live" : ""}`}
                  data-status={it.kind === "notice" ? it.status || "" : undefined}
                >
                  {it.kind === "message" ? <Markdown text={it.text || ""} /> : it.text || ""}
                </div>
              );
            })
          )}
          {(conv?.approvals ?? []).map((a) => {
            const answered = answeredApprovals.has(a.id);
            const answer = async (decision: "allow" | "deny") => {
              setAnsweredApprovals((prev) => new Set(prev).add(a.id));
              const res = await post("/approve", {
                conversationId: conv?.id,
                turnId: conv?.turnId,
                approvalId: a.id,
                decision,
              }).catch(() => null);
              if (!res) showNote("Could not reach cdesign", true);
              else if (!res.ok) showNote((await res.json().catch(() => ({}))).error || "Could not answer", true);
            };
            return (
              <div key={a.id} className="cc-approval" role="group" aria-label="Approval needed">
                <b>Approval needed: {a.tool}</b>
                <pre>{a.detail}</pre>
                {a.reason && <small>{a.reason}</small>}
                <div>
                  <button type="button" disabled={answered} onClick={() => answer("deny")}>
                    Deny
                  </button>
                  <button type="button" className="go" disabled={answered} onClick={() => answer("allow")}>
                    Allow once
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="cc-jump"
          hidden={atBottom}
          title="Scroll to the newest message"
          onClick={() => {
            if (logRef.current) {
              logRef.current.scrollTop = logRef.current.scrollHeight;
              logRef.current.focus();
            }
            setAtBottom(true);
          }}
        >
          ↓ Latest
        </button>
      </div>

      <div className="cc-chips" aria-label="Context sent with your message" hidden={!chipList.length && !visibleCommentChips.length}>
        {chipList.map((x) => (
          <span
            key={x.k}
            className={`cc-chip ${x.c.state}`}
            data-type={x.type}
            title={x.c.state !== "ok" ? "This is not sent: " + (WHY[x.c.state] || x.c.state) : undefined}
          >
            <em>{x.type === "page" ? "Page" : "Element"}</em>
            <span>{x.label}</span>
            {x.c.state !== "ok" && <i>{WHY[x.c.state] || x.c.state}</i>}
            <button
              type="button"
              aria-label={"Remove " + x.label + " from this message"}
              onClick={() => setDismissed((prev) => new Set(prev).add(x.k))}
            >
              ×
            </button>
          </span>
        ))}
        {visibleCommentChips.map((c) => {
          const label = `${c.file} ${c.cdId}: ${c.text.length > 40 ? c.text.slice(0, 39) + "…" : c.text}`;
          return (
            <span key={c.id} className="cc-chip ok" data-type="comment">
              <em>Comment</em>
              <span>{label}</span>
              <button
                type="button"
                aria-label={"Remove " + label + " from this message"}
                onClick={() => setDismissed((prev) => new Set(prev).add("c:" + c.id))}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>

      <div className="cc-form">
        <textarea
          ref={boxRef}
          placeholder="Ask the agent to change this design… (/ for commands and skills)"
          aria-label="Message"
          title="Enter to send, Shift+Enter for a new line"
          aria-controls="cc-slash"
          aria-autocomplete="list"
          aria-expanded={slashRows.length > 0}
          aria-activedescendant={slashRows.length ? "cc-cmd-" + safeSlashAt : undefined}
          onInput={(e) => {
            const v = e.currentTarget.value;
            setDraftText(v);
            setSlashAt(0);
            if (/^\/[^\s]*$/.test(v)) {
              setSlashOpen(true);
              const hit = cmdCacheRef.current.get(activeProvider);
              if (!hit || Date.now() - hit.at >= 60000) loadCommands(activeProvider);
            } else {
              setSlashOpen(false);
            }
          }}
          onBlur={() => setTimeout(() => setSlashOpen(false), 120)}
          onKeyDown={(e) => {
            if (slashRows.length && !e.nativeEvent.isComposing) {
              const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
              if (step) {
                e.preventDefault();
                setSlashAt((safeSlashAt + step + slashRows.length) % slashRows.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashOpen(false);
                return;
              }
              if (
                e.key === "Tab" ||
                (e.key === "Enter" && !e.shiftKey && slashRows[safeSlashAt].name.toLowerCase() !== slashQuery)
              ) {
                e.preventDefault();
                chooseSlash(slashRows[safeSlashAt]);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              setSlashOpen(false);
              send();
            }
          }}
        />
        <div className="cc-tools">
          <button
            ref={pickBtnRef}
            type="button"
            className="cc-pick"
            aria-haspopup="listbox"
            aria-expanded={menu === "picker"}
            aria-label={"Model and effort: " + pickNameText + (curSettings.effort ? ", " + curSettings.effort : "")}
            title={pickDisabled ? "Model and effort change between turns; wait for the agent or Stop it" : caps.note}
            disabled={pickDisabled}
            onClick={() => setMenu((m) => (m === "picker" ? null : "picker"))}
          >
            <span className="cc-pick-name">{pickNameText}</span>
            <span className="cc-pick-effort">{pickEffortText}</span>
          </button>
          <button type="button" className="cc-send stop" aria-label="Stop" title="Stop" hidden={!mine} onClick={stop}>
            <Icon name="stop" />
          </button>
          <button
            type="button"
            className="go cc-send"
            aria-label="Send"
            title="Send (Enter)"
            disabled={busy || posting || !isReady || !(draftText.trim() || visibleCommentChips.length)}
            onClick={send}
          >
            <Icon name="up" />
          </button>
        </div>

        <div className="cc-menu cc-pmenu" hidden={menu !== "picker" || pickDisabled}>
          {providers.map((p) => {
            const c = p.capabilities ?? NONE_CAPS;
            const ok = p.state === "ready";
            const rows: [string, string][] = [
              ["", c.models.length ? c.defaultLabel : c.defaultLabel + " (models not listed)"],
              ...c.models.map((m): [string, string] => [m.id, m.label]),
            ];
            if (activeProvider === p.id && curSettings.model && !c.models.some((m) => m.id === curSettings.model)) {
              rows.push([curSettings.model, curSettings.model + " (not offered now)"]);
            }
            return (
              <Fragment key={p.id}>
                <div className="cc-grp">{p.label}</div>
                {!ok && <div className="cc-hint">{p.message || PROV_STATE[p.state] || "unavailable"}</div>}
                {rows.map(([id, label]) => {
                  const on = activeProvider === p.id && (curSettings.model ?? "") === id;
                  return (
                    <button
                      key={p.id + ":" + id}
                      type="button"
                      className={`cc-opt${on ? " on" : ""}`}
                      role="option"
                      aria-selected={on}
                      disabled={!ok}
                      onClick={() => {
                        setMenu(null);
                        chooseModel(p.id, id);
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
          <div className="cc-grp">Effort</div>
          {(() => {
            const efforts = effortsFor(caps, curSettings.model);
            if (!efforts.length) {
              return (
                <div className="cc-hint">
                  This agent did not list reasoning efforts for this model, so only its default can be used.
                </div>
              );
            }
            return (
              <div className="cc-efforts">
                {["", ...efforts].map((e) => {
                  const on = (curSettings.effort ?? "") === e;
                  return (
                    <button
                      key={e || "__default"}
                      type="button"
                      aria-pressed={on}
                      className={on ? "on" : undefined}
                      onClick={() => {
                        setMenu(null);
                        chooseSetting({ effort: e || null });
                      }}
                    >
                      {e ? cap(e) : "Default"}
                    </button>
                  );
                })}
                {curSettings.effort && !efforts.includes(curSettings.effort) && (
                  <span className="cc-hint">{cap(curSettings.effort)} (not supported)</span>
                )}
              </div>
            );
          })()}
        </div>

        <div
          id="cc-slash"
          ref={smenuRef}
          className="cc-menu cc-smenu"
          hidden={!slashRows.length}
          role="listbox"
          aria-label="Commands and skills"
        >
          {slashRows.map((c, k) => (
            <button
              key={c.name}
              id={"cc-cmd-" + k}
              type="button"
              className={`cc-opt cc-cmd${k === safeSlashAt ? " on" : ""}`}
              role="option"
              aria-selected={k === safeSlashAt}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => chooseSlash(c)}
            >
              <span className="cc-cmd-top">
                <b>/{c.name}</b>
                {c.hint && <i>{c.hint}</i>}
                {c.local && <em>built-in</em>}
              </span>
              {c.description && <small>{c.description}</small>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
