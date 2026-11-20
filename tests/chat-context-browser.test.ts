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

test.skipIf(!chrome)("browser: comments stack in the composer, Send delivers them with the guide, and the preview reloads after the agent edits it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-ctx-browser-"));
  const root = join(dir, "project"), home = join(dir, "home"), bin = join(dir, "bin"), profile = join(dir, "chrome"), log = join(dir, "codex.log");
  mkdirSync(root); mkdirSync(home); mkdirSync(bin); mkdirSync(join(root, "design/pages"), { recursive: true });
  writeFileSync(join(root, "design/pages/Page.html"), "<html><body>\n<h1 class=\"t\">Hi</h1>\n<p>Body</p>\n</body></html>");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`); chmodSync(join(bin, "codex"), 0o755);
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", FAKE_CODEX_LOG: log }, stdout: "ignore", stderr: "pipe" });
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
    await until(() => ev("!!document.querySelector('#chat textarea') && !!document.querySelector('#fr').contentDocument?.querySelector('h1[data-cd-id]')"));
    const chips = () => ev("[...document.querySelectorAll('.cc-chip')].map((c) => c.dataset.type + ':' + c.querySelector('span').textContent)");

    // the open page is a chip on its own; nothing selected yet is fine
    await until(async () => (await chips()).length === 1);
    expect(await chips()).toEqual(["page:design/pages/Page.html"]);

    // select the heading in the preview: an element chip appears with file and stable id
    await ev("document.querySelector('#sel').click()");
    await ev("document.querySelector('#fr').contentDocument.querySelector('h1').click()");
    await until(async () => (await chips()).some((c: string) => c.startsWith("selection:")));
    expect((await chips()).find((c: string) => c.startsWith("selection:"))).toBe("selection:design/pages/Page.html 2:1 <h1>");

    // removing the element chip drops only that chip
    await ev("document.querySelector('.cc-chip[data-type=selection] button').click()");
    expect((await chips()).map((c: string) => c.split(":")[0])).toEqual(["page"]);

    // A project-wide comment update from outside this tab stays a draft.
    const base = `http://${projectId(root)}.localhost:${port}`;
    const made = await (await fetch(`${base}/__cd/comments`, { method: "POST", body: JSON.stringify({ file: "design/pages/Page.html", cdId: "2:1", selector: "h1.t", text: "Larger heading" }) })).json() as any;
    await until(async () => (await chips()).some((c: string) => c.startsWith("comment:")));
    expect((await chips()).filter((c: string) => c.startsWith("comment:")).length).toBe(1);
    expect((await (await fetch(`${base}/__cd/comments`)).json() as any[]).find((c) => c.id === made.id).status).toBe("draft");

    // Saving a comment in the preview only stacks it in the composer: nothing is sent until Send is pressed.
    await ev("{const t=document.querySelector('#chat textarea');t.value='Please do these';t.dispatchEvent(new Event('input'));document.querySelector('#mode').click()}");
    const addComment = async (text: string) => {
      await ev("{const d=document.querySelector('#fr').contentDocument;d.querySelector('h1').click();d.querySelector('.__cd-pop textarea').value=" + JSON.stringify(text) + ";d.querySelector('.__cd-pop .go').click()}");
    };
    await addComment("design-edit now");
    const comments = () => fetch(`${base}/__cd/comments`).then((r) => r.json()) as Promise<any[]>;
    await until(() => chips().then((c: string[]) => c.filter((x) => x.startsWith("comment:")).length === 2));
    const tops = await ev("[...document.querySelectorAll('.cc-chip[data-type=comment]')].map((c) => c.offsetTop)") as number[];
    expect(new Set(tops).size).toBe(2); // one comment per row
    await Bun.sleep(300);
    const prompts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.method === "turn/start") : [];
    expect(prompts()).toHaveLength(0);
    expect((await comments()).every((c) => c.status === "draft")).toBe(true);
    expect(await ev("document.querySelector('#chat textarea').value")).toBe("Please do these");

    // Send delivers every stacked comment with the guide to apply them and mark them done.
    await ev("document.querySelector('.cc-form .go').click()");
    await until(() => prompts().length === 1);
    const delivered = (await comments()).find((c) => c.text === "design-edit now");
    const prompt = prompts()[0].params.input[0].text as string;
    expect(prompt).toStartWith("Please do these");
    expect(prompt).toContain(`Comment ${delivered.id} on design/pages/Page.html at 2:1`);
    expect(prompt).toContain(`Comment ${made.id} on design/pages/Page.html at 2:1`);
    expect(prompt).toContain(`cdesign resolve ${made.id} ${delivered.id}`);
    expect((await comments()).map((c) => c.status)).toEqual(["sent", "sent"]);
    await until(() => ev("document.querySelector('#fr').contentDocument?.querySelector('h1')?.textContent==='Edited'"));
    await until(async () => !(await (await fetch(`${base}/__cd/chat`)).json() as any).busy);
    expect(await chips().then((c: string[]) => c.filter((x) => x.startsWith("comment:")))).toEqual([]);

    // With no message typed, the comments alone are enough.
    await addComment("Use the brand color");
    await until(() => chips().then((c: string[]) => c.some((x) => x.includes("Use the brand color"))));
    await ev("document.querySelector('.cc-form .go').click()");
    await until(() => prompts().length === 2);
    expect(prompts()[1].params.input[0].text).toStartWith("Apply the attached comments.");
    expect(prompts()[1].params.input[0].text).toContain("Use the brand color");
  } finally {
    socket?.close(); browser?.kill(); daemon.kill();
    await Promise.allSettled([daemon.exited, browser?.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
