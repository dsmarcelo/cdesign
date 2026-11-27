# AGENTS.md

cdesign is a local viewer for React TSX / HTML prototypes with element-level comments that are delivered to coding agents. Runtime is **Bun** (TypeScript, ESM, no build step). See `README.md` for the full CLI and user docs.

## Commands

```bash
bun install                 # full install (devDependencies needed for typecheck)
bun test                    # all tests (36 tests, ~15s)
bun test tests/edit.test.ts # one file
bun run typecheck           # tsc --noEmit over src/*.ts tests/*.ts (no tsconfig.json)
bun src/cli.ts <command>    # run the CLI from the checkout (bin: cdesign -> src/cli.ts)
CDESIGN_SRC=$PWD ./install.sh   # dev install: symlinks ~/.local/share/cdesign to this checkout
```

- **Lint/format:** none configured (no ESLint, Biome or Prettier, no tsconfig). Don't invent a lint step.
- `typecheck` needs `@types/bun`. A `bun install --production` checkout (what `install.sh` does) lacks it and fails with `Cannot find type definition file for 'bun'`; run a plain `bun install` first.
- `tests/browser.test.ts` and `tests/export-browser.test.ts` use `test.skipIf(!chrome)`: they are silently skipped unless Chrome/Chromium is on PATH (`google-chrome`, `chromium`) or `CDESIGN_CHROME` is set. A green run without Chrome does not cover the browser paths.
- Tests create temp projects with `mkdtempSync(tmpdir())`. Tests that spawn the daemon use `serve <root> --port 0` with a throwaway `CDESIGN_HOME` and `CDESIGN_IDLE_SECONDS=300`; follow that pattern so tests never touch the real `~/.cdesign` or port 4747.

## Project structure

```
src/
  cli.ts        entry point and command dispatch (`cmd = process.argv[2]`), daemon lifecycle, `open`/`wait`/`review`/`page`
  server.ts     the single Bun.serve daemon: all projects, comments API, SSE live reload, tunnels (cloudflared/ngrok)
  mcp.ts        MCP stdio server; shells out to cli.ts, so MCP tools mirror CLI commands
  install.ts    registers/removes the MCP server in Claude Code, Codex, agy
  project.ts    design/ scaffolding (`setup`), `design/cdesign.json` config (`readConfig`), `projectFiles`
  modes.ts      React vs HTML mode adapter, page/component listing
  render.ts     HTML mode: parse5 rendering, `<c-name>` components, stamps data-cd-id / data-cd-file
  tsx.ts        React mode: TypeScript-compiler instrumentation that stamps the same ids on JSX
  react.ts      React mode: Bun.build bundling, Tailwind v4 compile (`@tailwindcss/node`)
  previews.ts   inline `Preview` export vs `*.preview.tsx` sidecar resolution
  flows.ts      flows (design/flows/<id>.json) and wireframe/page sync state (design/sync.json): `cdesign flows`, `cdesign sync`, MCP flows/sync
  edit.ts       direct style editing of elements, addressed by file + data-cd-id
  tokens.ts     tokens.json / Tailwind `@theme` tokens: search, show, set, rm, build, export
  context.ts    compact `open` directions and `context` list/find/get/for retrieval
  shot.ts       headless-Chrome screenshots (talks to Chrome over DevTools; `--responsive` = 390/768/1280px)
  export.ts     standalone website export;  publish.ts: deploys an export to a Vercel project (needs `vercel link` and an HTTPS publisher origin)
  store.ts      per-project `.cdesign/` state (comments.json, agent.json heartbeat) and `~/.cdesign` daemon/tunnel files
ui/             viewer front end: index.html (shell), Map.tsx/map.css (Flows canvas, flow bar), Chat.tsx, overlay.js (injected into previews; selection + comments)
skills/         bundled agent skills (cdesign, cdesign-system, cdesign-review, cdesign-convert), printed by `cdesign skills get <name>`
tests/          bun:test suites, one per area
design/         a sample design project (html mode) used by this repo itself; not application code
install.sh / install.ps1   curl-pipe installers (Bun + launcher in ~/.local/bin + MCP registration)
```

`.trail/` and `graft/` are tool caches (repo-map / session data) committed to git; do not hand-edit them.

## Code style

- TypeScript with `type: module`; import local files **without extensions** (`from "./store"`), Node builtins with the `node:` prefix.
- Prefer Bun APIs where the code already does (`Bun.serve`, `Bun.build`, `Bun.spawn`, `Bun.resolveSync`, `Bun.which`).
- Two quoting/formatting styles coexist. `cli.ts`, `server.ts` and most of `src/` use double quotes and 2-space indent; `export.ts`, `publish.ts` and `tests/export*.test.ts` use single quotes and denser one-line blocks. **Match the file you edit**; do not reformat.
- Short `/** ... */` comments explain *why* (invariants, edge cases) rather than restating code; keep that tone.
- Dependencies are minimal (MCP SDK, parse5, postcss, tailwindcss, react, typescript, qrcode-terminal). Don't add one without a strong reason: the installer runs `bun install --production` on the user's machine.
- Tests use `bun:test` and mostly remove their temp dirs in `afterEach` or `finally`; do the same in new tests.

