// Injected into every previewed page. Pick an element, comment on it.
(() => {
  let on = false, hover = null;

  const css = document.createElement("style");
  css.textContent = `
  .__cd-hl{outline:2px solid #2563eb!important;outline-offset:1px;cursor:crosshair!important}
  .__cd-pin{position:absolute;z-index:2147483646;width:22px;height:22px;border-radius:50%;background:#2563eb;color:#fff;
    font:600 11px/22px system-ui;text-align:center;transform:translate(-50%,-50%);box-shadow:0 1px 4px #0005;pointer-events:none}
  .__cd-pop{box-sizing:border-box;position:absolute;z-index:2147483647;width:300px;background:#18181b;color:#fafafa;border-radius:12px;padding:10px;
    font:13px system-ui;box-shadow:0 8px 30px #0006}
  .__cd-pop small{display:block;color:#a1a1aa;margin-bottom:6px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .__cd-pop textarea{width:100%;box-sizing:border-box;min-height:64px;background:#27272a;color:inherit;border:0;border-radius:8px;padding:8px;font:inherit;resize:vertical}
  .__cd-pop div{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
  .__cd-pop button{border:0;border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer;background:#3f3f46;color:#fff}
  .__cd-pop button.go{background:#2563eb}`;
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
    const u = [];
    for (let e = el; e; e = e.parentElement) if (e.hasAttribute?.("data-cd-use")) u.push(e.getAttribute("data-cd-use"));
    return u;
  };
  const clearHl = () => hover?.classList.remove("__cd-hl");

  document.addEventListener("mouseover", (e) => {
    if (!on || e.target.closest(".__cd-pop")) return;
    clearHl();
    hover = target(e);
    hover?.classList.add("__cd-hl");
  });
  document.addEventListener("click", (e) => {
    if (!on || e.target.closest(".__cd-pop")) return;
    const el = target(e);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openPop(el, e.pageX, e.pageY);
  }, true);

  function openPop(el, x, y) {
    document.querySelector(".__cd-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "__cd-pop";
    pop.style.width = Math.min(300, innerWidth - 16) + "px";
    pop.style.left = Math.max(8, Math.min(x, innerWidth - 308)) + "px";
    pop.style.top = y + 12 + "px";
    const id = el.getAttribute("data-cd-id");
    pop.innerHTML = `<small></small><textarea placeholder="Comment for the agent…"></textarea><div><button class="x">Cancel</button><button class="go">Send</button></div>`;
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
      pin.className = "__cd-pin";
      pin.textContent = n;
      pin.style.left = r.right + scrollX - 4 + "px";
      pin.style.top = r.top + scrollY + 4 + "px";
      document.body.appendChild(pin);
      });
    });
  }

  addEventListener("message", (e) => {
    if (e.data?.cd === "mode") {
      on = e.data.on;
      if (!on) { clearHl(); document.querySelector(".__cd-pop")?.remove(); }
    }
    if (e.data?.cd === "pins") pins();
  });
  addEventListener("load", pins);
  parent.postMessage({ cd: "ready" }, "*");
})();
