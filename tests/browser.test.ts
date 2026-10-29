import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test.skipIf(!chrome)("browser: React hooks, styling, original source comments, reloads, errors, screenshots and conversion parity", async () => {
  const root = mkdtempSync(join(tmpdir(), "cdesign-browser-"));
  const home = join(root, ".cdesign/home"), profile = join(root, ".cdesign/chrome");
  mkdirSync(home, {recursive: true});
  const put = (file: string, body: string) => { mkdirSync(dirname(join(root, file)), {recursive: true}); writeFileSync(join(root, file), body); };
  const init = Bun.spawnSync([process.execPath, cli, "init"], {cwd: root}); expect(init.exitCode).toBe(0);
  const button = '/** Purpose: Stateful button. */\nimport {useState} from "react";\nexport default function Button(){ const [n,setN]=useState(0); return <button className="p-4 bg-red-500" onClick={()=>setN(n+1)}>Count {n}</button>}\nexport function Preview(){const [wide,setWide]=useState(false);return <section style={{padding:wide?32:8}}><input type="checkbox" onChange={()=>setWide(!wide)}/><Button/><Button/></section>}';
  put("design/components/ui/Button.tsx", button);
  put("design/pages/Home.tsx", 'import Button from "../components/ui/Button"; export default function Home(){return <main><Button/><Button/></main>}');
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {env: {...process.env, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300"}, stdout: "ignore", stderr: "pipe"});
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
    // Viewer reloads an inline preview after a component edit, preserving the active entry.
    await navigate("/", "#fr");
    await until(() => ev("!!document.querySelector('#fr').contentDocument?.querySelector('button')"));
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
  } finally {
    socket?.close(); browser?.kill(); daemon.kill();
    await Promise.all([browser?.exited, daemon.exited]); rmSync(root,{recursive:true,force:true});
  }
}, 60000);
