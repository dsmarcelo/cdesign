import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../src/store";

const cli = join(import.meta.dir, "../src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/fake-codex.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const PAGE = "design/pages/Page.html";
const HTML = "<html><body>\n<h1 class=\"t\">Hi</h1>\n<p>Body</p>\n</body></html>";

/** Throwaway project (one HTML page) + daemon on port 0 with a fake `codex` that logs what it receives. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "cdesign-ctx-"));
  const home = join(dir, "home"), root = join(dir, "project"), bin = join(dir, "bin"), log = join(dir, "codex.log");
  mkdirSync(home); mkdirSync(bin); mkdirSync(join(root, "design/pages"), { recursive: true });
  writeFileSync(join(root, PAGE), HTML);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300", FAKE_CODEX_LOG: log },
    stdout: "ignore", stderr: "pipe",
  });
  cleanups.push(async () => { daemon.kill(); await daemon.exited; rmSync(dir, { recursive: true, force: true }); });
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) { try { port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await Bun.sleep(50); } }
  expect(port).toBeGreaterThan(0);
  const base = `http://127.0.0.1:${port}`, id = projectId(root);
  const url = (p: string) => `${base}/__cd/${p}${p.includes("?") ? "&" : "?"}project=${id}`;
  const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
  const until = async <T,>(fn: () => Promise<T> | T, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(25); }
    throw new Error("timed out");
  };
  /** Pretend a viewer tab is on `file` with `cdId` selected, exactly like ui/index.html and overlay.js report it. */
  const tab = async (tabId: string, file: string | null, cdId?: string) => {
    await post("page", { tabId, file });
    if (cdId) await post("selection", { tabId, selection: { file, cdId, uses: [], selector: "h1.t", tag: "h1", text: "Hi" } });
  };
  const chips = async (tabId: string) => (await fetch(url(`chat/context?tab=${tabId}`))).json() as Promise<any>;
  const prompts = () => { try { return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === "turn/start").map((m) => m.params.input[0].text as string); } catch { return []; } };
  const idle = () => until(async () => !(await (await fetch(url("chat"))).json() as any).busy);
  const send = async (body: object) => { const r = await post("chat/send", { provider: "codex", ...body }); if (r.ok) await idle(); return r; };
  const snap = async () => (await fetch(url("chat"))).json() as Promise<any>;
  const page = async (file: string) => (await fetch(`${base}/p/${file}?project=${id}`)).text();
  return { root, page, url, post, tab, chips, prompts, send, snap, until };
}

test("chips follow each tab's page and selection; tabs and unknown tabs do not leak", async () => {
  const b = await boot();
  expect(await b.chips("nobody")).toEqual({ page: null, selection: null }); // nothing open is a valid state
  await b.tab("a", PAGE, "2:1");
  await b.tab("b", PAGE);
  expect(await b.chips("a")).toMatchObject({ page: { file: PAGE, state: "ok" }, selection: { file: PAGE, cdId: "2:1", tag: "h1", state: "ok" } });
  expect((await b.chips("b")).selection).toBeNull();
  await b.tab("a", null); // navigating away clears that tab's selection too
  expect(await b.chips("a")).toEqual({ page: null, selection: null });
});

test("chips report a deleted file and a stale element as recoverable states", async () => {
  const b = await boot();
  await b.tab("a", PAGE, "2:1");
  writeFileSync(join(b.root, PAGE), "<html><body>\n</body></html>"); // the element is gone
  expect((await b.chips("a")).selection.state).toBe("stale");
  rmSync(join(b.root, PAGE));
  const c = await b.chips("a");
  expect(c.page.state).toBe("missing");
  expect(c.selection.state).toBe("missing");
});

