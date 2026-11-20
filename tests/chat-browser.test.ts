import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const chrome = process.env.CDESIGN_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
const cli = join(import.meta.dir, "../src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
const claudeFixture = join(import.meta.dir, "fixtures/fake-claude.ts");
async function until<T>(fn: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(30); }
  throw new Error("Timed out waiting for browser state");
}

test.skipIf(!chrome)("browser: Chat/Files tabs, resize/collapse, Codex send with tool activity hidden, Stop and reload after an agent edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-chat-browser-"));
  const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin"), profile = join(dir, "chrome");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`); chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec ${process.execPath} ${claudeFixture} "$@"\n`); chmodSync(join(bin, "claude"), 0o755);
  expect(Bun.spawnSync([process.execPath, cli, "init"], { cwd: root }).exitCode).toBe(0);
  mkdirSync(join(root, "design/pages"), { recursive: true });
  writeFileSync(join(root, "design/pages/Home.tsx"), "export default function Home(){return <main>Home</main>}");
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" }, stdout: "ignore", stderr: "pipe" });
  let browser: ReturnType<typeof Bun.spawn> | undefined, socket: WebSocket | undefined;
  try {
    const { port } = await until(() => existsSync(join(home, "daemon.json")) ? JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) : null);
    browser = Bun.spawn([chrome!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1400,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "pipe" });
    const ws = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Chrome did not start")), 15000);
      (async () => { let buffer = ""; for await (const chunk of browser!.stderr as ReadableStream<Uint8Array>) { buffer += new TextDecoder().decode(chunk); const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); ok(m[1]); return; } } })().catch(fail);
    });
    socket = new WebSocket(ws);
    await new Promise<void>((ok, fail) => { socket!.onopen = () => ok(); socket!.onerror = () => fail(new Error("CDP failed")); });
    let id = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    socket.onmessage = (e) => { const m = JSON.parse(String(e.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket!.send(JSON.stringify({ id: n, method, params, sessionId })); });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cmd = (method: string, params = {}) => send(method, params, sessionId);
    const ev = async (expression: string) => { const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
    await cmd("Page.enable");
    await cmd("Page.navigate", { url: `http://${projectId(root)}.localhost:${port}/` });
    await until(() => ev("document.readyState==='complete' && !!document.querySelector('#chat textarea') && !!document.querySelector('#fr').contentDocument?.querySelector('main')"));

    await cmd("Emulation.setDeviceMetricsOverride", { width: 760, height: 800, deviceScaleFactor: 1, mobile: false });
    expect(await ev("document.querySelector('#mode').getBoundingClientRect().right <= innerWidth")).toBe(true);
    await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
    await ev("document.querySelector('#pl').click()");
    expect(await ev("document.querySelector('#bar').scrollWidth > document.querySelector('#bar').clientWidth && document.querySelector('#project-tools-toggle').offsetHeight >= 44 && document.querySelector('#theme').offsetTop === document.querySelector('#mode').offsetTop")).toBe(true);
    await ev("document.querySelector('#project-tools-toggle').click()");
    expect(await ev("document.querySelector('#project-tools').matches(':popover-open')")).toBe(true);
    await ev("document.querySelector('#tunnel').click()");
    expect(await ev("document.querySelector('#tunnel-dialog').open")).toBe(true);
    await ev("document.querySelector('#tunnel-dialog form button').click()");
    await ev("document.querySelector('#theme').click()");
    expect(await ev("!!document.querySelector('#theme svg')")).toBe(true);
    await ev("document.querySelector('#theme').click(); document.querySelector('#pl').click()");
    await cmd("Emulation.clearDeviceMetricsOverride");
    await until(() => ev("innerWidth > 700 && document.querySelector('#chat').offsetParent !== null"));

    // Chat is selected first; Files is hidden but retained
    const shown = (sel: string) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display!=='none'`);
    expect(await shown("#chat")).toBe(true);
    expect(await shown("#files")).toBe(false);
    expect(await ev("document.querySelector('#tab-chat').getAttribute('aria-selected')")).toBe("true");
    expect(await ev("document.querySelector('.cc-badge').value")).toBe("full"); // new chats start with Full access
    await until(() => ev("document.querySelector('.cc-pick-name')?.textContent.startsWith('Codex')"));
    await ev("{const t=document.querySelector('#chat textarea');t.value='draft stays';t.dispatchEvent(new Event('input'))}");
    await ev("document.querySelector('#tab-files').click()");
    expect(await shown("#files")).toBe(true);
    expect(await shown("#chat")).toBe(false);
    expect(await ev("document.querySelector('#files').textContent.includes('Home')")).toBe(true);
    await ev("document.querySelector('#tab-chat').click()");
    expect(await ev("document.querySelector('#chat textarea').value")).toBe("draft stays");

    // resize by dragging the handle, then collapse/expand with the header button
    const before = await ev("document.querySelector('#lside').getBoundingClientRect().width");
    const hx = await ev("(r=>r.left+r.width/2)(document.querySelector('#lrs').getBoundingClientRect())");
    const mouse = (type: string, x: number) => cmd("Input.dispatchMouseEvent", { type, x, y: 300, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
    await mouse("mousePressed", hx); await mouse("mouseMoved", hx + 80); await mouse("mouseReleased", hx + 80);
    const after = await ev("document.querySelector('#lside').getBoundingClientRect().width");
    expect(after).toBeGreaterThan(before + 40);
    await ev("document.querySelector('#tl').click()");
    expect(await shown("#lside")).toBe(false);
    await ev("document.querySelector('#tl').click()");
    expect(await shown("#lside")).toBe(true);
    expect(await ev("document.querySelector('#chat textarea').value")).toBe("draft stays");

    // Comments live in the left sidebar (no right sidebar); Ctrl+B toggles the sidebar, even while typing in the chat box
    expect(await ev("!document.querySelector('aside.r')")).toBe(true);
    await ev("document.querySelector('#tab-comments').click()");
    expect(await shown("#cm")).toBe(true);
    expect(await shown("#chat")).toBe(false);
    expect(await ev("document.querySelector('#tab-comments').getAttribute('aria-selected')")).toBe("true");
    await ev("document.querySelector('#tab-chat').click()");
    const ctrlB = (target: string) => ev(`document.querySelector(${JSON.stringify(target)}).dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await ev("document.querySelector('#chat textarea').focus()");
    expect(await ctrlB("#chat textarea")).toBe(false); // preventDefault was called
    expect(await shown("#lside")).toBe(false);
    expect(await ev("document.querySelector('#stage').getBoundingClientRect().left")).toBe(0);
    await ctrlB("body");
    expect(await shown("#lside")).toBe(true);

    // send through fake Codex: streamed reply with tool activity hidden
    await ev("{const t=document.querySelector('#chat textarea');t.value='hello';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("document.querySelector('.cc-msg.message')?.textContent==='Hello from fake Codex' && !document.querySelector('.cc-form .stop').offsetParent"));
    expect(await ev("document.querySelector('.cc-msg.user').textContent")).toBe("hello");
    expect(await ev("document.querySelector('.cc-tool') === null")).toBe(true);

    // Stop keeps the partial reply
    await ev("{const t=document.querySelector('#chat textarea');t.value='slow task';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from fake Codex' && !!document.querySelector('.cc-form .stop').offsetParent"));
    await ev("document.querySelector('.cc-form .stop').click()");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from' && document.querySelector('.cc-note')?.textContent.startsWith('Stopped')"));

    // after a reload the idle snapshot has no turn id: Stop must still work on the next turn
    await cmd("Page.navigate", { url: `http://${projectId(root)}.localhost:${port}/` });
    await until(() => ev("document.readyState==='complete' && !!document.querySelector('#chat textarea') && !!document.querySelector('.cc-msg.user') && document.querySelector('.cc-pick-name')?.textContent.startsWith('Codex')"));
    expect(await ev("document.querySelector('.cc-tool') === null")).toBe(true);
    await ev("{const t=document.querySelector('#chat textarea');t.value='slow again';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from fake Codex' && !!document.querySelector('.cc-form .stop').offsetParent"));
    await ev("document.querySelector('.cc-form .stop').click()");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from' && document.querySelector('.cc-note')?.textContent.startsWith('Stopped')"));
    await until(() => ev("!!document.querySelector('#fr').contentDocument?.querySelector('main')"));

    // an agent edit in the project reloads the preview; chat output alone does not
    await ev("document.querySelector('#fr').contentWindow.__marker=1");
    await ev("{const t=document.querySelector('#chat textarea');t.value='please edit';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("document.querySelector('#fr').contentWindow.__marker===undefined"));
    rmSync(join(root, "fake-agent-edit.txt"), { force: true });

    // an unsafe agent reply is shown as text, never run
    await until(() => ev("!document.querySelector('.cc-form .stop').offsetParent"));
    await ev("{const t=document.querySelector('#chat textarea');t.value='html please';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='<img src=x onerror=document.title=1>'"));
    expect(await ev("document.querySelectorAll('#chat img').length")).toBe(0);
    expect(await ev("document.title")).toBe("cdesign");

    // Normal access: approvals appear in the pane, Deny / Allow once reach the agent, mode is locked during a turn
    const type = (text: string) => ev(`{const t=document.querySelector('#chat textarea');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}`);
    const card = "document.querySelector('.cc-approval')";
    const clickCard = (label: string) => ev(`[...${card}.querySelectorAll('button')].find((b)=>b.textContent===${JSON.stringify(label)}).click()`);
    const stopBtn = "document.querySelector('.cc-form .stop')";
    await ev("{const b=document.querySelector('.cc-badge');b.value='normal';b.dispatchEvent(new Event('change'))}");
    await until(() => ev("document.querySelector('.cc-badge').title.startsWith('Normal')"));
    expect(await ev("fetch('/__cd/chat').then((r)=>r.json()).then((s)=>s.conversation.fullAccess)")).toBe(false);
    await type("please ask first");
    await until(() => ev(`!!${card}`));
    expect(await ev(`${card}.textContent`)).toContain("touch fake-codex-approved.txt");
    expect(await ev("document.querySelector('.cc-badge').disabled")).toBe(true);
    await clickCard("Deny");
    await until(() => ev(`!${card} && !${stopBtn}.offsetParent`));
    expect(existsSync(join(root, "fake-codex-approved.txt"))).toBe(false);
    expect(await ev("document.querySelector('.cc-badge').disabled")).toBe(false);
    await type("please ask again");
    await until(() => ev(`!!${card}`));
    await clickCard("Allow once");
    await until(() => ev(`!${card} && !${stopBtn}.offsetParent`));
    expect(existsSync(join(root, "fake-codex-approved.txt"))).toBe(true);

    // another provider starts a fresh conversation; Stop while waiting for permission withdraws the card
    await until(() => ev("(()=>{document.querySelector('.cc-pick').click();const ok=[...document.querySelectorAll('.cc-pmenu .cc-grp')].some((g)=>g.textContent==='Claude');document.querySelector('.cc-pick').click();return ok})()")); // every agent is listed in the model picker
    await ev("document.querySelector('.cc-convs [aria-label=\"New chat\"]').click()");
    expect(await ev("document.querySelector('.cc-badge').value")).toBe("full"); // a new chat starts on Full access even though the last one was Normal
    // pick Claude's default model from the single model list
    await ev("{document.querySelector('.cc-pick').click();const k=[...document.querySelector('.cc-pmenu').children];k.slice(k.findIndex((n)=>n.textContent==='Claude')).find((n)=>n.classList.contains('cc-opt')).click()}");
    expect(await ev("document.querySelector('.cc-pick-name').textContent.startsWith('Claude')")).toBe(true);
    await ev("{const b=document.querySelector('.cc-badge');b.value='normal';b.dispatchEvent(new Event('change'))}");
    await type("please ask first");
    await until(() => ev(`!!${card}`));
    expect(await ev(`${card}.textContent`)).toContain("touch fake-claude-approved.txt");
    expect(await ev("document.querySelectorAll('.cc-msg.user').length")).toBe(1);
    await ev(`${stopBtn}.click()`);
    await until(() => ev(`!${card} && document.querySelector('.cc-note')?.textContent.startsWith('Stopped')`));
    expect(existsSync(join(root, "fake-claude-approved.txt"))).toBe(false);
    await type("please ask again");
    await until(() => ev(`!!${card}`));
    await clickCard("Allow once");
    await until(() => ev(`!${card} && [...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Approved and done'`));
    expect(existsSync(join(root, "fake-claude-approved.txt"))).toBe(true);
  } finally {
    socket?.close(); browser?.kill(); await browser?.exited;
    daemon.kill(); await daemon.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);

