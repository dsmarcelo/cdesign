// Maps: the project at a glance. "Pages" groups design/pages by folder (hub = file named like the folder, or index);
// "Flows" draws design/flows/<id>.json as a left-to-right diagram of screens and decisions, with a Wireframes/Screens layer.
// Routes live in the hash next to page paths: #map:pages, #map:flows, #flow:<id>. Loaded before the viewer script, so it
// only defines functions; the viewer calls them (it owns cur, setCur, previewPath, toast...).
const MAP_RE = /^(map:(pages|flows)|flow:[a-z0-9-]+)$/;
const isMapHash = (h) => MAP_RE.test(h || "");
const openedWithoutHash = !location.hash.slice(1); // read before the viewer picks a first page
let mapData = { flows: [], sync: [] }, mapPages = [], mapKey = "", lastMap = null, mapZoom = null;
const mapZooms = {}; // per route; unset: fit the diagram to the window on first draw
const mapLayer = () => { try { return sessionStorage.getItem("cd-layer") || "wireframe"; } catch { return "wireframe"; } };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const baseName = (f) => f.split("/").pop().replace(/\.(tsx|html)$/, "");
const STATE = {
  "no-page": ["Wireframe only", "mut"], "no-wireframe": ["No wireframe", "mut"], "never-synced": ["Never synced", "mut"],
  "in-sync": ["In sync", "ok"], "wireframe-changed": ["Wireframe changed", "chg"], "page-changed": ["Page changed", "chg"], "both-changed": ["Both changed", "chg"],
};
const itemOf = (file) => file ? mapData.sync.find((i) => i.wireframe === file || i.page === file) : undefined;

async function mapFetch() {
  const [d, p] = await Promise.all([fetch("/__cd/flows").then((r) => r.json()).catch(() => ({ flows: [], sync: [] })), fetch("/__cd/files").then((r) => r.json()).catch(() => [])]);
  mapData = d; mapPages = p.filter((f) => f.startsWith("design/pages/"));
  const key = JSON.stringify([d, mapPages]);
  const changed = key !== mapKey; mapKey = key;
  return changed;
}

/** The default landing: the flow map when the project has flows, otherwise the viewer as before. */
async function mapInit() {
  mapPan($("#map"));
  await mapFetch();
  const h = pageHash();
  if (isMapHash(h)) showMap(h);
  else if (openedWithoutHash && mapData.flows.length) location.replace("#map:flows");
  flowbar();
}

function showMap(h) {
  lastMap = h;
  try { sessionStorage.setItem("cd-last-map", h); } catch {}
  document.body.classList.add("map");
  viewButtons();
  renderMap();
}
function hideMap() { document.body.classList.remove("map"); viewButtons(); flowbar(); }
function goMap(kind) {
  const h = kind === "pages" ? "map:pages" : kind === "flows" ? (lastMap?.startsWith("flow:") ? lastMap : "map:flows") : (lastMap || (() => { try { return sessionStorage.getItem("cd-last-map"); } catch { return null; } })() || (mapData.flows.length ? "map:flows" : "map:pages"));
  location.hash = h;
}
function viewButtons() {
  const h = pageHash(), inMap = document.body.classList.contains("map");
  const v = !inMap ? "files" : h === "map:pages" ? "pages" : "flows";
  document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  $("#back").hidden = inMap;
}
async function mapRefresh() {
  const changed = await mapFetch();
  flowbar();
  if (!document.body.classList.contains("map")) return;
  if (changed) return renderMap();
  for (const f of document.querySelectorAll("#map iframe[src]")) try { f.contentWindow.location.reload(); } catch {} // content changed, structure did not
}

