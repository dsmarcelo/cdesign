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
  const badge = el("span", "cc-badge full", "Full access");
  badge.title = "The agent can read, write and run commands in this project without asking. Provider or managed restrictions may still apply.";
  const top = el("div", "cc-top"); top.append(sel, badge);
  const note = el("div", "cc-note"); note.hidden = true; note.setAttribute("role", "status");
  const log = el("div", "cc-log"); log.setAttribute("aria-live", "polite");
  const box = el("textarea"); box.placeholder = "Ask the agent to change this design…"; box.setAttribute("aria-label", "Message");
  const hint = el("small", "", "Enter to send, Shift+Enter for a new line");
  const sendBtn = el("button", "go", "Send"), stopBtn = el("button", "", "Stop"); stopBtn.hidden = true;
  const form = el("div", "cc-form"); const row = el("div"); row.append(hint, stopBtn, sendBtn); form.append(box, row);
  root.append(top, note, log, form);

  let providers = [], conv = null, busy = false, seq = 0, es = null, posting = false;
  const ready = () => providers.find((p) => p.id === sel.value)?.state === "ready";
  const showNote = (text, err) => { note.hidden = !text; note.textContent = text || ""; note.classList.toggle("err", !!err); };
  const sync = () => {
    sendBtn.disabled = busy || posting || !ready() || !box.value.trim();
    stopBtn.hidden = !busy;
    box.disabled = false;
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
  const render = () => {
    log.replaceChildren(); nodes.clear();
    if (!conv?.items.length) log.append(el("div", "cc-empty", "Ask the agent to change this design. Your project's files are edited directly and the preview reloads."));
    else for (const it of conv.items) draw(it);
    log.scrollTop = log.scrollHeight;
  };
  const stick = (fn) => { const at = log.scrollHeight - log.scrollTop - log.clientHeight < 40; fn(); if (at) log.scrollTop = log.scrollHeight; };
  const find = (id) => conv?.items.find((i) => i.id === id);
  // mirrors apply() in src/chat.ts
  const reduce = (ev) => {
    switch (ev.type) {
      case "turn.begin":
        if (!conv || conv.id !== ev.conversation.id) { conv = { ...ev.conversation, items: [] }; render(); }
        busy = true; showNote("");
        conv.items.push({ id: ev.itemId, kind: "user", text: ev.text });
        if (log.querySelector(".cc-empty")) log.replaceChildren();
        stick(() => draw(conv.items.at(-1)));
        break;
      case "turn.started": break;
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
      case "turn.completed":
        busy = false;
        for (const it of conv?.items || []) if (it.status === "inProgress") { it.status = ev.status === "completed" ? "completed" : ev.status; draw(it); }
        for (const n of log.querySelectorAll(".live")) n.classList.remove("live");
        if (ev.status === "failed") showNote(ev.error || "The turn failed", true);
        else if (ev.status === "interrupted") showNote("Stopped. What the agent said so far is kept.");
        break;
    }
    sync();
  };
  const load = async () => {
    const s = await (await api("")).json();
    conv = s.conversation; busy = s.busy; seq = s.seq;
    showNote(conv?.error, true); render(); sync();
  };
  const connect = () => {
    es?.close();
    es = new EventSource("/__cd/chat/events?after=" + seq);
    es.onmessage = async (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === "reset") { await load(); return; }
      if (ev.seq <= seq) return; // already part of the snapshot
      seq = ev.seq; reduce(ev);
    };
  };

  const send = async () => {
    const text = box.value.trim();
    if (!text || busy || posting || !ready()) return;
    posting = true; sync();
    try {
      const r = await post("/send", { text, provider: sel.value, conversationId: conv && conv.provider === sel.value ? conv.id : undefined });
      if (r.ok) box.value = "";
      else showNote((await r.json().catch(() => ({}))).error || "Could not send", true);
    } catch { showNote("Could not reach cdesign", true); }
    posting = false; sync();
  };
  const stop = () => post("/stop", { conversationId: conv?.id, turnId: conv?.turnId }).then(async (r) => { if (!r.ok) showNote((await r.json().catch(() => ({}))).error || "Could not stop", true); });
  sendBtn.onclick = send; stopBtn.onclick = stop;
  box.oninput = sync;
  box.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };

  const discover = async () => {
    try {
      providers = (await (await api("/providers")).json()).providers;
    } catch { providers = []; showNote("Could not look for installed agents", true); }
    sel.replaceChildren(...providers.map((p) => { const o = el("option", "", p.label + (p.state === "ready" ? "" : " (unavailable)")); o.value = p.id; return o; }));
    const p = providers.find((x) => x.id === sel.value) || providers[0];
    if (p && p.state !== "ready") showNote(p.message, true);
    else if (!conv?.error) showNote("");
    sync();
  };
  sel.onchange = () => { const p = providers.find((x) => x.id === sel.value); showNote(p && p.state !== "ready" ? p.message : "", true); sync(); };
  (async () => { await load().catch(() => showNote("Could not load the chat", true)); await discover(); connect(); })();
})();
