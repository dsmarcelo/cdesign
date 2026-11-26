import { useEffect, useRef, useState } from "react";
import type { TunnelInfo } from "./lib";

export function UpdateDialog({
  dialogRef,
  message,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  message: string;
}) {
  return (
    <dialog id="update-dialog" ref={dialogRef} aria-label="Update cdesign">
      <p id="update-message" role="status">
        {message}
      </p>
      <form method="dialog">
        <button type="submit">Close</button>
      </form>
    </dialog>
  );
}

export function TunnelDialog({
  dialogRef,
  remote,
  tunnel,
  busy,
  busyLabel,
  onAction,
  onCopy,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  remote: boolean;
  tunnel: TunnelInfo | null;
  busy: boolean;
  busyLabel: string;
  onAction: (path: string, label: string) => void;
  onCopy: () => void;
}) {
  const url = tunnel?.url || null;
  const message = busy
    ? busyLabel
    : tunnel?.starting
      ? "Starting tunnel…"
      : tunnel?.error
        ? "Tunnel unavailable: " + tunnel.error
        : url
          ? "Tunnel: "
          : "Tunnel offline";

  return (
    <dialog id="tunnel-dialog" ref={dialogRef} aria-labelledby="tunnel-title">
      <h2 id="tunnel-title">Tunnel</h2>
      <div id="tunnel-status" className="tunnel-status" role="status" aria-live="polite" title={url || message}>
        {message}
        {url && !busy && (
          <a href={url} target="_blank" rel="noopener">
            {url}
          </a>
        )}
      </div>
      <div id="tunnel-actions" hidden={remote} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        <button id="tunnel-copy" type="button" hidden={!url} onClick={onCopy}>
          Copy link
        </button>
        <button
          id="tunnel-start"
          type="button"
          className="go"
          hidden={Boolean(url) || Boolean(tunnel?.starting)}
          disabled={busy}
          onClick={() => onAction("/__cd/tunnel", "Starting tunnel…")}
        >
          Start tunnel
        </button>
        <button
          id="tunnel-restart"
          type="button"
          hidden={!url}
          disabled={busy}
          onClick={() => onAction("/__cd/tunnel/restart", "Restarting tunnel…")}
        >
          Restart tunnel
        </button>
        <button
          id="tunnel-stop"
          type="button"
          hidden={!url}
          disabled={busy}
          onClick={() => onAction("/__cd/tunnel/stop", "Stopping tunnel…")}
        >
          Stop tunnel
        </button>
      </div>
      <form method="dialog">
        <button>Close</button>
      </form>
    </dialog>
  );
}

type WebsiteInfo = {
  name: string;
  pages: string[];
  selected: string[];
  start: string;
  publishing: {
    origin?: string;
    configured: boolean;
    setup: string;
    previous?: { name: string; url: string; publishedAt: string };
  };
};

