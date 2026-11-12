// Injected into every previewed page. Pick an element, comment on it.
(() => {
  let mode = null, hover = null, tab = null, picked = null;

  const css = document.createElement("style");
  css.textContent = `
  .__cd-hl{outline:2px solid #2563eb!important;outline-offset:1px;cursor:crosshair!important}
  .__cd-sel{outline:2px dashed #16a34a!important;outline-offset:2px}
  .__cd-pin{position:absolute;z-index:2147483646;width:22px;height:22px;border-radius:50%;background:#2563eb;color:#fff;
    font:600 11px/22px system-ui;text-align:center;transform:translate(-50%,-50%);box-shadow:0 1px 4px #0005;pointer-events:none}
  .__cd-pin.q{background:#71717a}
  .__cd-pop{box-sizing:border-box;position:absolute;z-index:2147483647;width:300px;background:#18181b;color:#fafafa;border-radius:12px;padding:10px;
    font:13px system-ui;box-shadow:0 8px 30px #0006}
  .__cd-pop small{display:block;color:#a1a1aa;margin-bottom:6px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .__cd-pop textarea{width:100%;box-sizing:border-box;min-height:64px;background:#27272a;color:inherit;border:0;border-radius:8px;padding:8px;font:inherit;resize:vertical}
  .__cd-pop div{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
  .__cd-pop button{border:0;border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer;background:#3f3f46;color:#fff}
  .__cd-pop button.go{background:#2563eb}
  .__cd-insp{all:initial;box-sizing:border-box;position:fixed;z-index:2147483647;width:320px;max-height:min(560px,calc(100vh - 16px));overflow:auto;background:#18181b;color:#fafafa;
    border-radius:12px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px #0008;color-scheme:dark}
  .__cd-insp *{box-sizing:border-box;font:inherit;color:inherit;letter-spacing:normal;text-transform:none}
  .__cd-insp header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #27272a;cursor:move;user-select:none;position:sticky;top:0;background:#18181b}
  .__cd-insp header b{font-weight:600;font-family:ui-monospace,Menlo,monospace}
  .__cd-insp header span{flex:1;min-width:0;color:#a1a1aa;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .__cd-insp button{border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:#3f3f46;color:#fff;margin:0}
  .__cd-insp button.go{background:#2563eb} .__cd-insp button:disabled{opacity:.45;cursor:default}
  .__cd-insp button.x{background:none;padding:2px 6px;color:#a1a1aa;font-size:14px;line-height:1}
  .__cd-insp section{padding:8px 10px;border-bottom:1px solid #27272a}
  .__cd-insp h4{margin:0 0 6px;font-size:10px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:.05em}
  .__cd-insp dl{display:grid;grid-template-columns:76px 1fr;gap:3px 8px;margin:0}
  .__cd-insp dt{color:#a1a1aa} .__cd-insp dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  .__cd-insp .sw{display:inline-block;width:10px;height:10px;border-radius:3px;border:1px solid #fff4;vertical-align:-1px;margin-right:5px}
  .__cd-insp .tk{color:#93c5fd} .__cd-insp .ok{color:#4ade80} .__cd-insp .bad{color:#f87171}
  .__cd-insp .seg{display:flex;gap:2px;background:#27272a;border-radius:7px;padding:2px;margin-bottom:8px}
  .__cd-insp .seg button{flex:1;background:none;color:#a1a1aa;padding:3px 0} .__cd-insp .seg button.on{background:#3f3f46;color:#fff}
  .__cd-insp input[type=search],.__cd-insp input[type=text]{width:100%;background:#27272a;border:0;border-radius:6px;padding:5px 8px;margin:0 0 8px;outline:none}
  .__cd-insp .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(26px,1fr));gap:5px;max-height:150px;overflow:auto;padding:2px}
  .__cd-insp .grid button{height:26px;padding:0;border-radius:6px;border:1px solid #fff3;position:relative}
  .__cd-insp .grid button.cur::after{content:"";position:absolute;inset:8px;border-radius:50%;background:#fff;box-shadow:0 0 0 1.5px #000a}
  .__cd-insp .grid button.on{outline:2px solid #fafafa;outline-offset:1px}
  .__cd-insp .custom{display:flex;gap:8px;align-items:center} .__cd-insp .custom input[type=color]{width:40px;height:30px;padding:0;border:0;background:none;cursor:pointer}
  .__cd-insp .custom input[type=text]{margin:0;flex:1;font-family:ui-monospace,Menlo,monospace}
  .__cd-insp .pick{margin-top:8px;color:#a1a1aa;min-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .__cd-insp footer{display:flex;gap:6px;justify-content:flex-end;padding:8px 10px;position:sticky;bottom:0;background:#18181b}
  .__cd-probe{position:absolute!important;width:0!important;height:0!important;overflow:hidden!important;visibility:hidden!important}`;
  document.head.appendChild(css);

  const target = (e) => e.target.closest?.("[data-cd-id]");
  const selectorOf = (el) => {
    const parts = [];
    for (; el && el.nodeType === 1 && el !== document.body; el = el.parentElement) {
      let s = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(`${s}#${el.id}`); break; }
      const cls = [...el.classList].filter((c) => !c.startsWith("__cd")).slice(0, 2).join(".");
      if (cls) s += "." + cls;
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const fileOf = (el) => el.getAttribute("data-cd-file");
  const usesOf = (el) => {
    if (el.hasAttribute("data-cd-uses")) { try { return JSON.parse(el.getAttribute("data-cd-uses")); } catch {} }
    const u = [];
    for (let e = el; e; e = e.parentElement) if (e.hasAttribute?.("data-cd-use")) u.push(e.getAttribute("data-cd-use"));
    return u;
  };
  const clearHl = () => hover?.classList.remove("__cd-hl");
  const post = (selection) => fetch("/__cd/selection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId: tab, selection }) }).catch(() => {});
  const unpick = () => { closeInsp(); picked?.classList.remove("__cd-sel"); picked = null; };
  const pick = (el) => {
    unpick();
    picked = el;
    el.classList.add("__cd-sel");
    const r = el.getBoundingClientRect();
    post({ file: fileOf(el), cdId: el.getAttribute("data-cd-id"), uses: usesOf(el), selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200), size: `${px(r.width)} x ${px(r.height)} px` });
    inspect(el);
  };
  // after a reload the page is new: redraw the outline for the selection the server still holds
  async function restore() {
    if (!tab || picked?.isConnected) return;
    try {
      const { selection: s } = await (await fetch("/__cd/page?tab=" + tab)).json();
      if (!s) return;
      const el = [...document.querySelectorAll(`[data-cd-id="${s.cdId}"]`)].find((e) => fileOf(e) === s.file);
      if (el) (picked = el).classList.add("__cd-sel");
    } catch {}
  }

  document.addEventListener("mouseover", (e) => {
    if (!mode || e.target.closest(".__cd-pop,.__cd-insp")) return;
    clearHl();
    hover = target(e);
    hover?.classList.add("__cd-hl");
  });
  document.addEventListener("click", (e) => {
    if (!mode || e.target.closest(".__cd-pop,.__cd-insp")) return;
    const el = target(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === "select") pick(el);
    else openPop(el, e.pageX, e.pageY);
  }, true);

  function openPop(el, x, y) {
    document.querySelector(".__cd-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "__cd-pop";
    pop.style.width = Math.min(300, innerWidth - 16) + "px";
    pop.style.left = Math.max(8, Math.min(x, innerWidth - 308)) + "px";
    pop.style.top = y + 12 + "px";
    const id = el.getAttribute("data-cd-id");
    pop.innerHTML = `<small></small><textarea placeholder="Comment (sent to the agent with Send)…"></textarea><div><button class="x">Cancel</button><button class="go">Add</button></div>`;
    const uses = usesOf(el);
    pop.querySelector("small").textContent = `${fileOf(el)}:${id}${uses.length ? " · in " + uses[0] : ""} · ${selectorOf(el)}`;
    document.body.appendChild(pop);
    const ta = pop.querySelector("textarea");
    ta.focus();
    const send = async () => {
      if (!ta.value.trim()) return;
      await fetch("/__cd/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: fileOf(el), cdId: id, uses, selector: selectorOf(el), text: ta.value }),
      });
      pop.remove();
    };
    pop.querySelector(".x").onclick = () => pop.remove();
    pop.querySelector(".go").onclick = send;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
      if (e.key === "Escape") pop.remove();
    });
  }

  // ---------- Select: inspector (size, box, type, colors) and a color picker limited to the design tokens ----------
  const px = (n) => String(Math.round(n * 10) / 10);
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let tokens = null, probe = null, insp = null;
  const loadTokens = async () => (tokens ??= await fetch("/__cd/tokens/colors").then((r) => r.json()).catch(() => []));
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  // any CSS color (vars, oklch, named...) -> [r,g,b,a] bytes
  const resolve = (css) => {
    probe ??= Object.assign(document.createElement("i"), { className: "__cd-probe" });
    if (!probe.isConnected) document.body.appendChild(probe);
    probe.style.color = "";
    probe.style.color = css;
    if (!probe.style.color) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#0000";
    ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  const hex = (b) => b ? "#" + b.slice(0, b[3] < 255 ? 4 : 3).map((n) => n.toString(16).padStart(2, "0")).join("") : "";
  const lum = (b) => { const [r, g, l] = b.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * l; };
  const dark = () => { const t = document.documentElement.getAttribute("data-theme"); return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
  // a token's color as the page renders it now (its CSS variable if defined, else its value for the current theme)
  const tokenColors = () => (tokens || []).map((t) => ({ ...t, value: dark() ? t.dark : t.light })).map((t) => ({ ...t, hex: hex(resolve(`var(${t.var}, ${t.value})`) || resolve(t.value)) }));
  const tokenOf = (h, list) => (h ? list.find((t) => t.hex === h)?.name : undefined);
  const sides = (cs, p, suffix = "") => {
    const v = ["top", "right", "bottom", "left"].map((s) => cs.getPropertyValue(`${p}-${s}${suffix}`));
    if (v.every((x) => x === v[0])) return v[0];
    if (v[0] === v[2] && v[1] === v[3]) return `${v[0]} ${v[1]}`;
    return v.join(" ");
  };
  const backdrop = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const b = resolve(getComputedStyle(e).backgroundColor); if (b && b[3] > 0) return b; }
    return dark() ? [0, 0, 0, 255] : [255, 255, 255, 255];
  };
  const PROPS = { color: "Text", "background-color": "Background", "border-color": "Border" };

  function closeInsp() {
    if (!insp) return;
    for (const [prop, o] of Object.entries(insp.orig)) if (!insp.done.has(prop)) insp.el.style.setProperty(prop, o.v, o.p);
    insp.obs.disconnect();
    insp.box.remove();
    insp = null;
  }

  async function inspect(el) {
    closeInsp();
    const box = document.createElement("div");
    box.className = "__cd-insp";
    box.style.width = Math.min(320, innerWidth - 16) + "px";
    document.body.appendChild(box);
    const cs0 = getComputedStyle(el);
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const bg0 = resolve(cs0.backgroundColor);
    const state = insp = { el, box, prop: hasText || !(bg0 && bg0[3]) ? "color" : "background-color", orig: {}, was: {}, changes: {}, done: new Set(), filter: "", obs: new MutationObserver(() => render()) };
    state.obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    await loadTokens();
    if (insp !== state) return;
    render();
    place();
  }

  function place() {
    const { el, box } = insp, r = el.getBoundingClientRect(), h = box.offsetHeight, w = box.offsetWidth;
    let top = r.bottom + 8;
    if (top + h > innerHeight - 8) top = r.top - h - 8 >= 8 ? r.top - h - 8 : innerHeight - h - 8;
    box.style.top = Math.max(8, top) + "px";
    box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  }

  function apply(prop, value, label, quiet) {
    const { el, orig, changes, done } = insp;
    if (!(prop in orig)) { orig[prop] = { v: el.style.getPropertyValue(prop), p: el.style.getPropertyPriority(prop) }; insp.was[prop] = hex(resolve(getComputedStyle(el).getPropertyValue(prop))); }
    el.style.setProperty(prop, value, "important");
    changes[prop] = { value, label };
    done.delete(prop);
    if (!quiet) render();
  }

  function render() {
    if (!insp) return;
    const s = insp, { el, box } = s;
    const scroll = box.querySelector(".grid")?.scrollTop ?? 0;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), list = tokenColors();
    const colorRow = (css) => {
      const b = resolve(css);
      if (!b || !b[3]) return `<span style="color:#71717a">transparent</span>`;
      const h = hex(b), t = tokenOf(h, list);
      return `<span class="sw" style="background:${h}"></span>${h}${t ? ` <span class="tk">${esc(t)}</span>` : list.length ? ` <span class="bad" title="Not a design token">off-token</span>` : ""}`;
    };
    const rows = [["Size", `${px(r.width)} × ${px(r.height)} px`], ["Position", `x ${px(r.left + scrollX)}, y ${px(r.top + scrollY)}`]];
    let disp = cs.display;
    if (/flex|grid/.test(disp)) disp += `${disp.includes("flex") ? " " + cs.flexDirection : ""}${cs.gap !== "normal" && cs.gap !== "0px" ? ` · gap ${cs.gap}` : ""}`;
    rows.push(["Display", disp]);
    const pad = sides(cs, "padding"), mar = sides(cs, "margin");
    if (pad !== "0px") rows.push(["Padding", pad]);
    if (mar !== "0px") rows.push(["Margin", mar]);
    const bw = sides(cs, "border", "-width");
    if (bw !== "0px") rows.push(["Border", `${bw} ${cs.borderTopStyle}`]);
    if (cs.borderRadius !== "0px") rows.push(["Radius", cs.borderRadius]);
    rows.push(["Font", `${esc(cs.fontFamily.split(",")[0].replace(/["']/g, ""))} ${cs.fontSize}/${cs.lineHeight === "normal" ? "normal" : cs.lineHeight} · ${cs.fontWeight}`]);
    rows.push(["Text", colorRow(cs.color)], ["Background", colorRow(cs.backgroundColor)]);
    if (bw !== "0px") rows.push(["Border color", colorRow(cs.borderTopColor)]);
    if ((el.textContent || "").trim()) {
      const fg = resolve(cs.color), bg = backdrop(el);
      if (fg) {
        const a = fg[3] / 255, mix = [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a)));
        const [l1, l2] = [lum(mix), lum(bg)].sort((x, y) => y - x), ratio = (l1 + 0.05) / (l2 + 0.05);
        const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
        const grade = ratio >= (large ? 4.5 : 7) ? "AAA" : ratio >= (large ? 3 : 4.5) ? "AA" : "fails AA";
        rows.push(["Contrast", `${ratio.toFixed(2)}:1 <span class="${grade === "fails AA" ? "bad" : "ok"}">${grade}${large ? " (large)" : ""}</span>`]);
      }
    }
    if (+cs.opacity < 1) rows.push(["Opacity", cs.opacity]);
    if (el.children.length) rows.push(["Children", String(el.children.length)]);

    const curHex = hex(resolve(cs.getPropertyValue(s.prop)));
    const ch = s.changes[s.prop];
    let picker;
    if (list.length) {
      const q = s.filter.toLowerCase(), shown = list.filter((t) => !q || `${t.name} ${t.usage}`.toLowerCase().includes(q));
      picker = `${list.length > 12 ? `<input type="search" placeholder="Filter ${list.length} color tokens…" value="${esc(s.filter)}">` : ""}<div class="grid">${shown.map((t) =>
        `<button data-t="${esc(t.name)}" class="${t.hex === curHex ? "cur" : ""}${ch?.label === t.name ? " on" : ""}" style="background:var(${esc(t.var)}, ${esc(t.value)})" title="${esc(t.name)} · ${esc(t.value)}${t.usage ? "\n" + esc(t.usage) : ""}"></button>`).join("") || `<small style="color:#71717a">No match</small>`}</div>`;
    } else {
      const v = (ch?.value ?? curHex ?? "#000000").slice(0, 7) || "#000000";
      picker = `<div class="custom"><input type="color" value="${esc(v)}"><input type="text" value="${esc(ch?.value ?? curHex)}" spellcheck="false" placeholder="#rrggbb"></div><div class="pick" style="margin-top:6px">No color tokens in this project: any color.</div>`;
    }
    const pending = Object.keys(s.changes).filter((p) => !s.done.has(p));
    box.innerHTML = `<header><b>&lt;${el.tagName.toLowerCase()}&gt;</b><span></span><button class="x" title="Close (Esc)">✕</button></header>
      <section><h4>Element</h4><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></section>
      <section><h4>Color${list.length ? " · design tokens" : ""}</h4><div class="seg">${Object.entries(PROPS).map(([p, l]) => `<button data-p="${p}" class="${p === s.prop ? "on" : ""}">${l}${s.changes[p] ? " •" : ""}</button>`).join("")}</div>${picker}
        <div class="pick">${ch ? `${PROPS[s.prop]} → <span class="tk">${esc(ch.label)}</span>${s.done.has(s.prop) ? " · comment added" : ""}` : `Current: ${curHex || "none"}${tokenOf(curHex, list) ? ` (${esc(tokenOf(curHex, list))})` : ""}`}</div></section>
      <footer><button class="reset"${Object.keys(s.orig).length ? "" : " disabled"}>Reset</button><button class="go"${pending.length ? "" : " disabled"}>Add as comment${pending.length > 1 ? ` (${pending.length})` : ""}</button></footer>`;
    box.querySelector("header span").textContent = `${fileOf(el)}:${el.getAttribute("data-cd-id")}`;
    box.querySelector("header span").title = selectorOf(el);
    const g = box.querySelector(".grid");
    if (g) g.scrollTop = scroll;
    box.querySelector(".x").onclick = () => closeInsp();
    box.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { s.prop = b.dataset.p; render(); }));
    box.querySelectorAll(".grid button").forEach((b) => (b.onclick = () => { const t = list.find((t) => t.name === b.dataset.t); apply(s.prop, `var(${t.var}, ${t.value})`, t.name); }));
    const f = box.querySelector("input[type=search]");
    if (f) f.oninput = () => { s.filter = f.value; render(); const n = box.querySelector("input[type=search]"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    const cp = box.querySelector("input[type=color]"), tx = box.querySelector(".custom input[type=text]");
    // live preview while dragging; re-render only on commit so the native picker stays open
    if (cp) { cp.oninput = () => { apply(s.prop, cp.value, cp.value, true); tx.value = cp.value; }; cp.onchange = () => render(); }
    if (tx) tx.onchange = () => { const b = resolve(tx.value.trim()); if (b) apply(s.prop, tx.value.trim(), tx.value.trim()); };
    box.querySelector(".reset").onclick = () => {
      for (const [prop, o] of Object.entries(s.orig)) el.style.setProperty(prop, o.v, o.p);
      s.orig = {}; s.was = {}; s.changes = {}; s.done.clear(); render();
    };
    box.querySelector(".go").onclick = async () => {
      const parts = pending.map((p) => {
        const c = s.changes[p], t = list.find((t) => t.name === c.label);
        const was = s.was[p];
        return `${PROPS[p].toLowerCase()} color to ${t ? `token \`${t.name}\` (var(${t.var}))` : c.value}${was ? ` (was ${was}${tokenOf(was, list) ? `, token ${tokenOf(was, list)}` : ""})` : ""}`;
      });
      const uses = usesOf(el);
      await fetch("/__cd/comments", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: fileOf(el), cdId: el.getAttribute("data-cd-id"), uses, selector: selectorOf(el), text: `Set the ${parts.join(", and the ")}.` }) });
      pending.forEach((p) => s.done.add(p));
      render();
    };
    // drag by the header
    box.querySelector("header").onpointerdown = (e) => {
      if (e.target.closest("button")) return;
      const sx = e.clientX - box.offsetLeft, sy = e.clientY - box.offsetTop;
      const mv = (m) => { box.style.left = Math.max(0, Math.min(m.clientX - sx, innerWidth - 40)) + "px"; box.style.top = Math.max(0, Math.min(m.clientY - sy, innerHeight - 30)) + "px"; };
      const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
      addEventListener("pointermove", mv);
      addEventListener("pointerup", up);
    };
  }
  addEventListener("keydown", (e) => { if (e.key === "Escape" && insp) closeInsp(); });

  async function pins() {
    document.querySelectorAll(".__cd-pin").forEach((p) => p.remove());
    const list = (await (await fetch("/__cd/comments")).json()).filter((c) => c.status !== "done");
    let n = 0;
    list.forEach((c) => {
      const els = [...document.querySelectorAll(`[data-cd-id="${c.cdId}"]`)].filter((e) => fileOf(e) === c.file);
      if (!els.length) return;
      n++;
      els.forEach((el) => {
      const r = el.getBoundingClientRect();
      const pin = document.createElement("div");
      pin.className = "__cd-pin" + (c.status === "draft" ? "" : " q");
      pin.textContent = n;
      pin.style.left = r.right + scrollX - 4 + "px";
      pin.style.top = r.top + scrollY + 4 + "px";
      document.body.appendChild(pin);
      });
    });
  }

  addEventListener("message", (e) => {
    if (e.data?.cd === "mode") {
      mode = e.data.mode;
      tab = e.data.tab;
      if (!mode) clearHl();
      if (mode !== "comment") document.querySelector(".__cd-pop")?.remove();
      if (mode !== "select") closeInsp();
    }
    if (e.data?.cd === "clear" && (picked || tab)) { unpick(); post(null); }
    if (e.data?.cd === "pins") { pins(); restore(); }
  });
  addEventListener("load", pins);
  parent.postMessage({ cd: "ready" }, "*");
})();