// ---------- rendering ----------
// Every screen is a live preview at its real device size (phone = iPhone 18 viewport, desktop = 1280 x 800); the canvas is
// zoomed as a whole, so zooming in shows the real screen and the select/comment tools work inside it.
const DEVICE = { phone: [402, 874], desktop: [1280, 800] };
const mapDevice = () => { try { return sessionStorage.getItem("cd-map-device") || "phone"; } catch { return "phone"; } };
let thumbObs;
function frame(file, device) {
  const [w, h] = DEVICE[device];
  const box = el("div", "thumb " + device); box.style.width = w + "px"; box.style.height = h + "px";
  if (!file) { box.classList.add("empty"); box.append(el("span", "", "No file yet")); return box; }
  const f = document.createElement("iframe");
  f.title = file; f.dataset.src = previewPath(file); f.dataset.file = file;
  f.addEventListener("load", () => { try { f.contentDocument.documentElement.setAttribute("data-theme", document.documentElement.dataset.theme); } catch {} sync(); });
  box.append(f); thumbObs?.observe(f);
  return box;
}
/** A screen node: caption above (open button, state badge), live frame below. Clicking the frame opens it unless a tool is active. */
function card(file, title, opts = {}) {
  const device = opts.device || mapDevice();
  const n = el("div", "node screen " + device + (opts.cls ? " " + opts.cls : ""));
  const cap = el("div", "cap");
  const open = el("button", "open", title); open.type = "button"; open.title = file ? "Open " + file : title; open.disabled = !file;
  if (file) open.onclick = () => openFromMap(file);
  cap.append(open);
  const item = opts.item ?? itemOf(file);
  if (item) {
    const [t, c] = STATE[item.state];
    const badge = el("span", "badge " + (item.outdated.length ? "warn" : c), item.outdated.length ? `${item.outdated.map((o) => o.side).join(" + ")} outdated` : t);
    if (item.outdated.length) badge.title = item.outdated.map((o) => `${o.file}${o.note ? ": " + o.note : ""}`).join("\n");
    cap.append(badge);
  }
  if (opts.sub) cap.append(el("span", "badge mut", opts.sub));
  const fr = frame(file, device);
  if (file) fr.onclick = () => { if (!mode && !mapDragged) openFromMap(file); };
  n.append(cap, fr);
  return n;
}
function openFromMap(file) { lastMap = pageHash(); setCur(file); }

