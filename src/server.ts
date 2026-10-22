import { watch, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { renderPage, snippetFor } from "./render";
import { dataDir, listening, readComments, update, type Comment } from "./store";

const UI = join(import.meta.dir, "..", "ui");
const SKIP = new Set(["node_modules", ".git", ".cdesign", "dist"]);

export function listHtml(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listHtml(root, p, out);
    else if (name.endsWith(".html") && !name.startsWith("_")) out.push(relative(root, p).split(sep).join("/"));
  }
  return out.sort();
}

export function serve(root: string, port = 0) {
  const clients = new Set<ReadableStreamDefaultController>();
  const enc = new TextEncoder();
  const push = (ev: string) => {
    for (const c of clients) {
      try {
        c.enqueue(enc.encode(`data: ${ev}\n\n`));
      } catch {
        clients.delete(c);
      }
    }
  };

  setInterval(() => push("ping"), 15000); // keep SSE connections alive

  let ct: Timer | undefined;
  mkdirSync(dataDir(root), { recursive: true });
  let on = false;
  const presence = () => {
    const now = listening(root);
    if (now !== on) ((on = now), push("agent"));
  };
  setInterval(presence, 3000); // a killed `wait` stops beating: notice it going stale
  watch(dataDir(root), (_e, f) => {
    if (f === "agent.json") return presence();
    if (f !== "comments.json") return; // CLI edits (wait/resolve) reach the viewer too
    clearTimeout(ct);
    ct = setTimeout(() => push("comments"), 50);
  });

  let t: Timer | undefined;
  watch(root, { recursive: true }, (_e, f) => {
    if (!f || f.split(sep).some((s) => SKIP.has(s))) return;
    clearTimeout(t);
    t = setTimeout(() => push("reload"), 80);
  });

  const json = (v: unknown, status = 200) => Response.json(v, { status });

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = decodeURIComponent(url.pathname);

      if (p === "/") return new Response(Bun.file(join(UI, "index.html")));
      if (p === "/__cd/overlay.js") return new Response(Bun.file(join(UI, "overlay.js")));
      if (p === "/__cd/files") return json(listHtml(root));

      if (p === "/__cd/events") {
        let ctrl!: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            clients.add(c);
            c.enqueue(enc.encode(": hi\n\n"));
          },
          cancel() {
            clients.delete(ctrl);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }

      if (p === "/__cd/agent") return json({ listening: listening(root) });

      if (p === "/__cd/comments" && req.method === "GET") return json(readComments(root));

      if (p === "/__cd/comments" && req.method === "POST") {
        const b = (await req.json()) as Pick<Comment, "file" | "cdId" | "selector" | "text"> & { uses?: string[] };
        if (!b.file || !b.cdId || !b.text?.trim()) return json({ error: "file, cdId, text required" }, 400);
        let snippet = "";
        try {
          snippet = snippetFor(await Bun.file(join(root, b.file)).text(), b.cdId);
        } catch {}
        const c: Comment = {
          id: Math.random().toString(36).slice(2, 8),
          file: b.file,
          cdId: b.cdId,
          uses: b.uses ?? [],
          selector: b.selector ?? "",
          snippet,
          text: b.text.trim(),
          status: "draft",
          createdAt: new Date().toISOString(),
        };
        update(root, (l) => l.push(c));
        push("comments");
        return json(c, 201);
      }

      if (p === "/__cd/send" && req.method === "POST") {
        let n = 0;
        update(root, (l) => l.forEach((c) => c.status === "draft" && ((c.status = "queued"), n++)));
        push("comments");
        return json({ queued: n });
      }

      const m = p.match(/^\/__cd\/comments\/([^/]+)\/(done|open|delete)$/);
      if (m && req.method === "POST") {
        update(root, (l) => {
          const i = l.findIndex((c) => c.id === m[1]);
          if (i < 0) return;
          if (m[2] === "delete") l.splice(i, 1);
          else l[i].status = m[2] === "open" ? "draft" : "done";
        });
        push("comments");
        return json({ ok: true });
      }

      // project files (previews live under /p/, bare paths work for absolute asset urls)
      const rel = p.startsWith("/p/") ? p.slice(3) : p.slice(1);
      const abs = resolve(root, rel);
      if (!abs.startsWith(root + sep) && abs !== root) return new Response("forbidden", { status: 403 });
      const f = Bun.file(abs);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      if (abs.endsWith(".html") && p.startsWith("/p/")) {
        const html = renderPage(root, rel);
        const tag = `<script src="/__cd/overlay.js"></script>`;
        const body = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + "</body>") : html + tag;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      return new Response(f, { headers: { "cache-control": "no-store" } });
    },
  });

  mkdirSync(dataDir(root), { recursive: true });
  writeFileSync(join(dataDir(root), "server.json"), JSON.stringify({ port: server.port, pid: process.pid }));
  return server;
}
