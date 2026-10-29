# cdesign

A lightweight viewer for React TSX and HTML prototypes, built for coding agents. The agent writes prototypes, you comment on any element in the browser, and the agent receives the comment with the exact file and line to change. The finished prototypes are references another agent can use to build the real code (React, Astro, …).

## How it works

- **Viewer:** `cdesign open` serves React TSX pages/previews or HTML files with live reload, a folder tree, and a comment mode.
- **Element ids:** the server stamps every element with `data-cd-id="line:col"` at serve time. Your files are never modified.
- **Comments to the agent:** a comment carries the file, element id, selector, the element's source and your text. Comments stay drafts until you press **Send to agent**, which delivers them all as one batch to an agent running `cdesign wait`.
- **Context on demand:** `cdesign open` returns short directions and the current target. Agents retrieve relevant guidance, component contracts and skills as needed; nothing is installed per project.

## Install

Linux/macOS (bash) and Windows (PowerShell). One command installs Bun if missing, cdesign into `~/.local/share/cdesign`, a `cdesign` launcher in `~/.local/bin`, and registers the MCP server with every agent found (Claude Code, Codex, Antigravity `agy`). Update with `cdesign update` (re-runs the installer).

```bash
curl -fsSL https://raw.githubusercontent.com/dsmarcelo/cdesign/main/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/dsmarcelo/cdesign/main/install.ps1 | iex
```

This creates `%USERPROFILE%\.localin\cdesign.cmd` and adds that folder to your user PATH (open a new terminal afterwards). Dev mode: `$env:CDESIGN_SRC = $PWD; .\install.ps1`.

Register or remove the MCP server later with `cdesign install-mcp [claude|codex|agy|all]` / `cdesign uninstall-mcp`. Dev mode: `CDESIGN_SRC=$PWD ./install.sh` from a checkout links the install to it, so edits apply at once (`cdesign update` switches back to the GitHub version).

## Use

In any project:

```bash
cdesign init     # once: scaffold design/ (React + Tailwind by default)
cdesign open     # start the viewer with compact agent directions
```

Tell your agent to run `cdesign open`. Then in the viewer, press `C`, click elements and add comments (Ctrl+Enter). When you are done, press **Send to agent**. The header shows whether an agent is listening: it is if the agent has `cdesign wait` running in the background, and the batch reaches it in the same conversation. If none is listening, the batch is queued and a prompt is copied for you to paste (the agent then runs `cdesign review`).

| Command | What it does |
|---|---|
| `open [dir] [--port n] [--no-browser] [--tunnel] [--full]` | Open the viewer with compact directions and current page/selection. `--full` opts into the usage skill and legacy inventories. `--tunnel` also shares it over the internet |
| `tunnel [dir]` / `tunnel stop [dir]` | Share the whole viewer (every open project, switchable in the header; `dir` picks the one visitors land on) through a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) quick tunnel. Prints a private link (secret token) |
| `tunnel set --provider ngrok --domain <name.ngrok-free.dev>` / `tunnel set --provider cloudflare --hostname <host> --token <token> [--port n]` | Make `tunnel` use a **fixed domain** (stored in `~/.cdesign/tunnel.json`). The link is just the domain, with no secret: anyone who knows it can view your open projects and send comments to your agent while the tunnel runs. Add `--secret` to require a stable `?t=` secret instead. **ngrok** is the free route: one static domain per free account (install ngrok, run `ngrok config add-authtoken …`, claim the domain at dashboard.ngrok.com > Domains). **cloudflare** needs a domain on your Cloudflare account and a named tunnel whose public hostname points to `http://localhost:<port>` (default 4748). `tunnel show` prints it, `tunnel unset` returns to random quick-tunnel URLs |
| `close [dir] [--all]` | Close the project in the viewer; `--all` stops the viewer for every project |
| `shot [page] [--selected\|--selector css] [--width n] [--theme light\|dark] [--format webp\|jpeg\|png] [--full] [--y n]` | Screenshot a page or one element with headless Chrome (needs Chrome/Chromium; `CDESIGN_CHROME` overrides the path). Small WebP, long side <= 1568px, so agents spend far fewer tokens than with browser screenshots |
| `page` | Print the page open in the viewer (most recently active tab) and the element selected with the pointer button (`S`) |
| `review` | Print the batch the user sent from the viewer (run when asked to apply comments) |
| `wait [--timeout s]` | Run in the background: exits with the batch when you press Send, which wakes the agent |
| `install-mcp` / `uninstall-mcp` | Register / remove the MCP server in Claude Code, Codex and agy |
| `update` | Install the latest version from GitHub |
| `mcp` | MCP server (stdio) that teaches agents how to use cdesign |
| `resolve <id...>` | Mark comments done |
| `comments [--all]` | List pending comments |
| `init [dir]` | Scaffold the `design/` structure |
| `tokens <sub>` | Search, show, set, remove, build and export tokens |
| `check` | Verify tokens and components are defined and documented |
| `skills [get <name>]` | List available skills, or read one |
| `context [list\|find <words>\|get <id>\|for <path>] [--offset n]` | Discover guidance, read a topic/contract, or map direct dependencies. `--full` opts into legacy inventories |
| `serve [dir] [--port n]` | Run the viewer in the foreground (it normally starts by itself) |