## Gotchas

- **Element ids:** the server stamps `data-cd-id="line:col"` (start tag position in its own source file) and `data-cd-file` at serve time (`render.ts` for HTML, `tsx.ts` for React). User files are never modified. Comments, `edit.ts` and `shot --selected` all address elements this way, so any change to the stamping must keep ids stable across both modes. `export.ts` strips every `data-cd-*` attribute from exported output.
- **One daemon for all projects:** a single process (default port 4747, bound to `127.0.0.1`) serves every project at `http://<id>.localhost:<port>/`; its pid/port/`startedAt` live in `~/.cdesign/daemon.json` (override the home dir with `CDESIGN_HOME`). Requests with an unexpected `Host` get 403 (DNS-rebinding guard). It exits on its own after 2 minutes with no viewer tab and no `cdesign wait` (`CDESIGN_IDLE_SECONDS`).
- **Stale daemon:** `cli.ts` restarts the daemon if any `src/*.ts` mtime is newer than its `startedAt`. After editing `src/` while testing manually, expect the next `open` to respawn it.
- **Never reach the viewer by guessing a URL**; the project folder you run in determines the project. MCP tools use the agent's working directory as the project.
- **Comment lifecycle:** `draft` (viewer) → `queued` (Send) → `sent` (agent ran `cdesign review`) → `done` (`cdesign resolve`). Older files with `status: "open"` are migrated to `draft` on read (`store.ts`). State lives in `<project>/.cdesign/`, which writes its own `*` `.gitignore`.
- **Modes:** `design/cdesign.json` is `{version: 1, mode: "react"|"html", tailwind: boolean}`. New projects default to React + Tailwind; an existing project without config stays HTML. React mode is **TSX only**; React/ReactDOM are resolved from cdesign's own `node_modules` (`react.ts`), not the host project, so previews must use browser-compatible dependencies only.
- **Tailwind:** compiled locally from `design/tailwind.css` (the `@theme` entry); no CDN. Utility class names must appear in source as complete strings or they will not be generated.
- **Tokens:** `design/tokens.json` is huge; query it with `cdesign tokens search|show`, never read it whole. `design/tokens.css` is generated (`tokens set/rm/build`); don't hand-edit.
- **Chrome:** `shot` and the browser tests locate Chrome via `CDESIGN_CHROME`, then `google-chrome`/`chromium`; `shot` throws a clear error if none exists.
- **Export/publish:** `forbidden()` in `export.ts` excludes dot-paths, `prototype/`, `previews/` and `node_modules/` from website exports, and the React build also throws if a dependency pulls one of them in. Website names must match `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
- **Installer:** `install.sh` / `install.ps1` replace `~/.local/share/cdesign`; with `CDESIGN_SRC` it symlinks to a checkout instead, and tracked Bash installs retain their install type on update. Keep both scripts in sync when changing install behaviour.
- **Flows and sync:** arrows exist only in `design/flows/*.json` (never inferred). `design/sync.json` stores per-page content hashes at the last confirmed sync plus explicit `outdated` marks; only marks mean "needs update", hash drift is informational. React pages include `design/wireframe/` (`modes.ts`); exports exclude it (`export.ts`). Wireframe device variants are `name.phone.tsx` / `name.desktop.tsx` siblings (`variantsOf` in `flows.ts`; the sync hash of a wireframe combines its variants); unsuffixed = responsive. Map screens are live iframes at device size scaled with CSS `zoom`, so map captions counter-scale with `--z`. Viewer map routes share the hash with page paths (`#map:flows`, `#flow:<id>`, and legacy `#map:pages`; `isMapHash` in `ui/lib.ts`). The Screens & Components layer uses the active flow’s step references. A step `page` may end in `#state` (`baseFile` in `flows.ts`, `splitState` in `ui/lib.ts`): validation and sync hashes use the file before `#`, the preview iframe gets the state as its URL hash, and the viewer keeps the plain file as the current page. `layoutFlow` in `ui/Map.tsx` lays a flow out as a breadth-first tree growing right; links back to the opener render as ↩ badges, not arrows. Browse the project-wide preview inventory in Files.
- **Skills and README:** the agent-facing guidance in `skills/*/SKILL.md` and the CLI table in `README.md` describe real commands; update them in the same change as the command or flag they document.