function renderMap() {
  const h = pageHash(), root = $("#map");
  thumbObs?.disconnect();
  root.replaceChildren();
  thumbObs = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && !e.target.src) { e.target.src = e.target.dataset.src; thumbObs.unobserve(e.target); } }), { root, rootMargin: "600px" });
  const head = el("div", "map-head"), canvas = el("div", "map-canvas");
  root.append(head, canvas);
  if (h === "map:pages") pagesMap(head, canvas);
  else flowsMap(h.startsWith("flow:") ? h.slice(5) : null, head, canvas);
  const dev = el("div", "seg"), current = mapDevice();
  for (const [v, t] of [["phone", "Phone"], ["desktop", "Desktop"]]) {
    const b = el("button", "", t); b.type = "button"; b.setAttribute("aria-pressed", String(current === v));
    b.title = v === "phone" ? "Show phone screens (iPhone 18, 402 × 874)" : "Show desktop screens (1280 × 800)";
    b.onclick = () => { try { sessionStorage.setItem("cd-map-device", v); } catch {} delete mapZooms[h]; renderMap(); };
    dev.append(b);
  }
  const zoom = el("div", "zoom grp");
  const set = (z, cx, cy) => {
    const old = mapZoom; mapZoom = Math.max(.08, Math.min(2, z));
    const r = root.getBoundingClientRect(), x = cx ?? r.width / 2, y = cy ?? r.height / 2;
    const px = (root.scrollLeft + x) / old, py = (root.scrollTop + y) / old;
    canvas.style.zoom = mapZooms[h] = mapZoom; canvas.style.setProperty("--z", Math.max(mapZoom, .2));
    root.scrollLeft = px * mapZoom - x; root.scrollTop = py * mapZoom - y;
    pct.textContent = Math.round(mapZoom * 100) + "%";
  };
  const fit = (both = true) => { canvas.style.zoom = 1; const w = canvas.scrollWidth, ht = canvas.scrollHeight, fw = (root.clientWidth - 16) / w; return Math.max(.08, Math.min(1, fw, both ? (root.clientHeight - head.offsetHeight - 16) / ht : fw)); };
  for (const [t, f, label] of [["−", () => mapZoom / 1.25, "Zoom out"], ["", () => 1, "Actual size"], ["+", () => mapZoom * 1.25, "Zoom in"], ["Fit", fit, "Fit to window"]]) {
    const b = el("button", "", t); b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
    b.onclick = () => { const z = f(); if (t === "Fit") { mapZoom = z; canvas.style.zoom = mapZooms[h] = z; canvas.style.setProperty("--z", Math.max(z, .2)); root.scrollTo(0, 0); pct.textContent = Math.round(z * 100) + "%"; } else set(z); };
    zoom.append(b);
  }
  const pct = zoom.children[1];
  head.append(dev, zoom);
  mapZoom = mapZooms[h] ?? fit(false); // first view: fit the width, scroll for the rest
  canvas.style.zoom = mapZooms[h] = mapZoom; canvas.style.setProperty("--z", Math.max(mapZoom, .2));
  pct.textContent = Math.round(mapZoom * 100) + "%";
  if (mapZooms[h] === undefined || !renderMap.seen?.has(h)) { // the first view of a route fits once layout has settled
    (renderMap.seen ??= new Set()).add(h);
    requestAnimationFrame(() => { mapZoom = fit(false); canvas.style.zoom = mapZooms[h] = mapZoom; canvas.style.setProperty("--z", Math.max(mapZoom, .2)); pct.textContent = Math.round(mapZoom * 100) + "%"; root.scrollTo(0, 0); });
  }
  root.onwheel = (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = root.getBoundingClientRect(); set(mapZoom * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top); };
}
// drag the canvas to pan (unless a tool is active); a drag never also opens a screen
let mapDragged = false;
function mapPan(root) {
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || mode || e.target.closest(".map-head,.sync-panel,button")) return;
    const x0 = e.clientX, y0 = e.clientY, l0 = root.scrollLeft, t0 = root.scrollTop;
    mapDragged = false;
    const move = (m) => { if (!mapDragged && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return; mapDragged = true; root.classList.add("panning"); root.scrollLeft = l0 - (m.clientX - x0); root.scrollTop = t0 - (m.clientY - y0); };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); root.classList.remove("panning"); setTimeout(() => (mapDragged = false), 0); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
}

function pagesMap(head, canvas) {
  head.prepend(el("h2", "", "Pages"), el("small", "", "Grouped by folder in design/pages"));
  if (!mapPages.length) { canvas.append(el("p", "empty-map", "No pages in design/pages yet.")); return; }
  const groups = new Map();
  for (const f of mapPages) {
    const parts = f.slice("design/pages/".length).split("/");
    const g = parts.length > 1 ? parts[0] : "";
    (groups.get(g) ?? groups.set(g, []).get(g)).push(f);
  }
  const device = mapDevice(), [W, H] = DEVICE[device], GAP = 120, DOWN = 260;
  for (const [g, files] of [...groups].sort(([a], [b]) => (a === "") - (b === "") || a.localeCompare(b))) {
    const hub = files.find((f) => baseName(f) === g) ?? files.find((f) => baseName(f) === "index") ?? files[0];
    const rest = files.filter((f) => f !== hub).sort();
    const sec = el("section", "group");
    sec.append(el("h3", "", g || "design/pages"));
    const body = el("div", "group-body");
    const rowW = Math.max(W, rest.length * W + Math.max(0, rest.length - 1) * GAP);
    body.style.width = rowW + "px"; body.style.height = (rest.length ? 2 * H + DOWN : H) + "px";
    const svg = svgEl(body), hx = (rowW - W) / 2;
    const hc = card(hub, baseName(hub), { cls: "hub" }); place(hc, hx, 0); body.append(hc);
    rest.forEach((f, i) => {
      const x = i * (W + GAP), y = H + DOWN;
      const c = card(f, baseName(f)); place(c, x, y); body.append(c);
      const sx = hx + W / 2, sy = H, tx = x + W / 2, ty = y - 8;
      path(svg, `M${sx} ${sy} C${sx} ${sy + DOWN / 2},${tx} ${ty - DOWN / 2},${tx} ${ty}`);
    });
    sec.append(body); canvas.append(sec);
  }
  canvas.classList.add("groups");
}