export function WebsiteDialog({
  openSeq,
  onToast,
}: {
  openSeq: number;
  onToast: (t: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [info, setInfo] = useState<WebsiteInfo | null>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [showCopy, setShowCopy] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!openSeq) return;
    (async () => {
      try {
        const res = await fetch("/__cd/website");
        const data: WebsiteInfo & { error?: string } = await res.json();
        if (!res.ok) throw Error(data.error);
        setInfo(data);
        setName(data.name);
        setSelected(data.selected);
        setStart(data.start || "");
        const prev = data.publishing.previous;
        setStatus(
          prev
            ? "Last published: " + new Date(prev.publishedAt).toLocaleString()
            : data.pages.length
              ? "Choose a starting page, then preview or publish."
              : "No pages found in design/pages."
        );
        setResultUrl(prev?.url ?? null);
        setShowCopy(true);
        dialogRef.current?.showModal();
      } catch (e) {
        onToast(String(e));
      }
    })();
  }, [openSeq]);

  const run = async (action: "export" | "publish") => {
    if (busy || !formRef.current?.reportValidity()) return;
    if (!selected.includes(start)) {
      setStatus("Select the starting page in Pages to include.");
      return;
    }
    setBusy(true);
    setStatus(action === "publish" ? "Building and publishing website…" : "Building website…");
    setResultUrl(null);
    try {
      const res = await fetch("/__cd/website/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), start, pages: selected }),
      });
      const result = await res.json();
      if (!res.ok) throw Error(result.error);
      setResultUrl(result.url);
      setShowCopy(action === "publish");
      setStatus(
        action === "publish"
          ? "Published. Anyone with the link can view this website."
          : "Export ready. This preview is available on this computer; publish to get a shareable link."
      );
      if (action === "publish" && info) {
        setInfo({ ...info, publishing: { ...info.publishing, previous: { name: name.trim(), ...result } } });
      }
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      id="website-dialog"
      ref={dialogRef}
      aria-labelledby="website-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <form
        id="website-form"
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          run("publish");
        }}
      >
        <h2 id="website-title">Export website</h2>
        <label>
          Website name{" "}
          <input
            id="website-name"
            required
            pattern="[a-z0-9][a-z0-9-]*"
            maxLength={63}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Starting page{" "}
          <select id="website-start" required value={start} disabled={busy} onChange={(e) => setStart(e.target.value)}>
            {(info?.pages ?? []).map((p) => (
              <option key={p} value={p} disabled={!selected.includes(p)}>
                {p.replace("design/pages/", "")}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Pages to include</legend>
          <div id="website-pages">
            {(info?.pages ?? []).map((p) => (
              <label key={p}>
                <input
                  type="checkbox"
                  value={p}
                  checked={selected.includes(p)}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.checked ? [...selected, p] : selected.filter((x) => x !== p);
                    setSelected(next);
                    if (!next.includes(start)) setStart(next[0] || "");
                  }}
                />
                {p.replace("design/pages/", "")}
              </label>
            ))}
          </div>
        </fieldset>
        <p id="website-address">
          {(info?.publishing.origin || "https://cdesign-ds.vercel.app") + "/" + name.trim() + "/"}
        </p>
        <p id="website-status" role="status" aria-live="polite">
          {status}
        </p>
        <details id="website-setup" hidden={Boolean(info?.publishing.configured)}>
          <summary>Set up Vercel publishing</summary>
          <p>Link a dedicated shared Vercel project once in your terminal. Replace the origin with its assigned domain.</p>
          <pre id="website-instructions">{info?.publishing.setup ?? ""}</pre>
        </details>
        <p id="website-result" hidden={!resultUrl}>
          <a id="website-open" href={resultUrl ?? undefined} target="_blank" rel="noopener">
            Open website
          </a>{" "}
          <button
            id="website-copy"
            type="button"
            hidden={!showCopy}
            disabled={busy}
            onClick={() =>
              resultUrl &&
              navigator.clipboard
                .writeText(resultUrl)
                .then(() => onToast("Link copied"), () => onToast("Copy the address from Open website"))
            }
          >
            Copy link
          </button>
        </p>
        <footer>
          <button id="website-close" type="button" disabled={busy} onClick={() => dialogRef.current?.close()}>
            Close
          </button>
          <button id="website-preview" type="button" disabled={busy} onClick={() => run("export")}>
            Export &amp; preview
          </button>
          <button
            id="website-publish"
            className="go"
            type="submit"
            disabled={busy || !info?.publishing.configured}
          >
            {info?.publishing.previous?.name === name.trim() ? "Update website" : "Publish website"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

type ShareInfo = {
  configured: boolean;
  setup: string;
  shares: { name: string; page: string; url: string; publishedAt: string }[];
};

export function ShareDialog({
  openSeq,
  cur,
  onToast,
}: {
  openSeq: number;
  cur: string | null;
  onToast: (t: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; spin: boolean }>({ text: "", spin: false });
  const [newUrl, setNewUrl] = useState("");
  const [armedDel, setArmedDel] = useState<string | null>(null);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const page = cur && /^design\/pages\/.+\.(html|tsx)$/.test(cur) ? cur : null;

  const copyUrl = (url: string) =>
    navigator.clipboard.writeText(url).then(
      () => onToast("Link copied"),
      () => {
        urlInputRef.current?.select();
        onToast("Press Ctrl+C to copy the link");
      }
    );

  const refresh = async () => {
    const r = await fetch("/__cd/shares");
    const j = await r.json();
    if (!r.ok) throw Error(j.error);
    setInfo(j);
  };

  useEffect(() => {
    if (!openSeq) return;
    setNewUrl("");
    setStatus({ text: "", spin: false });
    setInfo(null);
    dialogRef.current?.showModal();
    refresh().catch((e) => setStatus({ text: String(e.message || e), spin: false }));
  }, [openSeq]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (e: unknown) {
      setStatus({ text: String((e as Error)?.message || e), spin: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      id="share-dialog"
      ref={dialogRef}
      aria-labelledby="share-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <div id="share-box">
        <h2 id="share-title">Share screen</h2>
        <p id="share-page">
          {page ? "Open screen: " + page.replace("design/pages/", "") : "Open a page from design/pages to share it."}
        </p>
        <div>
          <button
            id="share-create"
            className="go"
            disabled={busy || !page || !info?.configured}
            onClick={() =>
              run(async () => {
                setNewUrl("");
                setStatus({ text: "Building and publishing this screen… usually 10–30 seconds.", spin: true });
                const r = await fetch("/__cd/shares", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ page }),
                });
                const j = await r.json();
                if (!r.ok) throw Error(j.error);
                setNewUrl(j.url);
                setStatus({ text: "Link ready. Anyone with it can view this screen.", spin: false });
                copyUrl(j.url);
                setTimeout(() => urlInputRef.current?.select(), 0);
              })
            }
          >
            Create link for this screen
          </button>
        </div>
        <p id="share-status" role="status" aria-live="polite">
          {status.spin && <span className="spin" />}
          {status.text}
        </p>
        <div id="share-new" hidden={!newUrl}>
          <input
            id="share-url"
            ref={urlInputRef}
            readOnly
            value={newUrl}
            aria-label="Shared link"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button id="share-copy" type="button" onClick={() => copyUrl(newUrl)}>
            Copy link
          </button>
          <a id="share-open" href={newUrl || undefined} target="_blank" rel="noopener">
            <button type="button">Open</button>
          </a>
        </div>
        <details id="share-setup" hidden={!info || info.configured}>
          <summary>Set up Vercel publishing</summary>
          <p>Link a dedicated shared Vercel project once in your terminal.</p>
          <pre id="share-instructions">{info?.setup ?? ""}</pre>
        </details>
        <h3>Shared links</h3>
        <ul id="share-list">
          {!info?.shares.length ? (
            <li>No shared links yet.</li>
          ) : (
            info.shares.map((share) => (
              <li key={share.name}>
                <div className="info">
                  <b title={share.page}>{share.page.replace("design/pages/", "")}</b>
                  <small title={share.url}>
                    {new Date(share.publishedAt).toLocaleString()} · {share.url}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setNewUrl(share.url);
                    copyUrl(share.url);
                  }}
                >
                  Copy
                </button>
                <a href={share.url} target="_blank" rel="noopener">
                  <button type="button" disabled={busy}>
                    Open
                  </button>
                </a>
                <button
                  type="button"
                  className={`del${armedDel === share.name ? " sure" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    if (armedDel !== share.name) {
                      setArmedDel(share.name);
                      if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
                      armedTimerRef.current = setTimeout(() => setArmedDel(null), 4000);
                      return;
                    }
                    if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
                    setArmedDel(null);
                    run(async () => {
                      setStatus({ text: "Deleting link and redeploying… this can take up to a minute.", spin: true });
                      const r = await fetch("/__cd/shares/delete", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ name: share.name }),
                      });
                      const j = await r.json();
                      if (!r.ok) throw Error(j.error);
                      if (newUrl === share.url) setNewUrl("");
                      setStatus({ text: "Link deleted. It is now offline.", spin: false });
                    });
                  }}
                >
                  {armedDel === share.name ? "Click again to delete" : "Delete"}
                </button>
              </li>
            ))
          )}
        </ul>
        <p>Anyone with a link can view that one screen, and it cannot navigate elsewhere. Delete a link to take it offline.</p>
        <footer>
          <button id="share-close" type="button" onClick={() => dialogRef.current?.close()}>
            Close
          </button>
        </footer>
      </div>
    </dialog>
  );
}
