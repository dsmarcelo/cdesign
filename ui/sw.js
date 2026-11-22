const OFFLINE_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>cdesign — reconnecting</title>
<style>
  :root{color-scheme:dark light;font:14px/1.5 system-ui,sans-serif}
  body{margin:0;min-height:100dvh;display:grid;place-content:center;gap:12px;padding:24px;text-align:center;background:#000;color:#fafafa}
  @media (prefers-color-scheme:light){body{background:#fff;color:#111}}
  h1{margin:0;font-size:18px;font-weight:600}
  p{margin:0;color:#888;max-width:340px}
  button{justify-self:center;background:transparent;color:inherit;border:1px solid #444;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
</style>
<h1>Reconnecting to cdesign…</h1>
<p>Waiting for the local cdesign server. Run <code>cdesign</code> in a terminal if it is stopped.</p>
<button type="button" onclick="location.reload()">Retry</button>
<script>
  setInterval(() => {
    fetch("/__cd/projects", { cache: "no-store" })
      .then((r) => { if (r.ok) location.reload(); })
      .catch(() => {});
  }, 1500);
</script>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname !== "/") return;
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    })),
  );
});