function flowsMap(id, head, canvas) {
  const flows = mapData.flows;
  head.prepend(el("h2", "", "Flows"));
  if (!flows.length) {
    const p = el("div", "empty-map");
    p.innerHTML = "<p>No flows yet. A flow is one file, <code>design/flows/&lt;id&gt;.json</code>, listing screens (wireframe + page) and decisions joined by labeled arrows.</p><p>Ask your agent: <em>“create the flow for …”</em>, or run <code>cdesign flows new &lt;id&gt;</code>.</p>";
    canvas.append(p); return;
  }
  const flow = flows.find((f) => f.id === id) ?? flows[0];
  const chips = el("div", "chips");
  for (const f of flows) {
    const b = el("button", "", f.title); b.type = "button"; b.setAttribute("aria-pressed", String(f === flow));
    if (f.errors.length) { b.classList.add("bad"); b.title = f.errors.join("\n"); }
    b.onclick = () => { location.hash = "flow:" + f.id; };
    chips.append(b);
  }
  const layer = mapLayer(), seg = el("div", "seg");
  for (const [v, t] of [["wireframe", "Wireframes"], ["page", "Screens"]]) {
    const b = el("button", "", t); b.type = "button"; b.setAttribute("aria-pressed", String(layer === v));
    b.onclick = () => { try { sessionStorage.setItem("cd-layer", v); } catch {} renderMap(); };
    seg.append(b);
  }
  const marked = mapData.sync.filter((i) => i.outdated.length).length, drift = mapData.sync.filter((i) => /changed/.test(i.state)).length;
  const sb = el("button", "sync-btn" + (marked ? " warn" : ""), marked ? `${marked} outdated` : drift ? `${drift} changed` : "Sync"); sb.type = "button";
  sb.title = "What needs syncing between wireframes and pages"; sb.onclick = () => { $("#map").classList.toggle("panel"); syncPanel(); };
  head.append(chips, seg, sb);
  if (flow.description) chips.title = flow.description;
  if (flow.errors.length) { const e = el("div", "flow-errors"); e.textContent = flow.errors.join("\n"); canvas.append(e); }
  drawFlow(flow, layer, canvas);
  syncPanel();
}

/** Which file and device a step shows: the chosen layer and device first, then the other device, then the other layer. */
function stepView(s, layer, device) {
  const other = device === "phone" ? "desktop" : "phone", v = s.wireframes ?? (s.wireframe ? { phone: s.wireframe, desktop: s.wireframe } : {});
  const wire = v[device] ? [v[device], device] : v[other] ? [v[other], other] : null;
  const page = s.page ? [s.page, device] : null;
  const [first, second] = layer === "page" ? [page, wire] : [wire, page];
  const [file, dev] = first ?? second ?? [null, device];
  const notes = [];
  if (!first) notes.push(layer === "page" ? "No page yet" : "No wireframe");
  else if (dev !== device) notes.push(dev === "phone" ? "Phone only" : "Desktop only");
  return { file, device: dev, sub: notes.join(" · ") || undefined, fallback: !first };
}