## React or HTML mode

New projects default to **React with Tailwind CSS**. First-time terminal setup and the viewer's Add folder flow offer React/HTML and Tailwind/plain CSS choices. Noninteractive setup uses the defaults; MCP `open` accepts `mode` and `tailwind` options.

```bash
cdesign init --mode react --tailwind     # default
cdesign open --mode react --no-tailwind  # React with plain CSS
cdesign init --mode html --no-tailwind   # HTML fragments
```

Choices persist in `design/cdesign.json` (`version: 1`, `mode: "react" | "html"`, `tailwind: boolean`). Reopening preserves them. Existing unconfigured HTML projects retain HTML mode. Explicit flags update settings without converting or deleting source.

React mode supports **TSX only**. Pages in `design/pages/` and experiments in `design/prototype/` must default-export a component. Reusable components live under `design/components/` and `design/features/` and can use named or default exports. Add a named `Preview` export in the same component file: opening that file in cdesign renders the examples, while normal imports still use the reusable component. Imports, typed props, hooks, CSS and local asset imports work. React is bundled by cdesign rather than installed into the host application. Host dependencies must be browser-compatible; framework server features are outside the preview runtime.

```tsx
// design/pages/Home.tsx
import { useState } from "react";
export default function Home() {
  const [count, setCount] = useState(0);
  return <button className="rounded-md p-4" onClick={() => setCount(count + 1)}>
    Clicked {count} times
  </button>;
}
```

```tsx
// design/components/ui/Button.tsx
/** Purpose: Button with explicit example states. */
interface ButtonProps { children: React.ReactNode; disabled?: boolean }

export function Button({ children, disabled }: ButtonProps) {
  return <button disabled={disabled}>{children}</button>;
}

export function Preview() {
  return <div className="flex gap-4 p-8">
    <Button>Save</Button>
    <Button disabled>Disabled</Button>
  </div>;
}
```

`Preview` is an ordinary React component: use hooks, wrappers and providers for realistic examples. It is not a separate reusable component in cdesign's inventory. A separate `previews/Name.preview.tsx` with a default export remains supported for larger showcases or heavy preview-only dependencies. When opening a component, cdesign prefers its inline `Preview`, falls back to its sidecar, or shows a helpful empty state; it never guesses required props. Sidecars remain directly openable. Pages keep using their default export, even if they also export `Preview`. `cdesign context` and `check` recognize either preview format, and selection/comments preserve implementation and preview call-site locations. Same-file imports are part of the component module, so use a sidecar when preview-only dependencies should stay separate.

In Tailwind mode, `design/tailwind.css` is the editable root entry: put tokens in `@theme`, theme overrides and shared rules here. Use utilities and complete variant maps in component TSX; do not create paired component CSS files. Run `cdesign init` once to migrate legacy JSON tokens without overwriting an existing stylesheet. Token search/show reads the stylesheet; edit it directly. Plain CSS mode uses `design/styles.css` and generated `design/tokens.css`. Tailwind utilities (including exported semantic tokens) compile locally when enabled; no CDN or host Tailwind installation is required. Use complete utility names in source. With Tailwind disabled, author ordinary CSS. React component contracts use leading JSDoc and `NameProps` types; context maps direct local imports. JSX annotations are generated from original source locations. Build/runtime errors appear in the preview.

### Convert existing designs

Read `cdesign skills get cdesign-convert` to convert HTML → React TSX or React TSX → HTML. The agent preserves components, assets, tokens, supported behavior and previews, verifies matching screenshots and interactions, and reports unsupported adaptations. Partial conversion leaves the active mode unchanged; whole-project conversion switches it after verification. Original files are retained unless removal is authorized.