test.skipIf(!chrome)("browser: saved chats (new, reopen, rename, delete), a second tab, closing and reopening mid-turn, and a daemon restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-chat-hist-browser-"));
  const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin"), profile = join(dir, "chrome");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`); chmodSync(join(bin, "codex"), 0o755);
  expect(Bun.spawnSync([process.execPath, cli, "init"], { cwd: root }).exitCode).toBe(0);
  mkdirSync(join(root, "design/pages"), { recursive: true });
  writeFileSync(join(root, "design/pages/Home.tsx"), "export default function Home(){return <main>Home</main>}");
  let daemon: ReturnType<typeof Bun.spawn> | undefined, browser: ReturnType<typeof Bun.spawn> | undefined, socket: WebSocket | undefined;
  const start = async () => {
    rmSync(join(home, "daemon.json"), { force: true });
    daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" }, stdout: "ignore", stderr: "pipe" });
    return (await until(() => existsSync(join(home, "daemon.json")) ? JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) : null)).port as number;
  };
  try {
    let port = await start();
    browser = Bun.spawn([chrome!, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1400,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "pipe" });
    const ws = await new Promise<string>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Chrome did not start")), 15000);
      (async () => { let buffer = ""; for await (const chunk of browser!.stderr as ReadableStream<Uint8Array>) { buffer += new TextDecoder().decode(chunk); const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); ok(m[1]); return; } } })().catch(fail);
    });
    socket = new WebSocket(ws);
    await new Promise<void>((ok, fail) => { socket!.onopen = () => ok(); socket!.onerror = () => fail(new Error("CDP failed")); });
    let id = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    socket.onmessage = (e) => { const m = JSON.parse(String(e.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); socket!.send(JSON.stringify({ id: n, method, params, sessionId })); });
    const tab = async () => {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const ev = async (expression: string) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
      const open = async () => { await send("Page.navigate", { url: `http://${projectId(root)}.localhost:${port}/` }, sessionId); await until(() => ev("document.readyState==='complete' && !!document.querySelector('#chat textarea') && document.querySelector('.cc-pick-name')?.textContent.startsWith('Codex')")); };
      return { ev, open, targetId };
    };
    const A = await tab();
    await A.open();
    const type = (t: typeof A, text: string) => t.ev(`{const t=document.querySelector('#chat textarea');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}`);
    const stopShown = (t: typeof A) => t.ev("!!document.querySelector('.cc-form .stop').offsetParent");
    const titles = (t: typeof A) => t.ev("[...document.querySelectorAll('.cc-row .cc-open')].map((o)=>o.textContent)");
    const newChat = (t: typeof A) => t.ev("document.querySelector('.cc-convs [aria-label=\"New chat\"]').click()");
    const row = (t: typeof A, title: string, part: string) => t.ev(`[...document.querySelectorAll('.cc-row')].find((r)=>r.querySelector('.cc-open').textContent===${JSON.stringify(title)}).querySelector('${part}').click()`);

    // two chats; the second keeps working
    await type(A, "hello one");
    await until(async () => (await A.ev("document.querySelector('.cc-msg.message')?.textContent")) === "Hello from fake Codex" && !(await stopShown(A)));
    await newChat(A);
    expect(await A.ev("document.querySelectorAll('.cc-msg').length")).toBe(0);
    await type(A, "slow two");
    await until(async () => (await A.ev("document.querySelector('.cc-msg.message')?.textContent")) === "Hello from fake Codex" ? false : (await stopShown(A)) && !!(await A.ev("document.querySelector('.cc-msg.message')?.textContent")));
    expect(await titles(A)).toEqual(["● slow two", "hello one"]);
    expect(await A.ev("document.querySelector('.cc-title-text').textContent")).toBe("● slow two");

    // a second tab sees the running chat, cannot start another turn, and gets a busy answer pointing at it
    const B = await tab();
    await B.open();
    expect(await stopShown(B)).toBe(true);
    expect(await B.ev("document.querySelector('.cc-msg.user').textContent")).toBe("slow two");
    const busy = await B.ev("fetch('/__cd/chat/send',{method:'POST',body:JSON.stringify({text:'second',provider:'codex'})}).then(async(r)=>({s:r.status,j:await r.json()}))");
    expect(busy.s).toBe(409);
    expect(busy.j.error).toContain("slow two");
    expect(typeof busy.j.activeConversationId).toBe("string");

    // close every viewer mid-turn, reopen: same running chat, partial text not duplicated
    await send("Target.closeTarget", { targetId: B.targetId });
    await send("Target.closeTarget", { targetId: A.targetId });
    const C = await tab();
    await C.open();
    expect(await stopShown(C)).toBe(true);
    expect(await C.ev("document.querySelectorAll('.cc-msg.message').length")).toBe(1);
    expect(await C.ev("document.querySelector('.cc-msg.message').textContent")).toBe("Hello from fake Codex".slice(0, await C.ev("document.querySelector('.cc-msg.message').textContent.length")));
    await C.ev("document.querySelector('.cc-form .stop').click()");
    await until(async () => !(await stopShown(C)));

    // reopen the first chat from the list, then delete it (two clicks on its trash icon; no Rename button exists)
    await C.ev("document.querySelector('.cc-title').click()");
    expect(await C.ev("!document.querySelector('.cc-convs .cc-menu').hidden && [...document.querySelectorAll('.cc-convs button')].every((b)=>b.textContent!=='Rename' && b.textContent!=='Delete')")).toBe(true);
    await row(C, "hello one", ".cc-open");
    await until(() => C.ev("document.querySelector('.cc-msg.user')?.textContent==='hello one'"));
    expect(await C.ev("document.querySelector('.cc-title-text').textContent")).toBe("hello one");
    expect(await C.ev("document.querySelector('.cc-convs .cc-menu').hidden")).toBe(true); // choosing a chat closes the list
    await row(C, "hello one", ".cc-trash");
    expect(await titles(C)).toContain("hello one"); // armed only
    await row(C, "hello one", ".cc-trash");
    await until(async () => !(await titles(C)).includes("hello one"));

    // restart the daemon mid-turn: the chat comes back interrupted, with partial output, and nothing is replayed
    await type(C, "slow three");
    await until(async () => (await stopShown(C)) && !!(await C.ev("document.querySelector('.cc-msg.message')?.textContent")));
    await Bun.sleep(400);
    daemon!.kill("SIGKILL"); await daemon!.exited;
    port = await start();
    const D = await tab();
    await D.open();
    expect(await stopShown(D)).toBe(false);
    expect(await D.ev("document.querySelector('.cc-note').textContent")).toContain("Interrupted");
    expect(await D.ev("document.querySelector('.cc-msg.message').textContent")).toContain("Hello");
    expect(await D.ev("document.querySelectorAll('.cc-msg.user').length")).toBe(2); // both turns of the chat, each once: nothing was replayed
  } finally {
    socket?.close(); browser?.kill(); await browser?.exited;
    daemon?.kill(); await daemon?.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