function drawFlow(flow, layer, canvas) {
  const ids = flow.steps.map((s) => s.id), step = Object.fromEntries(flow.steps.map((s) => [s.id, s]));
  const out = Object.fromEntries(ids.map((i) => [i, []]));
  flow.links.forEach((l, k) => out[l.from].push(k));
  // back edges (loops such as "try again") are found by DFS in file order and drawn dashed underneath
  const state = {}, back = new Set();
  const dfs = (u) => { state[u] = 1; for (const k of out[u]) { const v = flow.links[k].to; if (state[v] === 1) back.add(k); else if (!state[v]) dfs(v); } state[u] = 2; };
  ids.forEach((i) => state[i] || dfs(i));
  const layerOf = Object.fromEntries(ids.map((i) => [i, 0]));
  for (let n = 0; n < ids.length; n++) flow.links.forEach((l, k) => { if (!back.has(k) && layerOf[l.to] < layerOf[l.from] + 1) layerOf[l.to] = layerOf[l.from] + 1; });
  // rows: the first branch out of a step stays on its row, later branches open new rows below (Whimsical-like main path)
  const row = {}, used = new Set(), hasIn = new Set(flow.links.filter((l, k) => !back.has(k)).map((l) => l.to));
  let maxRow = -1;
  const take = (i, r) => { while (used.has(layerOf[i] + ":" + r)) r++; row[i] = r; used.add(layerOf[i] + ":" + r); maxRow = Math.max(maxRow, r); };
  const visit = (u, r) => {
    if (row[u] !== undefined) return;
    take(u, r);
    let first = true;
    for (const k of out[u]) { const v = flow.links[k].to; if (back.has(k) || row[v] !== undefined) continue; visit(v, first ? row[u] : maxRow + 1); first = false; }
  };
  ids.filter((i) => !hasIn.has(i)).forEach((i) => visit(i, maxRow + 1));
  ids.forEach((i) => visit(i, maxRow + 1));
  const device = mapDevice(), views = {}, size = {}, D = 220;
  for (const s of flow.steps) { if (s.decision) size[s.id] = [D * 1.6, D]; else { views[s.id] = stepView(s, layer, device); size[s.id] = DEVICE[views[s.id].device]; } }
  const layers = Math.max(...ids.map((i) => layerOf[i]), 0) + 1, GAP = 300, ROW = 260, PAD = 120;
  const colW = Array.from({ length: layers }, (_, x) => Math.max(D, ...ids.filter((i) => layerOf[i] === x).map((i) => size[i][0])));
  const rowH = Math.max(...ids.map((i) => size[i][1]), D);
  const colX = colW.map((_, x) => PAD + colW.slice(0, x).reduce((a, w) => a + w + GAP, 0));
  const pos = Object.fromEntries(ids.map((i) => {
    const [w, h] = size[i], x = layerOf[i], cx = colX[x] + (colW[x] - w) / 2, cy = PAD + row[i] * (rowH + ROW) + (rowH - h) / 2;
    return [i, { x: cx, y: cy, w, h }];
  }));
  const body = el("div", "flow-body");
  const maxH = (maxRow + 1) * rowH + maxRow * ROW;
  const width = colX[layers - 1] + colW[layers - 1] + PAD, height = PAD * 2 + maxH + (back.size ? 260 : 0);
  body.style.width = width + "px"; body.style.height = height + "px";
  const svg = svgEl(body);
  const anchor = (i, side) => {
    const p = pos[i], cy = p.y + p.h / 2;
    if (side === "out") return [p.x + p.w, cy];
    if (side === "in") return [p.x, cy];
    return [p.x + p.w / 2, p.y + p.h]; // bottom
  };
  flow.links.forEach((l, k) => {
    let mid;
    if (back.has(k) || l.from === l.to) {
      // loops leave from the left side and come back into the target's bottom, staying close to both screens
      const [sx, sy] = anchor(l.from, "in"), [tx, ty] = anchor(l.to, "bottom"), dx = Math.max(160, GAP / 2);
      const c1 = [sx - dx, sy], c2 = [tx, Math.max(ty + 200, sy)];
      path(svg, `M${sx} ${sy} C${c1[0]} ${c1[1]},${c2[0]} ${c2[1]},${tx} ${ty + 6}`, true);
      mid = [(sx + 3 * c1[0] + 3 * c2[0] + tx) / 8, (sy + 3 * c1[1] + 3 * c2[1] + ty) / 8];
    } else {
      const [sx, sy] = anchor(l.from, "out"), [tx, ty] = anchor(l.to, "in");
      mid = edge(svg, sx, sy, tx, ty, l.dashed);
    }
    if (l.label) { const t = el("span", "elabel", l.label); place(t, mid[0], mid[1]); body.append(t); }
  });
  for (const s of flow.steps) {
    const p = pos[s.id];
    if (s.decision) {
      const d = el("div", "node decision"); d.style.width = p.w + "px"; d.style.height = p.h + "px";
      d.append(el("div", "dia"), el("span", "", s.decision)); d.title = s.decision; place(d, p.x, p.y); body.append(d);
      continue;
    }
    const v = views[s.id];
    const c = card(v.file, s.title ?? s.id, { device: v.device, cls: v.fallback ? "fallback" : "", sub: v.sub, item: mapData.sync.find((i) => i.wireframe === s.wireframe && i.page === s.page) });
    place(c, p.x, p.y); body.append(c);
  }
  canvas.append(body);
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(parent) {
  const s = document.createElementNS(NS, "svg"); s.classList.add("edges");
  s.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>';
  parent.append(s); return s;
}
function path(svg, d, dashed) {
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); p.setAttribute("marker-end", "url(#ah)");
  if (dashed) p.setAttribute("stroke-dasharray", "14 12");
  svg.append(p);
}
function edge(svg, sx, sy, tx, ty, dashed) {
  const c = Math.max(80, (tx - sx) / 2);
  path(svg, `M${sx} ${sy} C${sx + c} ${sy},${tx - c} ${ty},${tx - 2} ${ty}`, dashed);
  return [(sx + tx) / 2, (sy + ty) / 2];
}
const place = (e, x, y) => { e.style.left = x + "px"; e.style.top = y + "px"; };

