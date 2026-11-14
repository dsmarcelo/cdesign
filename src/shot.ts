// Screenshots of a page or one element for coding agents: headless Chrome driven over the DevTools protocol (no dependency).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ShotOpts = {
  url: string;
  selector?: string; // CSS selector; absent = the page
  width: number; // viewport width in CSS px
  theme?: "light" | "dark";
  format: "webp" | "jpeg" | "png";
  maxEdge: number; // longest side of the image in px (Claude downsizes anything above ~1568)
  maxHeight: number; // page shots taller than this (CSS px) are cropped from the top; 0 = never crop
  y: number; // page shots: start this many CSS px from the top
  responsive?: boolean; // one image with mobile, tablet (portrait) and desktop side by side; `width` is ignored
};
/** Device viewports for `responsive` shots: iPhone-size phone, tablet in portrait, desktop. */
export const RESPONSIVE_SIZES = [
  { label: "Mobile (iPhone)", width: 390, height: 844 },
  { label: "Tablet (portrait)", width: 768, height: 1024 },
  { label: "Desktop", width: 1280, height: 800 },
] as const;
export type ShotResult = { data: Buffer; mime: string; width: number; height: number; note: string; cssWidth?: number; cssHeight?: number };

const CANDIDATES = [
  process.env.CDESIGN_CHROME,
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean) as string[];

function findChrome() {
  for (const c of CANDIDATES) {
    const p = c.includes("/") || c.includes("\\") ? (existsSync(c) ? c : null) : Bun.which(c);
    if (p) return p;
  }
  throw new Error("Chrome/Chromium not found. Install Google Chrome or Chromium, or set CDESIGN_CHROME to its executable.");
}

export async function screenshot(o: ShotOpts): Promise<ShotResult> {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-chrome-"));
  const proc = Bun.spawn(
    [findChrome(), "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--disable-extensions",
      "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
  );
  try {
    const ws = await new Promise<string>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("Chrome did not start within 15s")), 15000);
      proc.exited.then(() => fail(new Error("Chrome exited before it was ready")));
      (async () => {
        let seen = "";
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          seen += new TextDecoder().decode(chunk);
          const m = seen.match(/DevTools listening on (ws:\/\/\S+)/);
          if (m) { clearTimeout(t); ok(m[1]); seen = ""; }
          seen = seen.slice(-2000);
        }
      })().catch(() => {});
    });
    return await capture(ws, o);
  } finally {
    try { proc.kill(); } catch { /* gone */ }
    await Promise.race([proc.exited, Bun.sleep(2000)]);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
  }
}

async function capture(wsUrl: string, o: ShotOpts): Promise<ShotResult> {
  const sock = new WebSocket(wsUrl);
  await new Promise<void>((ok, fail) => { sock.onopen = () => ok(); sock.onerror = () => fail(new Error("cannot connect to Chrome")); });
  let n = 0;
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const events: ((m: any) => void)[] = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.fail(new Error(m.error.message)); else w?.ok(m.result);
    } else events.forEach((f) => f(m));
  };
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((ok, fail) => { const id = ++n; waiting.set(id, { ok, fail }); sock.send(JSON.stringify({ id, method, params, sessionId })); });
  const until = (method: string, ms: number) =>
    new Promise<void>((ok) => { const t = setTimeout(ok, ms); events.push((m) => m.method === method && (clearTimeout(t), ok())); });

  // One page load + capture at a given viewport, in its own tab.
  const shoot = async (o: ShotOpts, height: number): Promise<ShotResult> => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cmd = (method: string, params: object = {}) => send(method, params, sessionId);
    const ev = async (expression: string) => {
      const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "page script failed");
      return r.result.value;
    };

    await cmd("Page.enable");
    await cmd("Emulation.setDeviceMetricsOverride", { width: o.width, height, deviceScaleFactor: 1, mobile: o.width <= 500 });
    if (o.theme) await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: o.theme }] });
    const loaded = until("Page.loadEventFired", 20000);
    const nav = await cmd("Page.navigate", { url: o.url });
    if (nav.errorText) throw new Error(`could not load ${o.url}: ${nav.errorText}`);
    await loaded;
    if (o.theme) await ev(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(o.theme)})`);
    await ev(`new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.__cdReady !== false) return resolve();
        if (Date.now() - start > 15000) return reject(new Error('React preview did not become ready'));
        setTimeout(check, 25);
      }; check();
    })`);
    const previewError = await ev(`document.getElementById('__cd-error')?.textContent`);
    if (previewError) throw new Error(previewError);
    // fonts and images settle, then two frames so layout/transitions are done
    await ev(`Promise.all([document.fonts.ready, ...[...document.images].map(i => i.decode().catch(() => {}))]).then(() => new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 150)))`);

    let x = 0, y = 0, w: number, h: number, note = "";
    if (o.selector) {
      const r = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(o.selector)});
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height };
      })()`);
      if (!r) throw new Error(`no element matches ${o.selector}`);
      if (r.w < 1 || r.h < 1) throw new Error(`element ${o.selector} has no size (hidden or empty)`);
      ({ x, y, w, h } = r);
    } else {
      const total = await ev(`Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)`);
      y = Math.min(o.y, Math.max(0, total - 1));
      w = o.width;
      h = total - y;
      if (o.maxHeight && h > o.maxHeight) {
        note = `page is ${Math.round(total)}px tall; showing ${Math.round(y)}-${Math.round(y + o.maxHeight)}px (use --y, --full or a selector for the rest)`;
        h = o.maxHeight;
      }
    }
    // small elements are rendered at 2x so they stay sharp; large ones at 1x, downscaled so the longest side stays under maxEdge
    const scale = Math.min(Math.max(w, h) <= 600 ? 2 : 1, o.maxEdge / Math.max(w, h));
    const params: Record<string, unknown> = {
      format: o.format,
      captureBeyondViewport: true,
      clip: { x, y, width: w, height: h, scale },
    };
    if (o.format !== "png") params.quality = 80;
    const { data } = await cmd("Page.captureScreenshot", params);
    if (scale < 1 && !note) note = `scaled to ${Math.round(scale * 100)}% to fit ${o.maxEdge}px`;
    send("Target.closeTarget", { targetId }).catch(() => {});
    return { data: Buffer.from(data, "base64"), mime: `image/${o.format}`, width: Math.round(w * scale), height: Math.round(h * scale), note, cssWidth: w, cssHeight: h };
  };

  try {
    if (!o.responsive) return await shoot(o, 900);
    // Capture each device at its natural size (lossless, never downscaled), then compose one labelled image.
    const parts: { label: string; width: number; shot: ShotResult }[] = [];
    for (const d of RESPONSIVE_SIZES)
      parts.push({ label: d.label, width: d.width, shot: await shoot({ ...o, width: d.width, format: "png", maxEdge: Infinity }, d.height) });
    return await compose(send, parts, o);
  } finally {
    sock.close();
  }
}