`open` scaffolds `design/` if it does not exist yet.

Comment flow: `draft` (in the viewer) → `queued` (Send) → `sent` (agent ran `cdesign review`) → `done` (`cdesign resolve`). The agent is never interrupted: it reads the batch when you tell it to.

## MCP (agents know cdesign without per-project setup)

Register the MCP server once, user-wide, and any agent that starts in any project knows what cdesign is and calls `open` when you mention it (the server's instructions are loaded into the agent). `open` scaffolds `design/` if needed, starts the viewer and returns compact retrieval directions.

`install.sh` does this for you; to redo it, run `cdesign install-mcp`. For other agents, use the command `bun <install dir>/src/cli.ts mcp` in their MCP config. Tools: `open`, `context` (list/find/get/for, with query and offset), `page`, `screenshot` (returns the image directly), `review`, `resolve`, and `run` (any other command, such as `tokens search`). The server uses the working directory the agent was started in as the project.

## One viewer for all projects

A single background process serves every project (default port 4747, localhost only; its address is kept in `~/.cdesign/daemon.json`). Each project has its own address, `http://<project>.localhost:4747/`, and the header has a project switcher (add a folder, close a project). Agents address their own project from the folder they run in, so several agents on several projects do not mix. The process stops by itself after 2 minutes with no viewer tab open and no agent running `cdesign wait` (`CDESIGN_IDLE_SECONDS` changes this), so nothing is left behind; the next `cdesign open` starts it again.

## Project structure (HTML mode)

```
design/
  design-system.md        short entry point: identity, essentials, authority and links
  foundations/            optional focused guidance (color, typography, interaction)
  patterns/               optional guidance (forms, page shells, feedback)
  tailwind.css            Tailwind entry, editable tokens and themes (Tailwind mode)
  tokens.json             plain CSS token source (plain CSS mode)
  tokens.css              generated from tokens.json
  _head.html              injected into every page's <head> (tokens, fonts, Tailwind)
  pages/                  real app screens, one per .html file
  components/
    ui/                   primitives: button.html, input.html, ...
      previews/           button.preview.html, input.preview.html, ...
    shared/               cross-feature: data-table.html, search-bar.html, ...
    layout/               sidebar.html, header.html, page-shell.html, ...
                          (related files get their own folder: sidebar/sidebar.html, sidebar/sidebar-link.html)
  features/
    contracts/            feature-specific: contract-table.html, contract-form.html, ...
      previews/           contract-table.preview.html, ...
    customers/            customer-card.html, customer-filters.html, ...
  prototype/              work in progress; moved to components/ or pages/ once done
```

Every folder keeps its previews in its own `previews/` subfolder. Prototypes start in `prototype/`; when one is done, the agent asks whether to move it to `components/`, `features/` or `pages/`. Moved files stay editable.

Update canonical guidance when shared rules or contracts change; local copy and composition edits need no overview update. Short component contracts live in leading HTML comments (or JSDoc for React TSX). Add longer family guidance only when needed. `cdesign check` accepts documentation across maintained design Markdown and component headers, and checks relative guidance file links (not heading anchors). It checks structure, not semantic agreement or rendered quality.

## Targeted context

```bash
cdesign context                                  # document and component directory
cdesign context get 'design-system#overview'      # identity and essential constraints
cdesign context find form validation              # search maintained guidance and contracts
cdesign context get 'design-system#form-controls' # one section of an existing large file
cdesign context get component/button              # header, props/defaults, slots, source/preview paths
cdesign context for design/pages/home.html        # direct dependencies, without expanding source
```

The MCP `context` tool accepts the same operations as `action`, plus `query` and `offset`. IDs come from discovery results; heading IDs work with existing monolithic files without migration. Quoted IDs preserve `#` in shells. Lists return 20 entries at a time; reads return up to 6,000 characters. Follow the printed continuation command to retrieve more (offsets count entries for lists and characters for reads).

Keep identity, universal constraints and source authority before the first `##` in `design-system.md`; this is the `#overview` topic. Put substantial rules into focused Markdown files when useful and link them from the entry point. Keep related rules together. Component header comments describe the API; optional nearby Markdown explains longer family decisions. Token values remain in `tokens.json`, queried through `tokens` commands.

Discovery excludes imported `reference/`, `references/`, `exported-ds/`, vendor files and previews. Record preferred examples, supported alternatives, experiments and reference freshness in maintained guidance outside those folders. The target map lists direct dependencies and nearby documents, not inferred semantic relevance: search for task-specific patterns as needed.

`cdesign context --full` and `cdesign open --full` explicitly request the old large output. Neither compact startup nor ordinary retrieval dumps whole pages, all skills or token catalogs. Reopening prints the compact directions again; no hidden session cache suppresses necessary context.

## Tokens

For plain CSS and legacy projects, `design/tokens.json` holds the tokens in the Claude Design shape: color (light and dark), type, spacing, radius, size, shadow, fontSize, duration and easing, each with a `usage` note. Drop a file extracted from Claude Design in as is.

Agents query token names, values and usage as needed; `open` does not print the token catalog:

```bash
cdesign tokens search danger border      # names, values and usage of matching tokens
cdesign tokens show size size-row        # one section, optionally by name prefix
cdesign tokens set color/accent-hover --light "#1d4ed8" --dark "#60a5fa" --usage "Hovered primary button"
cdesign tokens rm color/accent-hover
cdesign tokens build                     # regenerate design/tokens.css (set/rm already do it)
```

`design/tokens.css` is generated: light values, dark values through `prefers-color-scheme` and `[data-theme="dark"]`, and `.type-<style>` classes. `cdesign check` flags tokens without a usage, a stale `tokens.css`, and hardcoded colors or px sizes in prototypes.

### Export for the real project

A build agent should never parse `tokens.json`. Export it once into the project:

```bash
cdesign tokens export tailwind -o src/styles/tokens.tailwind.css   # Tailwind v4 (CSS-first)
cdesign tokens export css -o src/styles/tokens.css                 # plain CSS variables
```

- **Tailwind v4** (tested with 4.3): import it after `@import "tailwindcss";`. It defines an `@theme static` block and a `dark:` variant based on `data-theme`, so these utilities work: `bg-background-primary`, `text-foreground-secondary`, `rounded-md`, `shadow-sm`, `ease-standard`, `font-sans`, `text-14`, `h-touch`, plus `type-page-title` for full text styles (`@utility`). The 4px grid is Tailwind's default spacing unit, so `space-16` is `p-4`. Durations are variables: `duration-(--duration-fast)`.
- **Plain CSS:** `:root` variables (`--color-*`, `--radius-md`, `--space-8`, `--duration-fast`, …), dark values via `prefers-color-scheme` and `[data-theme="dark"]`, and `.type-<style>` classes.

## Light and dark

The viewer header has a Light/Dark button, and a button at each end hides or shows the file list (left) and the comments panel (right); both choices are remembered. It sets `data-theme` on the previewed page (remembered across reloads, and it starts from your system theme), so the dark values from `tokens.json` can be reviewed in place.

## Components (HTML mode)

Components are plain HTML fragments under `components/` or `features/`, resolved by filename (unique across folders) and used as `<c-name>` tags. Each has a `previews/<name>.preview.html` in a `previews/` folder beside it showing all variants, sizes and states; `cdesign check` warns when it is missing (`cdesign check --fix` moves old side-by-side previews into `previews/`).

```html
<!-- components/card.html -->
<div class="card"><h3>{{title}}</h3><slot></slot></div>

<!-- pages/home.html -->
<c-card title="Coffee">
  <c-button variant="primary">Buy</c-button>
</c-card>
```

- Props are `{{name}}` or `{{name|default}}`. `<slot>` receives the children, and `<slot name="x">` is filled by `<div slot="x">`. An extra `class` on the tag is appended to the component's root element.
- Editing a component updates every page that uses it. There is no state or logic.
- A comment on an element inside a component reports the component file and every page and line that uses it.
- A component's `<style>` block is hoisted into `<head>` once, however many instances are on the page.
- Pages with `<c-*>` tags only render through the viewer.

## Skills

`cdesign skills` lists bundled skills without loading their bodies:

- `cdesign skills get cdesign`: component syntax, viewer, comments and screenshots.
- `cdesign skills get cdesign-system`: establish source authority and maintain focused guidance/contracts.
- `cdesign skills get cdesign-review`: review alignment, responsive behavior, accessibility and preview coverage.

These teach workflows, not an app-specific visual style. Nothing is installed per project.

## Data

Comments are stored in `<project>/.cdesign/comments.json`. `.cdesign/` holds only local state (comments, screenshots, agent status); cdesign puts a `.gitignore` containing `*` inside it automatically, so nothing there is committed and you don't need to edit your own `.gitignore`.