test("send snapshots the page and element for the agent and the saved message; removed chips send nothing", async () => {
  const b = await boot();
  const r = await b.send({ text: "make it blue", context: { page: { file: PAGE }, selection: { file: PAGE, cdId: "2:1" } } });
  expect(r.status).toBe(202);
  const [prompt] = b.prompts();
  expect(prompt.startsWith("make it blue")).toBe(true);
  expect(prompt).toContain(`Open page: ${PAGE}`);
  expect(prompt).toContain(`Selected element: ${PAGE} at 2:1\n`);
  expect(prompt).toContain('<h1 class="t">Hi</h1>');
  expect(prompt).not.toContain("<p>Body</p>"); // only the element, not the whole file
  const s = await b.snap();
  const user = s.conversation.items.find((i: any) => i.kind === "user");
  expect(user.text).toBe("make it blue");
  expect(user.context.map((c: any) => c.kind)).toEqual(["page", "element"]);

  // chips removed: the page chip is gone, so only the selection travels; nothing at all sends the bare text
  await b.send({ text: "just text", conversationId: s.conversation.id });
  expect(b.prompts()[1]).toBe("just text");
  // later navigation never touches the message already sent
  await b.tab("a", null);
  expect((await b.snap()).conversation.items.find((i: any) => i.kind === "user").context).toHaveLength(2);
});

test("context is validated against this project: foreign, missing and stale references are refused and start nothing", async () => {
  const b = await boot();
  for (const context of [
    { page: { file: "../../etc/passwd" } },
    { page: { file: "design/pages/Gone.html" } },
    { selection: { file: "../x.html", cdId: "1:1" } },
    { selection: { file: PAGE, cdId: "99:9" } },
    { selection: { file: PAGE, cdId: "nope" } },
    { comments: ["zzzzzz"] },
  ]) {
    const r = await b.post("chat/send", { provider: "codex", text: "hi", context });
    expect([400, 409]).toContain(r.status);
    expect((await r.json() as any).error).toBeTruthy();
  }
  expect(b.prompts()).toEqual([]);
  expect((await b.snap()).conversations).toEqual([]);
});

test("comments reach the agent only when added, once, and the external lifecycle is untouched", async () => {
  const b = await boot();
  const made = await (await b.post("comments", { file: PAGE, cdId: "2:1", selector: "h1.t", text: "Make the heading bigger" })).json() as any;
  await b.send({ text: "plain message" });
  expect(b.prompts()[0]).toBe("plain message"); // an unresolved comment is not included by itself

  const r = await b.send({ text: "apply this", conversationId: (await b.snap()).conversation.id, context: { comments: [made.id, made.id] } });
  expect(r.status).toBe(202);
  const prompt = b.prompts()[1];
  expect(prompt).toContain(`Comment ${made.id} on ${PAGE} at 2:1: "Make the heading bigger"`);
  expect(prompt.split("Make the heading bigger").length).toBe(2); // not duplicated
  const user = (await b.snap()).conversation.items.filter((i: any) => i.kind === "user")[1];
  expect(user.context).toHaveLength(1);

  const after = (await (await fetch(b.url("comments"))).json() as any[]).find((c) => c.id === made.id);
  expect(after.status).toBe("draft"); // not queued, sent or resolved by chat
  expect((await (await b.post("send", {})).json() as any).queued).toBe(1); // Send to agent still works
});

test("an agent's design edit reloads the preview, and the edit is reversible", async () => {
  const b = await boot();
  const events = await fetch(b.url("events"));
  const reader = events.body!.getReader();
  let seen = "";
  const pump = (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; seen += dec.decode(value); } })();
  const html = () => b.page(PAGE);
  expect(await html()).toContain(">Hi<");
  await b.send({ text: "design-edit", context: { page: { file: PAGE }, selection: { file: PAGE, cdId: "2:1" } } });
  await b.until(() => seen.includes("data: reload"));
  expect(await html()).toContain(">Edited<");
  seen = "";
  await b.send({ text: "design-revert", conversationId: (await b.snap()).conversation.id });
  await b.until(() => seen.includes("data: reload"));
  expect(await html()).toContain(">Hi<");
  await reader.cancel(); await pump.catch(() => {});
});