type Send = (method: string, params?: object, sessionId?: string) => Promise<any>;

/** Lay the device shots side by side (top aligned, labelled) on a canvas inside Chrome and export one image. */
async function compose(send: Send, parts: { label: string; width: number; shot: ShotResult }[], o: ShotOpts): Promise<ShotResult> {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const items = parts.map((p) => ({ label: `${p.label} ${p.width}px`, src: `data:image/png;base64,${p.shot.data.toString("base64")}`, w: p.shot.cssWidth, h: p.shot.cssHeight }));
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {
      const items = ${JSON.stringify(items)}, gap = 40, pad = 24, maxEdge = ${o.maxEdge}, mime = ${JSON.stringify(`image/${o.format}`)};
      const imgs = await Promise.all(items.map((it) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('compose failed')); i.src = it.src; })));
      const W = pad * 2 + gap * (items.length - 1) + items.reduce((a, it) => a + it.w, 0);
      const H = pad * 2 + 40 + Math.max(...items.map((it) => it.h));
      const s = Math.min(1, maxEdge / Math.max(W, H)), f = 1 / s; // f: size labels/borders so they stay readable after downscaling
      const c = document.createElement('canvas'); c.width = Math.round(W * s); c.height = Math.round(H * s);
      const g = c.getContext('2d'); g.scale(s, s); g.imageSmoothingQuality = 'high';
      g.fillStyle = '#e5e7eb'; g.fillRect(0, 0, W, H);
      g.font = 'bold ' + 15 * f + 'px sans-serif'; g.textBaseline = 'alphabetic';
      let x = pad;
      items.forEach((it, k) => {
        g.fillStyle = '#374151'; g.fillText(it.label, x, pad + 14 * f);
        const y = pad + 40;
        g.drawImage(imgs[k], x, y, it.w, it.h);
        g.strokeStyle = '#9ca3af'; g.lineWidth = f; g.strokeRect(x - f / 2, y - f / 2, it.w + f, it.h + f);
        x += it.w + gap;
      });
      return { url: c.toDataURL(mime, 0.8), w: c.width, h: c.height };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  send("Target.closeTarget", { targetId }).catch(() => {});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "could not compose the responsive image");
  const { url, w, h } = r.result.value as { url: string; w: number; h: number };
  const notes = parts.filter((p) => p.shot.note).map((p) => `${p.label}: ${p.shot.note}`);
  const note = `${parts.map((p) => `${p.label.split(" ")[0].toLowerCase()} ${p.width}px`).join(", ")}, left to right${notes.length ? `\n${notes.join("\n")}` : ""}`;
  return { data: Buffer.from(url.slice(url.indexOf(",") + 1), "base64"), mime: `image/${o.format}`, width: w, height: h, note };
}
