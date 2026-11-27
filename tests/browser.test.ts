import { expect, test } from "bun:test";
import { appendFileSync, cpSync, symlinkSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectId } from "../src/store";
import { screenshot } from "../src/shot";

const chrome = process.env.CDESIGN_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
const cli = join(import.meta.dir, "../src/cli.ts");
async function until<T>(fn: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn(); if (value) return value as NonNullable<T>;
    await Bun.sleep(30);
  }
  throw new Error("Timed out waiting for browser state");
}

async function runBrowserChecks(mapsOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "cdesign-browser-"));
  const home = join(root, ".cdesign/home"), profile = join(root, ".cdesign/chrome");
  mkdirSync(home, {recursive: true});
  const put = (file: string, body: string) => { mkdirSync(dirname(join(root, file)), {recursive: true}); writeFileSync(join(root, file), body); };
  const init = Bun.spawnSync([process.execPath, cli, "init"], {cwd: root}); expect(init.exitCode).toBe(0);
  const button = '/** Purpose: Stateful button. */\nimport {useState} from "react";\nexport default function Button(){ const [n,setN]=useState(0); return <button className="p-4 bg-red-500" onClick={()=>setN(n+1)}>Count {n}</button>}\nexport function Preview(){const [wide,setWide]=useState(false);return <section style={{padding:wide?32:8}}><input type="checkbox" onChange={()=>setWide(!wide)}/><Button/><Button/></section>}';
  put("design/components/ui/Button.tsx", button);
  put("design/pages/Home.tsx", 'import Button from "../components/ui/Button"; export default function Home(){return <main><Button/><Button/></main>}');
  const runtime = join(home, "runtime"), link = join(home, "linked");
  mkdirSync(runtime);
  for (const dir of ["src", "ui"]) cpSync(join(import.meta.dir, "..", dir), join(runtime, dir), { recursive: true });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(runtime, "node_modules"), "dir");
  symlinkSync(runtime, link, "dir");
  const runtimeCli = join(link, "src/cli.ts");
  const daemon = Bun.spawn([process.execPath, runtimeCli, "serve", root, "--port", "0"], {env: {...process.env, CDESIGN_HOME: home, CDESIGN_INSTALL_LINK: link, CDESIGN_IDLE_SECONDS: "300"}, stdout: "ignore", stderr: "pipe"});
  let browser: ReturnType<typeof Bun.spawn> | undefined, socket: WebSocket | undefined;
  try {
    const statePath = join(home, "daemon.json");
    const {port} = await until(() => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null);
    const base = `http://${projectId(root)}.localhost:${port}`;
    browser = Bun.spawn([chrome!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {stdout: "ignore", stderr: "pipe"});
    const ws = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Chrome did not start")), 15000);
      (async () => { let buffer = ""; for await (const chunk of browser!.stderr as ReadableStream<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk); const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); ok(match[1]); return; }
      } })().catch(fail);
    });
    socket = new WebSocket(ws);
    await new Promise<void>((ok, fail) => {socket!.onopen = () => ok(); socket!.onerror = () => fail(new Error("CDP failed"));});
    let id = 0;
    const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
    socket.onmessage = event => {const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (p) {pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);}};
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {const n = ++id; pending.set(n, {resolve, reject}); socket!.send(JSON.stringify({id:n, method, params, sessionId}));});
    const {targetId} = await send("Target.createTarget", {url: "about:blank"});
    const {sessionId} = await send("Target.attachToTarget", {targetId, flatten: true});
    const cmd = (method: string, params = {}) => send(method, params, sessionId);
    const ev = async (expression: string) => { const r = await cmd("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
    const navigate = async (path: string, selector: string) => {
      await cmd("Page.navigate", {url: base + path});
      await until(async () => ev(`document.readyState==='complete' && document.querySelector(${JSON.stringify(selector)}) && window.__cdReady!==false`));
    };
    await cmd("Page.enable");
    if (mapsOnly) {
      put("design/flows/home.json", JSON.stringify({
        title: "Home",
        steps: ["home", "next", "done", "option-one", "option-two"].map((id) => ({id, title: id, page: "design/pages/Home.tsx"})),
        links: [
          {from: "home", to: "next"}, {from: "next", to: "done"},
          {from: "home", to: "option-one"}, {from: "option-one", to: "home"},
          {from: "home", to: "option-two"}, {from: "option-two", to: "home"},
        ],
      }));
      for (const route of ["map:pages", "flow:home"]) {
        await navigate("/#" + route, "#map .thumb");
        if (route === "flow:home") {
          const rows = await ev(`Array.from(document.querySelectorAll(".flow-body .screen"), node => node.offsetTop)`);
          expect(rows.slice(0, 3)).toEqual([rows[0], rows[0], rows[0]]);
          expect(rows[3]).toBeGreaterThan(rows[0]);
          expect(rows[4]).toBe(rows[3]);
          expect(await ev('document.querySelectorAll(".edges > path[stroke-dasharray]").length')).toBe(2);
        }
        const key = (key: string, code: string, shiftKey = false) => ev(`window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({key, code, shiftKey, cancelable: true})}))`);
        const camera = () => ev("document.querySelector('.map-position').style.translate");
        const zoom = () => ev("document.querySelector('.map-canvas').style.zoom");
        const before = await camera();
        expect(Number(await zoom())).toBeLessThan(1);
        await key("ArrowLeft", "ArrowLeft");
        expect(await camera()).not.toBe(before);
        await key(")", "Digit0", true);
        expect(await zoom()).toBe("1");
        const anchorError = await ev(`(() => {
          const viewport = document.querySelector('.map-viewport');
          const canvas = document.querySelector('.map-canvas');
          const {left, top} = viewport.getBoundingClientRect();
          const x = Math.round(left + 100), y = Math.round(top + 100);
          const before = canvas.getBoundingClientRect();
          viewport.dispatchEvent(new WheelEvent('wheel', {
            clientX: x, clientY: y, deltaY: -60, cancelable: true
          }));
          const after = canvas.getBoundingClientRect();
          return Math.abs((x - before.left) - (x - after.left) / Number(canvas.style.zoom));
        })()`);
        expect(anchorError).toBeLessThan(1);
        expect(Number(await zoom())).toBeGreaterThan(1);
        await ev("document.querySelector('#map .thumb').click()");
        await until(() => ev("!!document.querySelector('.board-selected')"));
        await key("@", "Digit2", true);
        const centered = await ev(`(() => {
          const {left, width} = document.querySelector('.board-selected').getBoundingClientRect();
          const viewport = document.querySelector('.map-viewport').getBoundingClientRect();
          return Math.abs(left + width / 2 - viewport.left - viewport.width / 2);
        })()`);
        expect(centered).toBeLessThan(1);
        await key("h", "KeyH");
        await until(() => ev("!!document.querySelector('.map-viewport.hand')"));
        await key("v", "KeyV");
        await until(() => ev("!document.querySelector('.map-viewport.hand')"));
        await key("!", "Digit1", true);
        const {x, y} = await ev(`(() => {
          const r = document.querySelector('.map-viewport').getBoundingClientRect();
          return {x: Math.round(r.left + Math.min(80, r.width / 4)), y: Math.round(r.top + Math.min(100, r.height / 4))};
        })()`);
        const beforeDrag = await camera();
        await cmd("Input.dispatchKeyEvent", {type: "keyDown", key: " ", code: "Space"});
        expect(await ev("!!document.querySelector('.map-viewport.hand')")).toBe(true);
        expect(await ev(`document.elementFromPoint(${x}, ${y})?.closest('.map-viewport')?.className ?? document.elementFromPoint(${x}, ${y})?.outerHTML.slice(0, 100)`)).toBe("map-viewport hand");
        await cmd("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
        await cmd("Input.dispatchMouseEvent", {type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1});
        await cmd("Input.dispatchMouseEvent", {type: "mouseMoved", x: x + 45, y: y + 25, buttons: 1});
        await until(async () => (await camera()) !== beforeDrag);
        await cmd("Input.dispatchMouseEvent", {type: "mouseReleased", x: x + 45, y: y + 25, button: "left", clickCount: 1});
        await cmd("Input.dispatchKeyEvent", {type: "keyUp", key: " ", code: "Space"});
        const beforeScroll = await camera();
        await cmd("Input.dispatchMouseEvent", {type: "mouseWheel", x, y, deltaX: 30, deltaY: 50});
        await until(async () => (await camera()) !== beforeScroll);
        const fitZoom = Number(await zoom());
        await cmd("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y, id: 1}, {x: x + 60, y, id: 2}]});
        await cmd("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x, y, id: 1}, {x: x + 100, y, id: 2}]});
        await cmd("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
        expect(Number(await zoom())).toBeGreaterThan(fitZoom);
        const savedPosition = await camera(), savedZoom = await zoom();
        await ev("window.beforeCameraReload = true");
        await cmd("Page.reload");
        await until(() => ev(`!window.beforeCameraReload && location.hash === ${JSON.stringify("#" + route)} && !!document.querySelector('#map .thumb')`));
        expect(await camera()).toBe(savedPosition);
        expect(await zoom()).toBe(savedZoom);
      }
      return;
    }
    await navigate("/p/design/pages/Home.tsx", "button");
    expect(await ev("getComputedStyle(document.querySelector('button')).padding")).toBe("16px");
    expect(await ev("document.querySelectorAll('button').length")).toBe(2);
    expect(await ev("document.querySelector('input')===null")).toBe(true);
    await ev("document.querySelector('button').click()");
    await until(() => ev("document.querySelector('button').textContent==='Count 1'"));
    expect(await ev("document.querySelectorAll('button')[1].textContent")).toBe("Count 0");
    const attrs = await ev("({file:document.querySelector('button').dataset.cdFile,id:document.querySelector('button').dataset.cdId,uses:JSON.parse(document.querySelector('button').dataset.cdUses)})");
    expect(attrs.file).toBe("design/components/ui/Button.tsx"); expect(attrs.uses[0]).toContain("design/pages/Home.tsx:");
    await ev(`fetch('/__cd/page',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tabId:'browser',file:'design/pages/Home.tsx'})})`);
    await ev("window.postMessage({cd:'mode',mode:'select',tab:'browser'},'*')");
    await Bun.sleep(50); await ev("document.querySelector('button').click()");
    await until(async () => (await (await fetch(`${base}/__cd/page?tab=browser`)).json() as any).selection);
    const selection = (await (await fetch(`${base}/__cd/page?tab=browser`)).json() as any).selection;
    expect(selection.snippet).toContain("onClick"); expect(selection.file).toBe(attrs.file);
    expect(selection.size).toMatch(/^[\d.]+ x [\d.]+ px$/);
    // Select opens the inspector: rendered size plus a color picker (design tokens when present, else any color)
    const insp = await until(() => ev("document.querySelector('.__cd-insp')?.textContent"));
    expect(insp).toContain("Size"); expect(insp).toContain("Contrast");
    const options = await (await fetch(`${base}/__cd/style-options`)).json() as any;
    expect(await ev("document.querySelectorAll('.__cd-insp .grid button').length")).toBe(options.colors.length);
    // Button is shared but doesn't forward className, so edits go to the component file; they land in the source right away
    await until(() => ev("document.querySelector('.__cd-insp [data-s=instance]')?.disabled"));
    if (!options.colors.length) {
      await ev("const c=document.querySelector('.__cd-insp input[type=color]');c.value='#123456';c.dispatchEvent(new Event('input'));c.dispatchEvent(new Event('change'))");
      await until(() => readFileSync(join(root, attrs.file), "utf8").includes("text-[#123456]"));
      expect(await ev("getComputedStyle(document.querySelector('button')).color")).toBe("rgb(18, 52, 86)");
    }
    await ev("const w=document.querySelector('.__cd-insp .fw');w.value='700';w.dispatchEvent(new Event('change'))");
    await until(() => readFileSync(join(root, attrs.file), "utf8").includes("font-bold"));
    await until(() => ev("document.querySelector('.__cd-insp .status.ok')?.textContent.includes('saved to')"));
    for (let i = 0; i < 2 && readFileSync(join(root, attrs.file), "utf8") !== button; i++) expect((await (await fetch(`${base}/__cd/edit/undo`, {method: "POST"})).json() as any).ok).toBe(true);
    expect(readFileSync(join(root, attrs.file), "utf8")).toBe(button);
    await ev("document.querySelector('.__cd-insp .x').click()");
    expect(await ev("document.querySelector('.__cd-insp')")).toBe(null);
    await ev("window.postMessage({cd:'mode',mode:'comment',tab:'browser'},'*')");
    await Bun.sleep(50); await ev("document.querySelector('button').click()");
    await ev("document.querySelector('.__cd-pop textarea').value='Make it clearer';document.querySelector('.__cd-pop .go').click()");
    const comments = await until(async () => {const c = await (await fetch(`${base}/__cd/comments`)).json() as any[]; return c.length ? c : null;});
    expect(comments[0].snippet).toContain("setN(n+1)"); expect(comments[0].uses[0]).toContain("Home.tsx");
    expect(readFileSync(join(root, attrs.file), "utf8")).toBe(button);
    const shot = await screenshot({url:base+"/p/design/pages/Home.tsx?raw=1",width:390,theme:"dark",format:"png",maxEdge:1568,maxHeight:1600,y:0});
    expect(shot.data.length).toBeGreaterThan(100);
    // The component itself opens its authored preview, with hooks and same-file instance locations.
    await navigate("/p/design/components/ui/Button.tsx", "button");
    expect(await ev("document.querySelectorAll('button').length")).toBe(2);
    await ev("document.querySelector('input').click();document.querySelector('button').click()");
    await until(() => ev("document.querySelector('button').textContent==='Count 1' && getComputedStyle(document.querySelector('section')).padding==='32px'"));
    const inline = await ev("({file:document.querySelector('button').dataset.cdFile,id:document.querySelector('button').dataset.cdId,uses:JSON.parse(document.querySelector('button').dataset.cdUses)})");
    expect(inline.file).toBe(attrs.file); expect(inline.id).toBe(attrs.id);
    expect(inline.uses[0]).toMatch(/^design\/components\/ui\/Button\.tsx:4:/);
    await ev(`fetch('/__cd/page',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tabId:'inline',file:'design/components/ui/Button.tsx'})})`);
    await ev("window.postMessage({cd:'mode',mode:'select',tab:'inline'},'*')");
    await Bun.sleep(50); await ev("document.querySelector('button').click()");
    const inlineSelection = await until(async () => ((await (await fetch(`${base}/__cd/page?tab=inline`)).json()) as any).selection);
    expect(inlineSelection.snippet).toContain("setN(n+1)"); expect(inlineSelection.uses).toEqual(inline.uses);
    await ev("window.postMessage({cd:'mode',mode:'comment',tab:'inline'},'*')");
    await Bun.sleep(50); await ev("document.querySelector('button').click()");
    await ev("document.querySelector('.__cd-pop textarea').value='Inline preview feedback';document.querySelector('.__cd-pop .go').click()");
    const inlineComments = await until(async () => {const c = await (await fetch(`${base}/__cd/comments`)).json() as any[]; return c.find(c => c.text === 'Inline preview feedback');});
    expect(inlineComments.file).toBe(attrs.file); expect(inlineComments.uses).toEqual(inline.uses);
    const inlineShot = await screenshot({url:base+"/p/design/components/ui/Button.tsx?raw=1",width:390,theme:"dark",format:"png",maxEdge:1568,maxHeight:1600,y:0});
    expect(inlineShot.data.length).toBeGreaterThan(100);
    // One command, three screen sizes: mobile, tablet (portrait) and desktop side by side in a single image.
    const multi = await screenshot({url:base+"/p/design/pages/Home.tsx?raw=1",width:1280,format:"png",maxEdge:1568,maxHeight:1600,y:0,responsive:true});
    expect(multi.data.subarray(1,4).toString()).toBe("PNG");
    expect(multi.width).toBeGreaterThan(multi.height * 0.5); expect(multi.width).toBeLessThanOrEqual(1568);
    expect(multi.note).toContain("mobile 390px");
    expect(multi.data.length).toBeGreaterThan(inlineShot.data.length);
    // Page history belongs to the viewer, including its initial page and both split frames.
    await navigate("/", "#fr");
    await until(() => ev("!!document.querySelector('#fr').contentDocument?.querySelector('button')"));
    const initial = await ev("location.hash.slice(1)");
    expect(initial).toBe("design/components/ui/Button.tsx");
    const homePage = "design/pages/Home.tsx";
    const viewerState = async (file: string, split = false) => {
      await until(() => ev(`location.hash.slice(1)===${JSON.stringify(file)} &&
        document.querySelector('#files .sel')?.title===${JSON.stringify(file)} &&
        ${JSON.stringify(split ? ['#fr', '#fr2'] : ['#fr'])}.every(id => {
          const f = document.querySelector(id);
          return f.contentWindow.location.pathname==='/p/'+${JSON.stringify(file)} && !!f.contentDocument?.querySelector('button');
        })`));
      await until(async () => ((await (await fetch(`${base}/__cd/page`)).json()) as any).file === file);
    };
    const selectPage = (file: string) => ev(`document.querySelector('#files button[title="${file}"]').click()`);
    const browserHistory = async (offset: number) => {
      const h = await cmd("Page.getNavigationHistory");
      await cmd("Page.navigateToHistoryEntry", {entryId: h.entries[h.currentIndex + offset].id});
    };
    await selectPage(homePage); await viewerState(homePage);
    await selectPage(initial); await viewerState(initial);
    await browserHistory(-1); await viewerState(homePage);
    await browserHistory(-1); await viewerState(initial);
    await browserHistory(1); await viewerState(homePage);
    await ev("document.querySelector('#fr').contentWindow.history.back()"); await viewerState(initial);
    await browserHistory(1); await viewerState(homePage);
    const historyLength = await ev("history.length");
    await ev("document.querySelector('#w button[data-w=split]').click()"); await viewerState(homePage, true);
    expect(await ev("history.length")).toBe(historyLength);
    await selectPage(initial); await viewerState(initial, true);
    await browserHistory(-1); await viewerState(homePage, true);
    await ev("document.querySelector('#fr2').contentWindow.history.back()"); await viewerState(initial, true);
    await browserHistory(1); await viewerState(homePage, true);
    await ev("document.querySelector('#w button[data-w=resp]').click()");
    await until(() => ev("document.querySelector('#fr2').contentWindow.location.href==='about:blank'"));
    expect(await ev("history.length")).toBe(historyLength);
    await browserHistory(-1); await viewerState(initial);
    await ev("document.querySelector('#full-page').click()");
    await until(() => ev(`location.pathname === '/p/'+${JSON.stringify(initial)} && !!document.querySelector('#__cd-return')`));
    expect(await ev(`(() => {
      const rect = document.querySelector('#__cd-return').getBoundingClientRect();
      return [rect.width, rect.height, rect.left, innerHeight - rect.bottom];
    })()`)).toEqual([24, 24, 8, 8]);
    expect(await ev("!!document.querySelector('#fr, script[src=\"/__cd/overlay.js\"]')")).toBe(false);
    await until(() => ev("performance.getEntriesByType('resource').some(r => new URL(r.name).pathname === '/__cd/preview-heartbeat')"));
    put("design/components/ui/Button.tsx", button.replace("Count ", "Full page "));
    await until(async () => {
      const html = await (await fetch(`${base}/p/${initial}`)).text();
      const bundle = html.match(/<script type="module" src="([^"]+)"/)?.[1];
      return bundle && (await (await fetch(base + bundle)).text()).includes("Full page ");
    });
    await Bun.sleep(250); // Allow the viewer's normal file-watcher reload to fire.
    expect(await ev("document.querySelector('button')?.textContent")).toBe("Count 0");
    await cmd("Page.reload");
    await until(() => ev("document.querySelector('button')?.textContent === 'Full page 0'"));
    put("design/components/ui/Button.tsx", button);
    await ev("document.querySelector('#__cd-return').click()");
    await viewerState(initial);
    // Viewer reloads an inline preview after a component edit, preserving the active entry.
    put("design/components/ui/Button.tsx", button.replace("Count ", "Updated "));
    await until(() => ev("document.querySelector('#fr').contentDocument?.querySelector('button')?.textContent==='Updated 0'"));
    put("design/components/ui/Button.tsx", button.replace('return <button', 'throw new Error("Deliberate runtime failure"); return <button'));
    await until(() => ev("document.querySelector('#fr').contentDocument?.querySelector('#__cd-error')?.textContent.includes('Deliberate runtime failure')"));
    put("design/components/ui/Button.tsx", button);
    await until(() => ev("document.querySelector('#fr').contentDocument?.querySelector('button')?.textContent==='Count 0'"));
    // Representative HTML → TSX → HTML fixtures: scalar/default props, named/default content, styles and state.
    const css = 'body{margin:0;font-family:Arial;background:white;color:black} [data-theme=dark] body{background:black;color:white} button{padding:12px}';
    put("design/_head.html", `<style>${css}</style>`);
    put("design/styles.css", css);
    put("design/components/ui/card.html", '<!-- Props: title. Slots: heading, default. --><article><h1>{{title|Hello}}</h1><slot name="heading"></slot><slot></slot></article>');
    const html = '<c-card><span slot="heading">Subtitle</span><button onclick="this.textContent=\'Clicked\'">Save</button></c-card>';
    put("design/pages/Original.html", html); put("design/pages/Roundtrip.html", html);
    put("design/components/ui/Card.tsx", 'import type {ReactNode} from "react"; interface CardProps {title?:string;heading:ReactNode;children:ReactNode} export default function Card({title="Hello",heading,children}:CardProps){return <article><h1>{title}</h1>{heading}{children}</article>}');
    put("design/pages/Converted.tsx", 'import Card from "../components/ui/Card";import {useState} from "react";export default function Page(){const [saved,setSaved]=useState(false);return <Card heading={<span>Subtitle</span>}><button onClick={()=>setSaved(true)}>{saved?"Clicked":"Save"}</button></Card>}');
    for (const width of [390,1280]) for (const theme of ["light","dark"]) {
      await cmd("Emulation.setDeviceMetricsOverride", {width,height:900,deviceScaleFactor:1,mobile:false});
      const captures: string[] = [];
      for (const [mode, page] of [["html","Original.html"],["react","Converted.tsx"],["html","Roundtrip.html"]]) {
        put("design/cdesign.json",JSON.stringify({version:1,mode,tailwind:false})); await Bun.sleep(100);
        await navigate(`/p/design/pages/${page}?raw=1`, "button");
        await ev(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)})`);
        await ev("document.querySelector('button').click()"); await until(() => ev("document.querySelector('button').textContent==='Clicked'"));
        captures.push((await cmd("Page.captureScreenshot", {format:"png"})).data);
      }
      expect(captures[1]).toBe(captures[0]); expect(captures[2]).toBe(captures[0]);
    }
    await navigate("/", "#fr");
    expect(await ev("document.querySelector('.viewer-bar .update-app').hidden")).toBe(true);
    const runtimeSource = readFileSync(runtimeCli, "utf8");
    appendFileSync(runtimeCli, "\nconst = broken;\n");
    await cmd("Page.navigate", { url: `http://localhost:${port}/` });
    await until(() => ev("document.querySelector('#pick .update-app:not([hidden])')?.offsetWidth > 0"));
    await navigate("/#design/pages/Roundtrip.html", "#fr");
    const click = async (selector: string) => {
      const { x, y } = await ev(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    };
    await until(() => ev("document.querySelector('.viewer-bar .update-app:not([hidden])')?.offsetWidth > 0"));
    await click(".viewer-bar .update-app");
    await until(() => ev("document.querySelector('#update-dialog').open && !document.querySelector('.viewer-bar .update-app').disabled"));
    expect(await ev("document.querySelector('#update-message').textContent")).not.toBe("Updating cdesign…");
    await ev("document.querySelector('#update-dialog').close(); window.beforeUpdate = true;");
    await until(() => ev("!document.querySelector('#update-dialog').open && document.querySelector('.viewer-bar .update-app:not([hidden])')?.offsetWidth > 0"));
    writeFileSync(runtimeCli, runtimeSource + "\n// reload browser fixture\n");
    await click(".viewer-bar .update-app");
    await until(() => ev("window.beforeUpdate === undefined && location.hash === '#design/pages/Roundtrip.html' && !!document.querySelector('#fr').contentDocument?.querySelector('button')")).catch(async (error) => {
      const state = await ev("({ beforeUpdate: window.beforeUpdate, url: location.href, message: document.querySelector('#update-message')?.textContent, frame: document.querySelector('#fr')?.src })");
      const daemonState = readFileSync(join(home, "daemon.json"), "utf8");
      const status = await fetch(base + "/__cd/update").then((r) => r.text()).catch(String);
      throw new Error(JSON.stringify({ state, daemonState, status }), { cause: error });
    });
    expect(await ev("document.querySelector('.viewer-bar .update-app').hidden")).toBe(true);
  } finally {
    try {
      const { pid } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
      if (pid !== daemon.pid) process.kill(pid);
    } catch { /* The daemon may have exited already. */ }
    socket?.close(); browser?.kill(); daemon.kill();
    await Promise.all([browser?.exited, daemon.exited]); rmSync(root,{recursive:true,force:true});
  }
}

test.skipIf(!chrome)("browser: pan and zoom on Pages and Flows with mouse, keyboard, wheel and touch", () => runBrowserChecks(true), 60000);
test.skipIf(!chrome)("browser: React hooks, styling, original source comments, reloads, errors, screenshots and conversion parity", () => runBrowserChecks(), 60000);
