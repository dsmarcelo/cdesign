import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const chrome = process.env.CDESIGN_CHROME ?? Bun.which("google-chrome") ?? Bun.which("chromium");
const cli = join(import.meta.dir, "../src/cli.ts");
const claudeFixture = join(import.meta.dir, "fixtures/fake-claude.ts");
async function until<T>(fn: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(30); }
  throw new Error("Timed out waiting for browser state");
}

test.skipIf(!chrome)("browser: / lists the agent's commands and skills, /compact and /context show their output, and the chat can be resumed in a terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-cmd-browser-"));
  const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin"), profile = join(dir, "chrome"), log = join(dir, "claude.log");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin); mkdirSync(join(root, "design/pages"), { recursive: true });
  writeFileSync(join(root, "design/pages/Page.html"), "<html><body>\n<h1 class=\"t\">Hi</h1>\n</body></html>");
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "codex"), 0o755); // Codex unusable: this test is about Claude
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec ${process.execPath} ${claudeFixture} "$@"\n`); chmodSync(join(bin, "claude"), 0o755);
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", FAKE_CLAUDE_LOG: log }, stdout: "ignore", stderr: "pipe" });
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
    await cmd("Page.navigate", { url: `http://${projectId(root)}.localhost:${port}/#design/pages/Page.html` });
    await until(() => ev("!!document.querySelector('#chat textarea') && document.querySelector('.cc-pick-name')?.textContent.startsWith('Claude')"));
    const type = (text: string) => ev(`{const t=document.querySelector('#chat textarea');t.focus();t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input'))}`);
    const key = (k: string) => ev(`document.querySelector('#chat textarea').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true}))`);
    const rows = () => ev("[...document.querySelectorAll('#cc-slash .cc-cmd')].map((r) => r.querySelector('b').textContent)");
    const menuOpen = () => ev("!document.querySelector('#cc-slash').hidden");

    // "/" opens the list: built-in commands first, hidden ones (model, internal) absent, skills included
    await type("/");
    await until(async () => (await rows()).length === 4);
    expect(await rows()).toEqual(["/clear", "/compact", "/context", "/ui-design"]);
    // typing narrows it; the highlighted row can be changed and Tab completes it
    await type("/co");
    expect(await rows()).toEqual(["/compact", "/context"]);
    await key("ArrowDown");
    expect(await ev("document.querySelector('#cc-slash .on b').textContent")).toBe("/context");
    await key("Tab");
    expect(await ev("document.querySelector('#chat textarea').value")).toBe("/context ");
    expect(await menuOpen()).toBe(false);
    // a message that is not at the start never opens it
    await type("please run /co");
    expect(await menuOpen()).toBe(false);

    // Enter completes a partial command, and sends one that is typed in full
    await type("/comp");
    await key("Enter");
    expect(await ev("document.querySelector('#chat textarea').value")).toBe("/compact ");
    await type("/context");
    await key("Escape");
    expect(await menuOpen()).toBe(false);
    await key("Enter");
    await until(() => ev("!!document.querySelector('.cc-msg.message')"));
    expect(await ev("document.querySelector('.cc-msg.message table.cc-table th').textContent")).toBe("Category");
    expect(await ev("document.querySelector('.cc-msg.message .cc-h').textContent")).toBe("Context Usage");

    await type("/compact");
    await key("Enter");
    await until(() => ev("!!document.querySelector('.cc-msg.notice[data-status=completed]')"));
    expect(await ev("document.querySelector('.cc-msg.notice').textContent")).toBe("Conversation compacted (41.9k → 11.9k tokens).");
    const prompts = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "user").map((l) => l.message.content);
    expect(prompts()).toEqual(["/context", "/compact"]); // exactly as typed, no design context around them

    // the chat can be continued in the agent's own terminal
    await until(() => ev("!document.querySelector('.cc-convs [aria-label^=Copy]').disabled"));
    await ev("document.querySelector('.cc-convs [aria-label^=Copy]').click()");
    // headless Chrome refuses the clipboard write, and the command is then shown in the note instead: either way the text is the same command
    const note = await until(() => ev("document.querySelector('.cc-note')?.textContent"));
    expect(note).toMatch(/in Claude: cd '.*project' && claude --resume sess-[a-z0-9]+$/);
  } finally {
    socket?.close(); browser?.kill(); daemon.kill();
    await Promise.allSettled([daemon.exited, browser?.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
