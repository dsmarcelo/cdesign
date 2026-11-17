// Desktop chat pane: all agent text is inserted with textContent, never as HTML. Private events come from /__cd/chat/events, not the preview stream.
(() => {
  const $ = (s) => document.querySelector(s);
  const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; } };
  const lside = $("#lside"), root = $("#chat");
  const api = (p, o) => fetch("/__cd/chat" + p, o);
  const post = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // ---- sidebar: tabs (both panels stay in the DOM, so state survives switching), resize ----
  const tab = (name) => {
    lside.dataset.tab = name;
    for (const n of ["chat", "files"]) $("#tab-" + n).setAttribute("aria-selected", String(n === name));
    store("cd-ltab", name);
  };
  $("#tab-chat").onclick = () => tab("chat");
  $("#tab-files").onclick = () => tab("files");
  tab(store("cd-ltab") === "files" ? "files" : "chat");
  const width = (w) => document.body.style.setProperty("--lw", Math.round(Math.min(Math.max(w, 200), Math.max(260, innerWidth - 500))) + "px");
  width(+store("cd-lw") || 340);
  $("#lrs").onpointerdown = (e) => {
    e.preventDefault();
    const left = lside.getBoundingClientRect().left;
    document.body.classList.add("drag");
    const move = (m) => width(m.clientX - left);
    const up = () => {
      document.body.classList.remove("drag");
      removeEventListener("pointermove", move); removeEventListener("pointerup", up);
      store("cd-lw", parseInt(document.body.style.getPropertyValue("--lw")));
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };

  // ---- chat DOM ----
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const sel = el("select"); sel.title = "Agent";
  sel.setAttribute("aria-label", "Agent");
  const badge = el("select", "cc-badge full"); badge.setAttribute("aria-label", "Access mode");
  for (const [v, t] of [["full", "Full access"], ["normal", "Normal"]]) { const o = el("option", "", t); o.value = v; badge.append(o); }
  const MODE_HELP = {
    full: "Full access: the agent can read, write and run commands in this project without asking. Provider or managed restrictions may still apply.",
    normal: "Normal: the agent works in the project sandbox with your provider's permission rules; actions that need approval pause here for Allow once or Deny.",
  };
  const showMode = (full) => { badge.value = full ? "full" : "normal"; badge.classList.toggle("full", full); badge.title = MODE_HELP[badge.value]; };
  showMode(true);
  const top = el("div", "cc-top"); top.append(sel, badge);
  const bar = el("div", "cc-convs");
  const csel = el("select"); csel.setAttribute("aria-label", "Conversation");
  const rin = el("input"); rin.hidden = true; rin.maxLength = 80; rin.setAttribute("aria-label", "Chat name");
  const newBtn = el("button", "", "New"), renBtn = el("button", "", "Rename"), delBtn = el("button", "", "Delete");
  newBtn.title = "Start a new chat"; renBtn.title = "Rename this chat"; delBtn.title = "Delete this chat (cdesign's saved copy only)";
  bar.append(csel, rin, newBtn, renBtn, delBtn);
  const note = el("div", "cc-note"); note.hidden = true; note.setAttribute("role", "status");
  const log = el("div", "cc-log"); log.setAttribute("aria-live", "polite");
  const box = el("textarea"); box.placeholder = "Ask the agent to change this design…"; box.setAttribute("aria-label", "Message");
  const hint = el("small", "", "Enter to send, Shift+Enter for a new line");
  const sendBtn = el("button", "go", "Send"), stopBtn = el("button", "", "Stop"); stopBtn.hidden = true;
  const form = el("div", "cc-form"); const row = el("div"); row.append(hint, stopBtn, sendBtn); form.append(box, row);
  root.append(top, bar, note, log, form);

  // `conv` is the chat on screen (null = a new chat that is not saved until its first message); `busy` is project-wide, `activeId` the chat that owns the running turn
  let providers = [], conv = null, convs = [], activeId = null, busy = false, seq = 0, epoch = "", es = null, posting = false, full = true, draft = false;
  const ready = () => providers.find((p) => p.id === sel.value)?.state === "ready";
  const showNote = (text, err, go) => { note.hidden = !text; note.textContent = text || ""; note.classList.toggle("err", !!err); if (go) note.dataset.go = go; else delete note.dataset.go; };
  note.onclick = () => { if (note.dataset.go) open(note.dataset.go); };
  const mine = () => !!conv && busy && activeId === conv.id; // this chat owns the running turn
  const sync = () => {
    sendBtn.disabled = busy || posting || !ready() || !box.value.trim();
    badge.disabled = busy || posting; // the mode applies between turns
    stopBtn.hidden = !mine();
    renBtn.disabled = !conv;
    delBtn.disabled = !conv || mine();
    sel.disabled = !!conv; // a chat keeps its agent
    box.disabled = false;
  };
  const refreshNote = () => {
    if (busy && activeId && activeId !== conv?.id) return showNote(`The agent is working in "${convs.find((c) => c.id === activeId)?.title ?? "another chat"}". Click to open it, where you can Stop it or answer requests.`, false, activeId);
    if (conv?.error && !busy) return showNote(conv.error, true);
    const p = providers.find((x) => x.id === sel.value);
    showNote(!conv && p && p.state !== "ready" ? p.message : "", true);
  };
  const drawList = () => {
    csel.replaceChildren(...[["", "New chat"], ...convs.map((c) => [c.id, (c.id === activeId && busy ? "● " : "") + c.title])].map(([v, t]) => { const o = el("option", "", t); o.value = v; return o; }));
    csel.value = conv?.id ?? "";
  };
  const nodes = new Map();
  const draw = (it) => {
    let n = nodes.get(it.id);
    if (!n) {
      if (it.kind === "command" || it.kind === "file" || it.kind === "tool") {
        n = el("details", "cc-tool"); const s = el("summary"); s.append(el("span"), el("i")); n.append(s, el("pre"));
      } else n = el("div", "cc-msg " + it.kind);
      nodes.set(it.id, n); log.append(n);
    }
    if (n.tagName === "DETAILS") {
      n.querySelector("span").textContent = it.title || it.kind;
      n.querySelector("i").textContent = it.status && it.status !== "completed" ? it.status : "";
      n.querySelector("pre").textContent = it.output || "(no output)";
    } else {
      n.textContent = it.text || "";
      n.classList.toggle("live", it.kind === "message" && busy && conv?.items.at(-1) === it);
    }
    return n;
  };
  const cards = new Map();
  const drawApproval = (a) => {
    if (cards.has(a.id)) return;
    const c = el("div", "cc-approval"); c.setAttribute("role", "group"); c.setAttribute("aria-label", "Approval needed");
    const h = el("b", "", "Approval needed: " + a.tool);
    const d = el("pre", "", a.detail);
    const r = a.reason ? el("small", "", a.reason) : null;
    const allow = el("button", "go", "Allow once"), deny = el("button", "", "Deny");
    const answer = async (decision) => {
      allow.disabled = deny.disabled = true;
      const res = await post("/approve", { conversationId: conv?.id, turnId: conv?.turnId, approvalId: a.id, decision }).catch(() => null);
      if (!res) showNote("Could not reach cdesign", true);
      else if (!res.ok) showNote((await res.json().catch(() => ({}))).error || "Could not answer", true);
    };
    allow.onclick = () => answer("allow"); deny.onclick = () => answer("deny");
    const row = el("div"); row.append(deny, allow);
    c.append(h, d, ...(r ? [r] : []), row);
    cards.set(a.id, c); log.append(c);
  };
  const dropApproval = (id) => { cards.get(id)?.remove(); cards.delete(id); };
  const render = () => {
    log.replaceChildren(); nodes.clear(); cards.clear();
    if (!conv?.items.length) log.append(el("div", "cc-empty", "Ask the agent to change this design. Your project's files are edited directly and the preview reloads."));
    else for (const it of conv.items) draw(it);
    for (const a of conv?.approvals || []) drawApproval(a);
    log.scrollTop = log.scrollHeight;
  };
  const stick = (fn) => { const at = log.scrollHeight - log.scrollTop - log.clientHeight < 40; fn(); if (at) log.scrollTop = log.scrollHeight; };
  const find = (id) => conv?.items.find((i) => i.id === id);
  // mirrors apply() in src/chat.ts
  const reduce = (ev) => {
    if (ev.cid && ev.cid !== conv?.id && !["turn.begin", "turn.completed"].includes(ev.type)) return; // belongs to a chat that is not on screen
    switch (ev.type) {
      case "turn.begin":
        busy = true; activeId = ev.conversation.id;
        if (conv?.id !== ev.conversation.id) {
          if (!(draft && posting)) { drawList(); break; } // another tab started a turn in a chat that is not on screen
          draft = false; conv = { ...ev.conversation, items: [], approvals: [], error: null }; store("cd-conv", conv.id); render();
        }
        conv.turnId = null; conv.approvals = []; conv.fullAccess = ev.conversation.fullAccess; showNote("");
        for (const id of [...cards.keys()]) dropApproval(id);
        conv.items.push({ id: ev.itemId, kind: "user", text: ev.text });
        if (log.querySelector(".cc-empty")) log.replaceChildren();
        stick(() => draw(conv.items.at(-1)));
        break;
      case "turn.started": if (conv) conv.turnId = ev.turnId; break;
      case "item.started": if (conv && !find(ev.item.id)) { conv.items.push({ ...ev.item }); stick(() => draw(conv.items.at(-1))); } break;
      case "item.delta": {
        const it = find(ev.itemId); if (!it) break;
        if (it.kind === "message") it.text = (it.text || "") + ev.text; else it.output = (it.output || "") + ev.text;
        stick(() => draw(it)); break;
      }
      case "item.completed": {
        const it = find(ev.item.id);
        if (!it) { conv?.items.push({ ...ev.item }); stick(() => draw(conv.items.at(-1))); break; }
        Object.assign(it, ev.item, it.kind === "message" ? (ev.item.text ? {} : { text: it.text }) : (ev.item.output ? {} : { output: it.output }));
        draw(it); break;
      }
      case "approval.requested":
        if (conv && !conv.approvals.some((a) => a.id === ev.approval.id)) { conv.approvals.push({ ...ev.approval }); stick(() => drawApproval(ev.approval)); }
        break;
      case "approval.resolved":
        if (conv) conv.approvals = conv.approvals.filter((a) => a.id !== ev.id);
        dropApproval(ev.id); break;
      case "list": load().catch(() => {}); break;
      case "settings":
        if (!ev.conversationId) full = ev.fullAccess;
        else if (conv?.id === ev.conversationId) conv.fullAccess = ev.fullAccess;
        showMode(conv ? conv.fullAccess : full); break;
      case "turn.completed":
        busy = false; activeId = null; if (conv && ev.cid === conv.id) { conv.turnId = null; conv.approvals = []; }
        refreshList();
        if (ev.cid !== conv?.id) { refreshNote(); break; }
        for (const id of [...cards.keys()]) dropApproval(id);
        for (const it of conv?.items || []) if (it.status === "inProgress") { it.status = ev.status === "completed" ? "completed" : ev.status; draw(it); }
        for (const n of log.querySelectorAll(".live")) n.classList.remove("live");
        if (ev.status === "failed") showNote(ev.error || "The turn failed", true);
        else if (ev.status === "interrupted") showNote("Stopped. What the agent said so far is kept.");
        break;
    }
    sync();
  };
  const refreshList = async () => {
    try { const s = await (await api("?c=" + encodeURIComponent(conv?.id ?? ""))).json(); convs = s.conversations; drawList(); } catch { /* the next event or reload fixes the list */ }
  };
  const load = async (cid) => {
    const s = await (await api("?c=" + encodeURIComponent(draft ? "" : cid ?? conv?.id ?? store("cd-conv") ?? ""))).json();
    convs = s.conversations; activeId = s.activeId; busy = s.busy; seq = s.seq; epoch = s.epoch; full = s.fullAccess !== false;
    conv = draft ? null : s.conversation;
    if (conv) store("cd-conv", conv.id);
    if (conv) { const p = conv.provider; if (![...sel.options].some((o) => o.value === p)) { const o = el("option", "", p); o.value = p; sel.append(o); } sel.value = p; }
    showMode(conv ? conv.fullAccess : full);
    render(); drawList(); refreshNote(); sync();
  };
  const open = (id) => { draft = false; return load(id).catch(() => showNote("Could not open that chat", true)); };
  const connect = () => {
    es?.close();
    es = new EventSource(`/__cd/chat/events?after=${seq}&epoch=${encodeURIComponent(epoch)}`);
    es.onmessage = async (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === "reset") { await load().catch(() => {}); connect(); return; } // our position is gone (or belongs to an earlier daemon run): start from a fresh snapshot
      if (ev.seq <= seq) return; // already part of the snapshot
      seq = ev.seq; reduce(ev);
    };
  };
  const newChat = () => { draft = true; conv = null; render(); drawList(); showMode(full); refreshNote(); sync(); box.focus(); };
  newBtn.onclick = newChat;
  csel.onchange = () => (csel.value ? open(csel.value) : newChat());
  const endRename = () => { rin.hidden = true; csel.hidden = false; };
  renBtn.onclick = () => { if (!conv) return; rin.value = conv.title; csel.hidden = true; rin.hidden = false; rin.focus(); rin.select(); };
  rin.onblur = endRename;
  rin.onkeydown = async (e) => {
    if (e.key === "Escape") return endRename();
    if (e.key !== "Enter" || !conv) return;
    const r = await post("/rename", { conversationId: conv.id, title: rin.value }).catch(() => null);
    if (r?.ok) { endRename(); await load().catch(() => {}); }
    else showNote(r ? (await r.json().catch(() => ({}))).error || "Could not rename" : "Could not reach cdesign", true);
  };
  let armed = 0;
  delBtn.onclick = async () => { // two clicks: the first arms, so a stray click never deletes
    if (!conv || mine()) return;
    if (!armed) { delBtn.textContent = "Sure?"; armed = setTimeout(() => { armed = 0; delBtn.textContent = "Delete"; }, 3000); return; }
    clearTimeout(armed); armed = 0; delBtn.textContent = "Delete";
    const r = await post("/delete", { conversationId: conv.id }).catch(() => null);
    if (r?.ok) { draft = false; conv = null; store("cd-conv", ""); await load().catch(() => {}); }
    else showNote(r ? (await r.json().catch(() => ({}))).error || "Could not delete" : "Could not reach cdesign", true);
  };

  const send = async () => {
    const text = box.value.trim();
    if (!text || busy || posting || !ready()) return;
    posting = true; sync();
    try {
      const r = await post("/send", { text, provider: sel.value, conversationId: conv?.id });
      if (r.ok) {
        box.value = "";
        const { conversationId } = await r.json().catch(() => ({}));
        if (draft && conversationId) { draft = false; await load(conversationId).catch(() => {}); } // the response can beat the first stream event
      } else { const j = await r.json().catch(() => ({})); showNote(j.error || "Could not send", true, j.activeConversationId); }
    } catch { showNote("Could not reach cdesign", true); }
    posting = false; sync();
  };
  const stop = () => post("/stop", { conversationId: conv?.id, turnId: conv?.turnId }).then(async (r) => { if (!r.ok) showNote((await r.json().catch(() => ({}))).error || "Could not stop", true); });
  sendBtn.onclick = send; stopBtn.onclick = stop;
  box.oninput = sync;
  box.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };

  badge.onchange = async () => {
    const want = badge.value === "full";
    const res = await post("/settings", { fullAccess: want, conversationId: conv?.id }).catch(() => null);
    if (res?.ok) { if (conv) conv.fullAccess = want; full = want; showMode(want); refreshNote(); }
    else { showMode(conv ? conv.fullAccess : full); showNote(res ? (await res.json().catch(() => ({}))).error || "Could not change the access mode" : "Could not reach cdesign", true); }
  };

  const STATE = { missing: "not installed", login: "not logged in", unsupported: "update needed", error: "error" };
  const discover = async () => {
    try {
      providers = (await (await api("/providers")).json()).providers;
    } catch { providers = []; showNote("Could not look for installed agents", true); }
    sel.replaceChildren(...providers.map((p) => { const o = el("option", "", p.label + (p.state === "ready" ? "" : ` (${STATE[p.state] || "unavailable"})`)); o.title = p.message; o.value = p.id; return o; }));
    const p = providers.find((x) => x.id === sel.value) || providers[0];
    if (conv) sel.value = conv.provider;
    refreshNote(); sync();
  };
  sel.onchange = () => { refreshNote(); sync(); };
  (async () => { await load().catch(() => showNote("Could not load the chat", true)); await discover(); connect(); })();
})();
