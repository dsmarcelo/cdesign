import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectId } from "../src/store";

const chrome = process.env.CDESIGN_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
const cli = join(import.meta.dir, "../src/cli.ts");

async function until<T>(fn: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    await Bun.sleep(30);
  }
  throw new Error("Timed out waiting for browser state");
}

test.skipIf(!chrome)("browser: Issue #11 mobile, desktop layout, canvas zoom/comment, and polish checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdesign-audit-"));
  const home = join(root, ".cdesign/home");
  const profile = join(root, ".cdesign/chrome");
  mkdirSync(home, { recursive: true });
  const put = (file: string, body: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), body);
  };
  const init = Bun.spawnSync([process.execPath, cli, "init"], { cwd: root });
  expect(init.exitCode).toBe(0);

  put("design/pages/Home.tsx", 'import {useEffect, useState} from "react"; export default function Home(){const [h, setH] = useState(location.hash); useEffect(()=>{const f=()=>setH(location.hash); addEventListener("hashchange",f); return ()=>removeEventListener("hashchange",f);},[]); return <main style={{minHeight:"120vh"}}><button id="cta">Action {h}</button><nav style={{position:"fixed",bottom:0,left:0,right:0,height:48}}>Bottom Nav</nav></main>}');
  put("design/pages/Second.tsx", "export default function Second(){return <main><p>Second screen</p></main>}");
  put("design/flows/main.json", JSON.stringify({
    title: "Main Flow",
    frames: [
      { id: "home", title: "Home Screen With A Very Long Title For Truncation", page: "design/pages/Home.tsx", x: 0, y: 0, w: 402, h: 874 },
      { id: "second", title: "Second Step With A Very Long Title", page: "design/pages/Second.tsx", x: 482, y: 0, w: 402, h: 874 },
    ],
  }));

  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
    env: { ...process.env, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" },
    stdout: "ignore",
    stderr: "pipe",
  });

  let browser: ReturnType<typeof Bun.spawn> | undefined;
  let socket: WebSocket | undefined;

  try {
    const statePath = join(home, "daemon.json");
    const { port } = await until(() => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null));
    const base = `http://${projectId(root)}.localhost:${port}`;

    browser = Bun.spawn(
      [chrome!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
      { stdout: "ignore", stderr: "pipe" }
    );
    const ws = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Chrome did not start")), 15000);
      (async () => {
        let buffer = "";
        for await (const chunk of browser!.stderr as ReadableStream<Uint8Array>) {
          buffer += new TextDecoder().decode(chunk);
          const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
          if (match) { clearTimeout(timer); ok(match[1]); return; }
        }
      })().catch(fail);
    });
    socket = new WebSocket(ws);
    await new Promise<void>((ok, fail) => {
      socket!.onopen = () => ok();
      socket!.onerror = () => fail(new Error("CDP failed"));
    });

    const consoleErrors: string[] = [];
    let id = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    socket.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
        consoleErrors.push(m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        consoleErrors.push(m.params?.exceptionDetails?.text ?? "exception");
      }
      if (m.method === "Log.entryAdded" && m.params?.entry?.level === "error") {
        consoleErrors.push(m.params.entry.text ?? "log error");
      }
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        socket!.send(JSON.stringify({ id: n, method, params, sessionId }));
      });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cmd = (method: string, params = {}) => send(method, params, sessionId);
    const ev = async (expression: string) => {
      const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
      return r.result.value;
    };
    const clickAt = async (x: number, y: number) => {
      await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    };

    await cmd("Page.enable");
    await cmd("Runtime.enable");
    await cmd("Log.enable");

    // 1. Desktop (998x800) checks on the canvas
    await cmd("Emulation.setDeviceMetricsOverride", { width: 998, height: 800, deviceScaleFactor: 1, mobile: false });
    await cmd("Page.navigate", { url: `${base}/#flow:main` });
    await until(() => ev("document.readyState==='complete' && document.querySelectorAll('.cv-canvas .frame').length === 2"));
    expect(await ev("document.querySelector('.tabs .tab.on')?.textContent")).toContain("Main Flow");
    expect(consoleErrors.some((e) => /ResizeObserver/i.test(e))).toBe(false);

    // Zoom in steps smoothly around content instead of jumping into empty space
    await ev("document.querySelector('button[aria-label=\"Fit to window\"]').click()");
    const zoom = () => ev("parseFloat(document.querySelector('.cv-canvas').style.zoom)");
    const initialZoom = Number(await zoom());
    await ev("document.querySelector('button[aria-label=\"Zoom in\"]').click()");
    const afterOne = Number(await zoom());
    expect(afterOne).toBeGreaterThan(initialZoom);
    expect(afterOne).toBeLessThan(initialZoom * 1.6);
    await ev("document.querySelector('button[aria-label=\"Zoom in\"]').click()");
    expect(await ev(`(() => {
      const vr = document.querySelector('.cv-viewport').getBoundingClientRect();
      return [...document.querySelectorAll('.cv-canvas .frame')].some(n => {
        const r = n.getBoundingClientRect();
        return r.right > vr.left && r.left < vr.right && r.bottom > vr.top && r.top < vr.bottom;
      });
    })()`)).toBe(true);
    // The canvas toolbar stays inside the viewport
    expect(await ev("(() => { const r = document.querySelector('.cv-toolbar').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()")).toBe(true);

    // Comment tool on an element inside a frame opens .board-comment instead of navigating
    await ev("document.querySelector('button[aria-label=\"Fit to window\"]').click()");
    await until(() => ev("!!document.querySelector('.frame[data-frame=home] iframe')?.contentDocument?.querySelector('#cta')"));
    await ev("document.querySelector('.cv-toolbar button[aria-label=Comment]').click()");
    const ctaPos = await ev(`(() => {
      const f = document.querySelector('.frame[data-frame=home] iframe');
      const fr = f.getBoundingClientRect(), z = fr.width / f.offsetWidth;
      const r = f.contentDocument.querySelector('#cta').getBoundingClientRect();
      return { x: fr.left + (r.left + r.width / 2) * z, y: fr.top + (r.top + r.height / 2) * z };
    })()`);
    await clickAt(ctaPos.x, ctaPos.y);
    await until(() => ev("!!document.querySelector('.board-comment textarea')"));
    expect(await ev("location.hash")).toBe("#flow:main");
    await ev("document.querySelector('.board-comment button[type=button]').click()");
    await ev("document.querySelector('.cv-toolbar button[aria-label=Select]').click()");

    // Open the Home frame as a full page
    await ev("document.querySelector('.frame[data-frame=home] .frame-acts button[aria-label^=Open]').click()");
    await until(() => ev("!!document.querySelector('#fr')?.contentDocument?.querySelector('#cta')"));

    // Phone detail view at 998px: no topbar overflow & single-line #dev
    await ev("document.querySelector('#w button[data-w=phone]').click()");
    await until(() => ev("document.body.classList.contains('phone')"));
    expect(await ev("document.querySelector('#mode').getBoundingClientRect().right <= innerWidth")).toBe(true);
    expect(await ev("document.querySelector('#dev').getBoundingClientRect().height <= 30")).toBe(true);

    // Rotated phone fits inside #stage without overflowing
    await ev("document.querySelector('#rot').click()");
    await Bun.sleep(50);
    expect(await ev("document.querySelector('#d1').getBoundingClientRect().right <= document.querySelector('#stage').getBoundingClientRect().right + 2")).toBe(true);
    await ev("document.querySelector('#rot').click()");

    // Tablet (768px) fits inside #stage without overflowing
    await ev("document.querySelector('#w button[data-w=\"768px\"]').click()");
    await until(() => ev("document.body.classList.contains('tablet')"));
    await Bun.sleep(50);
    expect(await ev("document.querySelector('#d1').getBoundingClientRect().right <= document.querySelector('#stage').getBoundingClientRect().right + 2")).toBe(true);

    // Responsive #dim sits below #fr (no overlap)
    await ev("document.querySelector('#w button[data-w=resp]').click()");
    await until(() => ev("document.body.classList.contains('resp')"));
    expect(await ev("document.querySelector('#dim').getBoundingClientRect().top >= document.querySelector('#fr').getBoundingClientRect().bottom")).toBe(true);

    // Split mode syncs hash state between #fr and #fr2
    await ev("document.querySelector('#w button[data-w=split]').click()");
    await until(() => ev("document.body.classList.contains('split') && !!document.querySelector('#fr2')?.contentDocument?.querySelector('#cta')"));
    await ev("document.querySelector('#fr').contentWindow.location.hash = '#step2'");
    await until(() => ev("document.querySelector('#fr2').contentWindow.location.hash === '#step2'"));

    // Tunnel button.on contrast in dark mode
    await ev("document.documentElement.dataset.theme = 'dark'");
    const tunnelColor = await ev(`(() => {
      const b = document.querySelector('#tunnel');
      b.classList.add('on');
      const c = getComputedStyle(b).color;
      b.classList.remove('on');
      return c;
    })()`);
    expect(tunnelColor).not.toBe("rgb(0, 0, 0)");

    // Files filter & clickable Comments link + single-line Comments tab
    await ev("document.querySelector('#tl').click()");
    await until(() => ev("!document.body.classList.contains('hl')"));
    await ev("document.querySelector('#tab-files').click()");
    await ev("{const i=document.querySelector('.file-filter'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Second'); i.dispatchEvent(new Event('input',{bubbles:true}));}");
    await until(() => ev("document.querySelectorAll('#files button.f').length === 1"));
    expect(await ev("document.querySelector('#files button.f').title")).toBe("design/pages/Second.tsx");

    // Create a comment via API and check single-line Comments tab + clickable jump link
    const cdId = await ev("document.querySelector('#fr').contentDocument.querySelector('#cta').getAttribute('data-cd-id')");
    await fetch(`${base}/__cd/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "design/pages/Home.tsx", cdId, text: "Jump test" }),
    });
    await until(() => ev("document.querySelector('#tab-comments .tab-badge')?.textContent === '1'"));
    expect(await ev("document.querySelector('#tab-comments').getBoundingClientRect().height <= 36")).toBe(true);
    await ev("document.querySelector('#tab-comments').click()");
    await ev("document.querySelector('#w button[data-w=\"100%\"]').click()");
    await ev("document.querySelector('#files button.f').click()");
    await until(() => ev("decodeURIComponent(location.hash.slice(1)) === 'design/pages/Second.tsx'"));
    await ev("document.querySelector('.c .c-loc').click()");
    await until(() => ev("decodeURIComponent(location.hash.slice(1)) === 'design/pages/Home.tsx'"));

    // 2. Mobile (390x844) checks
    await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await ev("document.querySelector('#w button[data-w=phone]').click()");
    await ev("if (!document.querySelector('#fit').classList.contains('on')) document.querySelector('#fit').click()");
    await Bun.sleep(50);

    // Full width mobile preview (no 281px shrink)
    expect(await ev("document.querySelector('#d1').getBoundingClientRect().width")).toBeGreaterThanOrEqual(380);
    expect(await ev("document.querySelector('#fr').getBoundingClientRect().width")).toBeGreaterThanOrEqual(380);

    // Real pointer click on #pl opens the drawer, second click closes it
    const plPos = await ev(`(() => {
      const r = document.querySelector('#pl').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await clickAt(plPos.x, plPos.y);
    await until(() => ev("!document.body.classList.contains('hl')"));
    expect(await ev("getComputedStyle(document.querySelector('aside.l')).display")).not.toBe("none");
    await clickAt(plPos.x, plPos.y);
    await until(() => ev("document.body.classList.contains('hl')"));

    // Back to the canvas: compact mobile head and toolbar
    await ev("document.querySelector('#back').click()");
    await until(() => ev("!document.querySelector('#map').hidden && !!document.querySelector('.cv-head')"));
    expect(await ev("document.querySelector('.cv-head').getBoundingClientRect().height")).toBeLessThanOrEqual(60);
    expect(await ev("document.querySelector('.cv-toolbar').getBoundingClientRect().right <= innerWidth + 1")).toBe(true);

    // Full page heartbeat uses keepalive
    const fullHtml = await (await fetch(`${base}/p/design/pages/Home.tsx?full=1`)).text();
    expect(fullHtml).toContain("keepalive: true");
    expect(fullHtml).toContain("pagehide");
  } finally {
    socket?.close();
    browser?.kill();
    daemon.kill();
    await daemon.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