// ---------- sync panel (map) and flow bar (open page) ----------
async function syncAction(action, file, note) {
  const r = await fetch("/__cd/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, file, note }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || "Sync update failed");
  mapData.sync = j.sync;
  toast(action === "done" ? "Marked in sync" : action === "outdated" ? "Marked outdated" : "Mark cleared");
  flowbar(); if (document.body.classList.contains("map")) renderMap();
}
function markOutdatedUi(file) {
  const note = prompt(`What must change in ${file}? (optional note for the agent)`, "");
  if (note !== null) syncAction("outdated", file, note.trim() || undefined);
}
const fileLink = (file) => { const a = el("button", "link", file ? file.replace(/^design\//, "") : "—"); a.type = "button"; a.disabled = !file; if (file) a.onclick = () => openFromMap(file); return a; };
function syncPanel() {
  const root = $("#map");
  root.querySelector(".sync-panel")?.remove();
  if (!root.classList.contains("panel") || !root.querySelector(".map-head .sync-btn")) return;
  const p = el("aside", "sync-panel");
  p.style.top = root.getBoundingClientRect().top + "px";
  const x = el("button", "close ic", "×"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.onclick = () => { root.classList.remove("panel"); syncPanel(); };
  p.append(x, el("h3", "", "Wireframes ↔ pages"), el("p", "hint", "A wireframe change does not require a page change. Only marked items need an update. Agents read this with cdesign sync."));
  const sections = [
    ["Marked outdated", (i) => i.outdated.length], ["Changed since last sync", (i) => !i.outdated.length && /changed/.test(i.state)],
    ["Never synced", (i) => !i.outdated.length && i.state === "never-synced"], ["Wireframe only", (i) => i.state === "no-page" && !i.outdated.length],
    ["In sync", (i) => i.state === "in-sync" && !i.outdated.length],
  ];
  for (const [t, f] of sections) {
    const l = mapData.sync.filter(f);
    if (!l.length) continue;
    p.append(el("h4", "", `${t} (${l.length})`));
    for (const i of l) {
      const row = el("div", "srow");
      row.append(el("b", "", i.steps.map((s) => s.title).join(", ")));
      for (const f of [i.wireframe, i.page]) if (f) row.append(fileLink(f));
      for (const o of i.outdated) row.append(el("small", "warn", `${o.side} outdated${o.note ? ": " + o.note : ""}`));
      if (!i.outdated.length && /changed/.test(i.state)) row.append(el("small", "", STATE[i.state][0]));
      const acts = el("div", "acts");
      if (i.wireframe && i.page && (i.state !== "in-sync" || i.outdated.length)) { const b = el("button", "", "Mark synced"); b.type = "button"; b.onclick = () => syncAction("done", i.page); acts.append(b); }
      for (const o of i.outdated) { const b = el("button", "", `Clear ${o.side} mark`); b.type = "button"; b.onclick = () => syncAction("clear", o.file); acts.append(b); }
      if (acts.childElementCount) row.append(acts);
      p.append(row);
    }
  }
  root.append(p);
}

/** Above the open page: where it sits in its flows, a Wireframe/Screen switch for its pair, sync state and actions. */
function flowbar() {
  const bar = $("#flowbar");
  if (!bar) return;
  bar.replaceChildren();
  const item = itemOf(cur);
  if (!cur || !item || document.body.classList.contains("map")) { bar.hidden = true; return; }
  bar.hidden = false;
  const isWire = item.wireframe === cur;
  const where = el("span", "where");
  for (const s of item.steps) {
    const f = mapData.flows.find((x) => x.id === s.flow);
    const b = el("button", "link", `${f?.title ?? s.flow} › ${s.title}`); b.type = "button"; b.onclick = () => { location.hash = "flow:" + s.flow; };
    where.append(b);
  }
  bar.append(where);
  // next screens: follow links out of this step, through decisions, preferring the same layer
  const next = el("span", "next");
  for (const s of item.steps) {
    const f = mapData.flows.find((x) => x.id === s.flow);
    if (!f) continue;
    const go = (id, label, depth = 0) => {
      const st = f.steps.find((x) => x.id === id);
      if (!st || depth > 3) return;
      if (st.decision) { for (const l of f.links.filter((l) => l.from === id)) go(l.to, [label, l.label].filter(Boolean).join(" · "), depth + 1); return; }
      const file = (isWire ? st.wireframe : st.page) ?? st.wireframe ?? st.page;
      if (!file) return;
      const b = el("button", "chip", `${label ? label + " → " : "→ "}${st.title ?? st.id}`); b.type = "button"; b.title = file; b.onclick = () => setCur(file);
      next.append(b);
    };
    for (const l of f.links.filter((l) => l.from === s.step && l.to !== s.step)) go(l.to, l.label);
  }
  if (next.childElementCount) bar.append(next);
  const right = el("span", "right");
  if (item.wireframe && item.page) {
    const seg = el("span", "seg");
    for (const [file, t] of [[item.wireframe, "Wireframe"], [item.page, "Screen"]]) { const b = el("button", "", t); b.type = "button"; b.setAttribute("aria-pressed", String(file === cur)); b.onclick = () => file !== cur && setCur(file); seg.append(b); }
    right.append(seg);
  }
  const [t, c] = STATE[item.state];
  right.append(el("span", "badge " + c, t));
  const mk = (t, f) => { const b = el("button", "", t); b.type = "button"; b.onclick = f; right.append(b); };
  if (item.wireframe && item.page && item.state !== "in-sync") mk("Mark synced", () => syncAction("done", item.page));
  if (!item.outdated.some((o) => o.file === cur)) mk(`Mark this ${isWire ? "wireframe" : "page"} outdated`, () => markOutdatedUi(cur));
  bar.append(right);
  for (const o of item.outdated) {
    const warn = el("div", "outdated");
    warn.append(el("span", "", `${o.file === cur ? "This " + o.side : "The " + o.side} is marked outdated${o.note ? ": " + o.note : ""}`));
    if (o.file !== cur) warn.append(fileLink(o.file));
    const b = el("button", "", "Clear mark"); b.type = "button"; b.onclick = () => syncAction("clear", o.file); warn.append(b);
    bar.append(warn);
  }
}
