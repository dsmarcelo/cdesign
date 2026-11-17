import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const chrome = process.env.CDESIGN_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
const cli = join(import.meta.dir, "../src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
async function until<T>(fn: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(30); }
  throw new Error("Timed out waiting for browser state");
}

test.skipIf(!chrome)("browser: Chat/Files tabs, resize/collapse, Codex send with tool activity, Stop and reload after an agent edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-chat-browser-"));
  const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin"), profile = join(dir, "chrome");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`); chmodSync(join(bin, "codex"), 0o755);
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

    // Chat is selected first; Files is hidden but retained
    const shown = (sel: string) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display!=='none'`);
    expect(await shown("#chat")).toBe(true);
    expect(await shown("#files")).toBe(false);
    expect(await ev("document.querySelector('#tab-chat').getAttribute('aria-selected')")).toBe("true");
    expect(await ev("document.querySelector('.cc-badge').textContent")).toBe("Full access");
    await until(() => ev("document.querySelector('#chat select option')?.textContent==='Codex'"));
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

    // send through fake Codex: streamed reply and expandable tool activity
    await ev("{const t=document.querySelector('#chat textarea');t.value='hello';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("document.querySelector('.cc-msg.message')?.textContent==='Hello from fake Codex' && !document.querySelector('.cc-form button:not(.go)').offsetParent"));
    expect(await ev("document.querySelector('.cc-msg.user').textContent")).toBe("hello");
    expect(await ev("document.querySelector('.cc-tool summary span').textContent")).toBe("ls -la");
    expect(await ev("document.querySelector('.cc-tool').open")).toBe(false);
    await ev("document.querySelector('.cc-tool summary').click()");
    expect(await ev("document.querySelector('.cc-tool').open && document.querySelector('.cc-tool pre').textContent")).toBe("total 0\n");

    // Stop keeps the partial reply
    await ev("{const t=document.querySelector('#chat textarea');t.value='slow task';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from fake Codex' && !!document.querySelector('.cc-form button:not(.go)').offsetParent"));
    await ev("document.querySelector('.cc-form button:not(.go)').click()");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from' && document.querySelector('.cc-note')?.textContent.startsWith('Stopped')"));

    // after a reload the idle snapshot has no turn id: Stop must still work on the next turn
    await cmd("Page.navigate", { url: `http://${projectId(root)}.localhost:${port}/` });
    await until(() => ev("document.readyState==='complete' && !!document.querySelector('#chat textarea') && !!document.querySelector('.cc-msg.user') && document.querySelector('#chat select option')?.textContent==='Codex'"));
    await ev("{const t=document.querySelector('#chat textarea');t.value='slow again';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from fake Codex' && !!document.querySelector('.cc-form button:not(.go)').offsetParent"));
    await ev("document.querySelector('.cc-form button:not(.go)').click()");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='Hello from' && document.querySelector('.cc-note')?.textContent.startsWith('Stopped')"));
    await until(() => ev("!!document.querySelector('#fr').contentDocument?.querySelector('main')"));

    // an agent edit in the project reloads the preview; chat output alone does not
    await ev("document.querySelector('#fr').contentWindow.__marker=1");
    await ev("{const t=document.querySelector('#chat textarea');t.value='please edit';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("document.querySelector('#fr').contentWindow.__marker===undefined"));
    rmSync(join(root, "fake-agent-edit.txt"), { force: true });

    // an unsafe agent reply is shown as text, never run
    await until(() => ev("!document.querySelector('.cc-form button:not(.go)').offsetParent"));
    await ev("{const t=document.querySelector('#chat textarea');t.value='html please';t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}");
    await until(() => ev("[...document.querySelectorAll('.cc-msg.message')].at(-1)?.textContent==='<img src=x onerror=document.title=1>'"));
    expect(await ev("document.querySelectorAll('#chat img').length")).toBe(0);
    expect(await ev("document.title")).toBe("cdesign");
  } finally {
    socket?.close(); browser?.kill(); await browser?.exited;
    daemon.kill(); await daemon.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
