import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const chrome = process.env.CDESIGN_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
const cli = join(import.meta.dir, "../src/cli.ts");
async function until<T>(fn: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(30); }
  throw new Error("Timed out waiting for browser state");
}

test.skipIf(!chrome)("browser: model/effort selectors persist per chat, hostile content stays inert, tool output is bounded, scrolling and keyboard work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-settings-browser-"));
  const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin"), profile = join(dir, "chrome"), codexLog = join(dir, "codex.log");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures/fake-codex.ts")} "$@"\n`); chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "fixtures/fake-claude.ts")} "$@"\n`); chmodSync(join(bin, "claude"), 0o755);
  expect(Bun.spawnSync([process.execPath, cli, "init"], { cwd: root }).exitCode).toBe(0);
  mkdirSync(join(root, "design/pages"), { recursive: true });
  writeFileSync(join(root, "design/pages/Home.tsx"), "export default function Home(){return <main>Home</main>}");
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", FAKE_CODEX_LOG: codexLog }, stdout: "ignore", stderr: "pipe" });
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
    const open = async () => { await cmd("Page.navigate", { url: `http://${projectId(root)}.localhost:${port}/` }); await until(() => ev("document.readyState==='complete' && !!document.querySelector('#chat textarea') && !!document.querySelector('.cc-pick-name')?.textContent && !document.querySelector('.cc-pick-name').textContent.startsWith('Agent')")); };
    await cmd("Page.enable");
    await open();

    const $ = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
    const status = $(".cc-status");
    // the model picker is one list for every agent (grouped by agent) plus the effort chips of the chosen model
    const openPick = () => ev("{const m=document.querySelector('.cc-pmenu');if(m.hidden)document.querySelector('.cc-pick').click()}");
    const models = async (group: string) => { await openPick(); return ev(`(()=>{const out=[];let on=false;for(const n of document.querySelector('.cc-pmenu').children){if(n.classList.contains('cc-grp'))on=n.textContent===${JSON.stringify(group)};else if(on&&n.classList.contains('cc-opt'))out.push(n.textContent)}return out})()`); };
    const efforts = async () => { await openPick(); return ev("[...document.querySelectorAll('.cc-efforts button')].map((b)=>b.textContent)"); };
    const chooseModel = async (group: string, label: string) => { await openPick(); await ev(`(()=>{let on=false;for(const n of document.querySelector('.cc-pmenu').children){if(n.classList.contains('cc-grp'))on=n.textContent===${JSON.stringify(group)};else if(on&&n.textContent===${JSON.stringify(label)})return n.click()}throw new Error('no such model')})()`); };
    const chooseEffort = async (label: string) => { await openPick(); await ev(`[...document.querySelectorAll('.cc-efforts button')].find((b)=>b.textContent===${JSON.stringify(label)}).click()`); };
    const shown = () => ev("document.querySelector('.cc-pick-name').textContent + '|' + document.querySelector('.cc-pick-effort').textContent");
    const type = (text: string) => ev(`{const t=document.querySelector('#chat textarea');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input'));document.querySelector('.cc-form .go').click()}`);
    const users = () => ev("document.querySelectorAll('.cc-msg.user').length");
    /** Sends and waits for that turn (not an earlier one) to finish. */
    const ask = async (text: string) => { const n = await users(); await type(text); await until(async () => (await users()) > n); await done(); };
    const done = () => until(() => ev(`!document.querySelector('.cc-form .stop').offsetParent && ${status}.dataset.state==='completed'`));
    const turns = () => readFileSync(codexLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.method === "turn/start");

    // every agent's models show at once, grouped by agent; a new chat is Full access with a clear empty state
    expect(await models("Codex")).toEqual(["Default (Fake Big)", "Fake Big", "Fake Mini"]);
    expect(await ev("[...document.querySelectorAll('.cc-pmenu .cc-grp')].map((g)=>g.textContent)")).toContain("Claude");
    expect(await efforts()).toEqual(["Default", "Low", "Medium", "High"]);
    expect(await ev(`${status}.textContent`)).toContain("nothing sent");
    expect(await ev("document.querySelector('.cc-badge').value")).toBe("full");
    expect(await ev("document.querySelector('.cc-pick').disabled")).toBe(false);

    // choosing the small model drops the efforts it lacks; the choice reaches Codex on the first turn
    await chooseEffort("High");
    expect(await shown()).toBe("Codex Default (Fake Big)|High");
    await chooseModel("Codex", "Fake Mini");
    expect(await efforts()).toEqual(["Default", "Low"]);
    expect(await shown()).toBe("Fake Mini|"); // "high" is not available there: reset, and told so
    expect(await ev(`${$(".cc-note")}.textContent`)).toContain("went back to the default");
    await chooseEffort("Low");
    await ask("hello");
    expect(turns()[0].params).toMatchObject({ model: "fake-mini", effort: "low" });
    expect(await shown()).toBe("Fake Mini|Low");

    // reopen: the chat restores its own settings; a new chat is back on defaults and Full access
    await open();
    await until(async () => (await shown()) === "Fake Mini|Low");
    await ev("document.querySelector('.cc-convs [aria-label=\"New chat\"]').click()");
    expect(await shown()).toBe("Codex Default (Fake Big)|");
    expect(await ev("document.querySelector('.cc-badge').value")).toBe("full");
    await ev("document.querySelector('.cc-title').click()");
    await ev("[...document.querySelectorAll('.cc-row .cc-open')].find((o)=>o.textContent==='hello').click()");
    await until(async () => (await shown()) === "Fake Mini|Low");

    // another agent's model never edits this chat: it opens a new chat with that agent
    await chooseModel("Claude", "Default");
    expect(await ev("document.querySelectorAll('.cc-msg.user').length")).toBe(0);
    expect(await ev(`${$(".cc-note")}.textContent`)).toContain("new chat with Claude");
    expect((await shown()).startsWith("Claude")).toBe(true);
    await ev("document.querySelector('.cc-title').click()");
    await ev("[...document.querySelectorAll('.cc-row .cc-open')].find((o)=>o.textContent==='hello').click()");
    await until(async () => (await shown()) === "Fake Mini|Low");

    // while the agent works nothing can be changed, and the status says what is happening
    await type("slow one");
    await until(() => ev(`${status}.dataset.state==='streaming'`));
    expect(await ev("document.querySelector('.cc-pick').disabled && document.querySelector('.cc-badge').disabled")).toBe(true);
    await ev("document.querySelector('.cc-form .stop').click()");
    await until(() => ev(`${status}.dataset.state==='stopped'`));
    expect(await ev("document.querySelector('.cc-pick').disabled")).toBe(false);
    expect(await ev("document.querySelector('.cc-form .go').disabled")).toBe(true); // blank prompt: Send disabled

    // hostile markup: formatted where safe, inert everywhere, including while the reply is still streaming
    await ev(`{const w=window; w.__seen={bad:0,max:0}; const log=${$(".cc-log")}; new MutationObserver(()=>{const n=document.querySelectorAll('#chat img,#chat script,#chat iframe,#chat a[href^=javascript],#chat a[href^=data],#chat [onerror]').length; w.__seen.bad=Math.max(w.__seen.bad,n); w.__seen.title=document.title}).observe(document.querySelector('#chat'),{subtree:true,childList:true,attributes:true})}`);
    await ask("markdown please");
    const seen = await ev("window.__seen");
    expect(seen.bad).toBe(0);
    expect(await ev("document.title")).toBe("cdesign");
    const last = "[...document.querySelectorAll('.cc-msg.message')].at(-1)";
    expect(await ev(`${last}.querySelector('strong').textContent`)).toBe("bold");
    expect(await ev(`${last}.querySelectorAll('li').length`)).toBe(2);
    expect(await ev(`${last}.querySelectorAll('li')[1].textContent`)).toBe("<b>two</b>");
    expect(await ev(`${last}.querySelector('pre code').textContent`)).toBe("const a = '<script>document.title=2</script>';");
    expect(await ev(`[...${last}.querySelectorAll('a')].map((a)=>a.href+'|'+a.rel+'|'+a.target)`)).toEqual(["https://example.com/p|noopener noreferrer nofollow|_blank"]);
    expect(await ev(`${last}.textContent.includes('<img src=x onerror=document.title=4>')`)).toBe(true);
    expect(await ev("document.querySelectorAll('#chat img, #chat script, #chat b').length")).toBe(0);
    expect(await ev(`${$(".cc-log")}.scrollWidth <= ${$(".cc-log")}.clientWidth`)).toBe(true); // 400 unbroken characters wrap instead of overflowing

    // tool activity is not shown in the transcript, however long its output; the composer stays on screen
    await ask("longtool run");
    expect(await ev("document.querySelector('.cc-tool') === null")).toBe(true);
    expect(await ev("(()=>{const r=document.querySelector('#chat textarea').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()")).toBe(true);

    // reading older output is not interrupted by new output; "Latest" brings the reader back
    await ev(`${$(".cc-log")}.scrollTop=0`);
    await ev(`${$(".cc-log")}.dispatchEvent(new Event('scroll'))`);
    await ask("hello again");
    expect(await ev(`${$(".cc-log")}.scrollTop`)).toBeLessThan(5);
    expect(await ev(`${$(".cc-jump")}.hidden`)).toBe(false);
    await ev(`${$(".cc-jump")}.click()`);
    expect(await ev(`${$(".cc-log")}.scrollHeight-${$(".cc-log")}.scrollTop-${$(".cc-log")}.clientHeight<40`)).toBe(true);
    expect(await ev(`${$(".cc-jump")}.hidden`)).toBe(true);

    // keyboard: every control has a name and takes focus; Tab leaves the message box; narrow sidebar does not hide the composer or overflow
    expect(await ev("[...document.querySelectorAll('#chat select, #chat button:not([hidden]), #chat textarea')].filter((e)=>e.offsetParent).filter((e)=>!(e.getAttribute('aria-label')||e.textContent.trim())).length")).toBe(0);
    expect(await ev("[...document.querySelectorAll('#chat select, #chat button:not([hidden]), #chat textarea')].filter((e)=>e.offsetParent && !e.disabled).every((e)=>{e.focus();return document.activeElement===e})")).toBe(true);
    await ev("document.querySelector('#chat textarea').focus()");
    await cmd("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    expect(await ev("document.activeElement.id!=='' || document.activeElement.tagName!=='TEXTAREA'")).toBe(true);
    await ev("document.body.style.setProperty('--lw','200px')");
    expect(await ev("(()=>{const c=document.querySelector('#chat');const r=document.querySelector('#chat textarea').getBoundingClientRect();return c.scrollWidth<=c.clientWidth && r.bottom<=innerHeight && r.width>100})()")).toBe(true);
  } finally {
    socket?.close(); browser?.kill(); await browser?.exited;
    daemon.kill(); await daemon.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
