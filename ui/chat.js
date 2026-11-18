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
  // Agent text is untrusted: it is parsed into DOM nodes with textContent only (no innerHTML), so markup in it can never run.
  // Links are kept only for http(s)/mailto; anything else (javascript:, data:...) is shown as plain text.
  const safeHref = (u) => { try { const x = new URL(u); return /^(https?:|mailto:)$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const inline = (parent, text) => {
    const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    let at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) parent.append(text.slice(at, m.index));
      if (m[1] !== undefined) parent.append(el("code", "", m[1]));
      else if (m[2] !== undefined) parent.append(el("strong", "", m[2]));
      else {
        const href = safeHref(m[4]);
        if (href) { const a = el("a", "", m[3]); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer nofollow"; parent.append(a); }
        else parent.append(m[3] + " (" + m[4] + ")");
      }
      at = m.index + m[0].length;
    }
    if (at < text.length) parent.append(text.slice(at));
  };
  /** Paragraphs, bullet/numbered lists and fenced code. An unclosed fence (still streaming) renders as code so far. */
  const markdown = (box, text) => {
    const out = [], lines = text.split("\n");
    for (let i = 0; i < lines.length;) {
      const line = lines[i], fence = line.match(/^\s*```/);
      if (fence) {
        const code = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        const pre = el("pre", "cc-code"); pre.tabIndex = 0; pre.append(el("code", "", code.join("\n"))); out.push(pre);
      } else if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d/.test(line), list = el(ordered ? "ol" : "ul");
        while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { const li = el("li"); inline(li, lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "")); list.append(li); i++; }
        out.push(list);
      } else if (!line.trim()) i++;
      else {
        const p = el("p");
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
        para.forEach((l, k) => { if (k) p.append(el("br")); inline(p, l); });
        out.push(p);
      }
    }
    box.replaceChildren(...out);
  };
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
  const msel = el("select"); msel.setAttribute("aria-label", "Model");
  const esel = el("select"); esel.setAttribute("aria-label", "Reasoning effort");
  const top = el("div", "cc-top"); top.append(sel, badge);
  const tune = el("div", "cc-top cc-tune"); tune.append(msel, esel);
  const bar = el("div", "cc-convs");
  const csel = el("select"); csel.setAttribute("aria-label", "Conversation");
  const rin = el("input"); rin.hidden = true; rin.maxLength = 80; rin.setAttribute("aria-label", "Chat name");
  const newBtn = el("button", "", "New"), renBtn = el("button", "", "Rename"), delBtn = el("button", "", "Delete");
  newBtn.title = "Start a new chat"; renBtn.title = "Rename this chat"; delBtn.title = "Delete this chat (cdesign's saved copy only)";
  bar.append(csel, rin, newBtn, renBtn, delBtn);
  const status = el("div", "cc-status"); status.setAttribute("role", "status");
  const note = el("div", "cc-note"); note.hidden = true; note.setAttribute("role", "status");
  const log = el("div", "cc-log"); log.setAttribute("aria-live", "polite"); log.tabIndex = 0; log.setAttribute("aria-label", "Conversation");
  const jump = el("button", "cc-jump", "↓ Latest"); jump.hidden = true; jump.title = "Scroll to the newest message";
  const wrap = el("div", "cc-logwrap"); wrap.append(log, jump);
  const box = el("textarea"); box.placeholder = "Ask the agent to change this design…"; box.setAttribute("aria-label", "Message");
  const hint = el("small", "", "Enter to send, Shift+Enter for a new line");
  const sendBtn = el("button", "go", "Send"), stopBtn = el("button", "", "Stop"); stopBtn.hidden = true;
  const form = el("div", "cc-form"); const row = el("div"); row.append(hint, stopBtn, sendBtn); form.append(box, row);
  const chipsBox = el("div", "cc-chips"); chipsBox.setAttribute("aria-label", "Context sent with your message");
  root.append(top, tune, bar, status, note, wrap, chipsBox, form);

  // ---- design context: the open page and selected element of THIS tab (refreshed from the server), plus comments added explicitly ----
  // A chip the user removed stays removed only for that page/element; a changed page or selection brings its automatic chip back for the next message.
  let auto = { page: null, selection: null }; const dismissed = new Set(); const added = new Map();
  const keyOf = { page: (c) => "page:" + c.file, selection: (c) => "el:" + c.file + ":" + c.cdId };
  const WHY = { missing: "file no longer exists", stale: "element no longer exists" };
  const chipList = () => [
    ...(auto.page ? [{ k: keyOf.page(auto.page), type: "page", label: auto.page.file, c: auto.page }] : []),
    ...(auto.selection ? [{ k: keyOf.selection(auto.selection), type: "selection", label: `${auto.selection.file} ${auto.selection.cdId}${auto.selection.tag ? " <" + auto.selection.tag + ">" : ""}`, c: auto.selection }] : []),
  ].filter((x) => !dismissed.has(x.k));
  const drawChips = () => {
    const nodes = [];
    for (const x of chipList()) nodes.push(chip(x.type, x.label, x.c.state, () => { dismissed.add(x.k); drawChips(); }));
    for (const [id, c] of added) nodes.push(chip("comment", `${c.file} ${c.cdId}: ${c.text.length > 40 ? c.text.slice(0, 39) + "…" : c.text}`, "ok", () => { added.delete(id); drawChips(); }));
    chipsBox.replaceChildren(...nodes); chipsBox.hidden = !nodes.length;
  };
  const chip = (type, label, state, remove) => {
    const n = el("span", "cc-chip " + state); n.dataset.type = type;
    n.append(el("em", "", type === "page" ? "Page" : type === "selection" ? "Element" : "Comment"), el("span", "", label));
    if (state !== "ok") { n.append(el("i", "", WHY[state] || state)); n.title = "This is not sent: " + (WHY[state] || state); }
    const x = el("button", "", "×"); x.type = "button"; x.setAttribute("aria-label", "Remove " + label + " from this message"); x.onclick = remove;
    n.append(x); return n;
  };
  /** The context to submit now: the chips that are visible and valid at this moment. */
  const snapshotContext = () => {
    const out = {};
    for (const x of chipList()) if (x.c.state === "ok") out[x.type] = x.type === "page" ? { file: x.c.file } : { file: x.c.file, cdId: x.c.cdId, selector: x.c.selector, tag: x.c.tag };
    if (added.size) out.comments = [...added.keys()];
    return Object.keys(out).length ? out : undefined;
  };
  const refreshContext = async () => {
    if (document.hidden || lside.dataset.tab !== "chat") return;
    try {
      const r = await fetch("/__cd/chat/context?tab=" + encodeURIComponent(tabId));
      if (!r.ok) return;
      const next = await r.json();
      if (JSON.stringify(next) !== JSON.stringify(auto)) { auto = next; drawChips(); }
    } catch { /* the next poll retries */ }
  };
  setInterval(refreshContext, 1000);
  addEventListener("cd-add-comment", (e) => { const c = e.detail; if (c?.id) { added.set(c.id, c); tab("chat"); drawChips(); box.focus(); } });
  drawChips();

  // `conv` is the chat on screen (null = a new chat that is not saved until its first message); `busy` is project-wide, `activeId` the chat that owns the running turn
  let providers = [], conv = null, convs = [], activeId = null, busy = false, seq = 0, epoch = "", es = null, posting = false, full = true, draft = false;
  // what a new (unsaved) chat will be created with; a saved chat uses its own fields
  const fresh = { fullAccess: true, model: null, effort: null };
  let renderedId = null;
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
    msel.disabled = esel.disabled = busy || posting || msel.options.length < 2 && esel.options.length < 2; // settings apply between turns
    if (busy || posting) { msel.title = esel.title = "Model and effort change between turns; wait for the agent or Stop it"; }
    else fillTitles();
    showStatus();
  };
  const caps = () => providers.find((p) => p.id === (conv?.provider ?? sel.value))?.capabilities ?? { source: "fallback", note: "", models: [], efforts: [], defaultLabel: "Default" };
  const cur = () => conv ?? fresh;
  const effortsFor = (c, model) => (model ? c.models.find((m) => m.id === model)?.efforts ?? c.efforts : c.efforts);
  const fillTitles = () => {
    const c = caps();
    msel.title = c.models.length ? c.note : "This agent did not list its models, so only its default can be used. " + c.note;
    esel.title = effortsFor(c, cur().model).length ? "Reasoning effort for the next turn" : "This agent did not list reasoning efforts for this model, so only its default can be used.";
  };
  /** Rebuilds the model/effort selectors from the agent's reported capabilities and the chat's saved values. */
  const fillSettings = () => {
    const c = caps(), s = cur();
    const opt = (v, t) => { const o = el("option", "", t); o.value = v; return o; };
    const models = [opt("", c.models.length ? c.defaultLabel : c.defaultLabel + " (models not listed)"), ...c.models.map((m) => opt(m.id, m.label))];
    if (s.model && !c.models.some((m) => m.id === s.model)) models.push(opt(s.model, s.model + " (not offered now)"));
    msel.replaceChildren(...models); msel.value = s.model ?? "";
    const efforts = effortsFor(c, s.model);
    const list = [opt("", efforts.length ? "Default effort" : "Default effort (not listed)"), ...efforts.map((e) => opt(e, e))];
    if (s.effort && !efforts.includes(s.effort)) list.push(opt(s.effort, s.effort + " (not supported)"));
    esel.replaceChildren(...list); esel.value = s.effort ?? "";
  };
  const STATUS = { empty: "New chat: nothing sent yet", starting: "Starting the agent…", approval: "Waiting for your approval", streaming: "Working…", other: "Working in another chat", completed: "Done", stopped: "Stopped", interrupted: "Interrupted", failed: "Failed", idle: "Ready" };
  /** One word for where this chat stands, kept apart from the explanatory note below it. */
  const showStatus = () => {
    let k;
    if (busy && mine()) k = conv.approvals?.length ? "approval" : !conv.turnId ? "starting" : "streaming";
    else if (busy) k = "other";
    else if (!conv || !conv.items.length) k = "empty";
    else if (conv.last === "failed") k = "failed";
    else if (conv.last === "interrupted") k = conv.error?.startsWith("Interrupted") ? "interrupted" : "stopped";
    else k = conv.last === "completed" ? "completed" : "idle";
    status.dataset.state = k; status.textContent = STATUS[k];
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
    if (it.kind !== "user" && it.kind !== "message") return;
    let n = nodes.get(it.id);
    if (!n) {
      n = el("div", "cc-msg " + it.kind);
      nodes.set(it.id, n); log.append(n);
    }
    if (it.kind === "message") markdown(n, it.text || ""); else n.textContent = it.text || "";
    n.classList.toggle("live", it.kind === "message" && busy && conv?.items.at(-1) === it);
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
  const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const render = () => {
    // reloading the chat already on screen (a list change, a reconnect) must not drag someone who is reading older output back down
    const keep = renderedId === conv?.id && !atEnd() ? log.scrollTop : null;
    renderedId = conv?.id ?? null;
    log.replaceChildren(); nodes.clear(); cards.clear();
    if (!conv?.items.length) log.append(el("div", "cc-empty", "Ask the agent to change this design. Your project's files are edited directly and the preview reloads."));
    else for (const it of conv.items) draw(it);
    for (const a of conv?.approvals || []) drawApproval(a);
    log.scrollTop = keep ?? log.scrollHeight;
    jump.hidden = atEnd();
  };
  // follow new output only while the reader is at the bottom; otherwise leave the position alone and offer a way back
  const stick = (fn) => { const at = atEnd(); fn(); if (at) log.scrollTop = log.scrollHeight; jump.hidden = atEnd(); };
  log.onscroll = () => { jump.hidden = atEnd(); };
  jump.onclick = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; log.focus(); };
  const find = (id) => conv?.items.find((i) => i.id === id);
  // mirrors apply() in src/chat.ts
  const reduce = (ev) => {
    if (ev.cid && ev.cid !== conv?.id && !["turn.begin", "turn.completed"].includes(ev.type)) return; // belongs to a chat that is not on screen
    switch (ev.type) {
      case "turn.begin":
        busy = true; activeId = ev.conversation.id;
        if (conv?.id !== ev.conversation.id) {
          if (!(draft && posting)) { drawList(); break; } // another tab started a turn in a chat that is not on screen
          draft = false; conv = { ...ev.conversation, items: [], approvals: [], error: null, last: null }; store("cd-conv", conv.id); render();
        }
        conv.turnId = null; conv.approvals = []; conv.fullAccess = ev.conversation.fullAccess; conv.model = ev.conversation.model; conv.effort = ev.conversation.effort; fillSettings(); showNote("");
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
        else if (conv?.id === ev.conversationId) { conv.fullAccess = ev.fullAccess; conv.model = ev.model ?? null; conv.effort = ev.effort ?? null; fillSettings(); }
        showMode(cur().fullAccess); break;
      case "turn.completed":
        busy = false; activeId = null; if (conv && ev.cid === conv.id) { conv.turnId = null; conv.approvals = []; conv.last = ev.status; conv.error = ev.status === "failed" ? ev.error ?? "The turn failed" : null; }
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
    showMode(cur().fullAccess);
    fillSettings(); render(); drawList(); refreshNote(); sync();
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
  const newChat = () => { // a new chat always starts on Full access and the agent's defaults, whatever the last chat used
    draft = true; conv = null; Object.assign(fresh, { fullAccess: true, model: null, effort: null });
    render(); drawList(); showMode(true); fillSettings(); refreshNote(); sync(); box.focus();
  };
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
      await refreshContext(); // submit what the viewer shows right now
      const context = snapshotContext();
      const r = await post("/send", conv ? { text, provider: sel.value, conversationId: conv.id, context } : { text, provider: sel.value, fullAccess: fresh.fullAccess, model: fresh.model, effort: fresh.effort, context });
      if (r.ok) {
        box.value = ""; added.clear(); drawChips();
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
    if (!conv) { fresh.fullAccess = want; showMode(want); return; } // an unsaved chat keeps it until its first message
    const res = await post("/settings", { fullAccess: want, conversationId: conv?.id }).catch(() => null);
    if (res?.ok) { conv.fullAccess = want; showMode(want); refreshNote(); }
    else { showMode(cur().fullAccess); showNote(res ? (await res.json().catch(() => ({}))).error || "Could not change the access mode" : "Could not reach cdesign", true); }
  };

  /** Applies a model/effort choice: saved chats persist it right away (the server validates), an unsaved chat just remembers it for its first message. */
  const choose = async (patch) => {
    const c = caps(), s = cur();
    const next = { model: s.model, effort: s.effort, ...patch };
    if (patch.model !== undefined && next.effort && !effortsFor(c, next.model).includes(next.effort)) {
      showNote(`"${next.effort}" effort is not available for ${next.model || "the default model"}, so effort went back to the default.`);
      next.effort = null;
    }
    if (!conv) { Object.assign(fresh, next); fillSettings(); sync(); return; }
    const r = await post("/settings", { conversationId: conv.id, model: next.model, effort: next.effort }).catch(() => null);
    if (r?.ok) { conv.model = next.model; conv.effort = next.effort; }
    else showNote(r ? (await r.json().catch(() => ({}))).error || "Could not change the setting" : "Could not reach cdesign", true);
    fillSettings(); sync();
  };
  msel.onchange = () => choose({ model: msel.value || null });
  esel.onchange = () => choose({ effort: esel.value || null });

  const STATE = { missing: "not installed", login: "not logged in", unsupported: "update needed", error: "error" };
  const discover = async () => {
    try {
      providers = (await (await api("/providers")).json()).providers;
    } catch { providers = []; showNote("Could not look for installed agents", true); }
    sel.replaceChildren(...providers.map((p) => { const o = el("option", "", p.label + (p.state === "ready" ? "" : ` (${STATE[p.state] || "unavailable"})`)); o.title = p.message; o.value = p.id; return o; }));
    const p = providers.find((x) => x.id === sel.value) || providers[0];
    if (conv) sel.value = conv.provider;
    fillSettings(); refreshNote(); sync();
  };
  sel.onchange = () => { Object.assign(fresh, { model: null, effort: null }); fillSettings(); refreshNote(); sync(); };
  (async () => { await load().catch(() => showNote("Could not load the chat", true)); await discover(); connect(); })();
})();
