# cdesign

A lightweight viewer for React TSX and HTML prototypes, built for coding agents. The agent writes prototypes, you comment on any element in the browser, and the agent receives the comment with the exact file and line to change. The finished prototypes are references another agent can use to build the real code (React, Astro, …).

## How it works

- **Viewer:** `cdesign open` serves React TSX pages/previews or HTML files with live reload, a folder tree, and a comment mode.
- **Element ids:** the server stamps every element with `data-cd-id="line:col"` at serve time. Your files are never modified.
- **Comments to the agent:** a comment carries the file, element id, selector, the element's source and your text. Comments stay drafts until you press **Send to agent**, which delivers them all as one batch to an agent running `cdesign wait`.
- **Context on demand:** `cdesign open` returns short directions and the current target. Agents retrieve relevant guidance, component contracts and skills as needed; nothing is installed per project.

## Desktop app

cdesign Desktop runs the viewer in a Tauri 2 window on Linux and Windows. Open a project from the project picker, choose **File → Open Folder…**, or pass the project directory as the first argument to the desktop executable. New projects opened from the native menu or executable use the React and Tailwind defaults. Desktop and CLI sessions use the same local daemon and project registry. Tunnel sharing starts only when requested through the viewer or CLI.

From the checkout, run this as your regular user on Arch Linux (x86-64), Debian/Ubuntu, or Fedora:

```bash
./install-desktop.sh
```

On Arch and Arch-based distributions such as CachyOS, the script uses a local package if available, then checks GitHub Releases for a prebuilt package. If there is no release package yet, it builds from source in a temporary directory and removes the build files when it exits. Use `./install-desktop.sh --build` to build the current checkout. Pacman may ask for your sudo password to install dependencies or the finished package.

On Debian/Ubuntu and Fedora, the script uses a local package if available or builds from source. On Windows, run the NSIS setup executable directly or pass it to the script from Git Bash.

You can pass a downloaded package explicitly with `./install-desktop.sh /path/to/package`. The [Desktop installers workflow](https://github.com/dsmarcelo/cdesign/actions/workflows/desktop.yml) produces unsigned Arch, Debian, RPM, and Windows NSIS packages. It also attaches the Arch package to published GitHub releases. Debian, RPM, and Windows packages bundle Bun. The Arch package pulls in system Bun through pacman. Use the CLI installation below to put `cdesign` on PATH and register its MCP server with your coding agents.

### Build from source

Install Bun, stable Rust, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. Use a native Linux GNU or Windows MSVC toolchain.

```bash
bun install --frozen-lockfile
bun run desktop:dev
bun run desktop:build
```

Installers appear under `src-tauri/target/release/bundle/`. The desktop build stages a copy of the runtime. Restart `desktop:dev` to pick up changes to the viewer runtime source.

## CLI installation

Linux/macOS (bash) and Windows (PowerShell). One command installs Bun if missing, cdesign into `~/.local/share/cdesign`, a `cdesign` launcher in `~/.local/bin`, and registers the MCP server with every agent found (Claude Code, Codex, Antigravity `agy`). Update with `cdesign update` (re-runs the installer).

On Linux, the CLI installation also adds a cdesign browser launcher to the applications list. Opening it launches the local project picker in your browser and starts a tunnel automatically. The viewer shows the current tunnel URL or an error; install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the default quick tunnel, or configure a fixed tunnel below. Anyone with the tunnel link can view all open projects and send comments while it is running.

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
| `app` | Open the project picker in a browser and start the tunnel (used by the Linux app launcher) |
| `open [dir] [--port n] [--no-browser] [--tunnel] [--full]` | Open the viewer with compact directions and current page/selection. `--full` opts into the usage skill and legacy inventories. `--tunnel` also shares it over the internet |
| `tunnel [dir]` / `tunnel stop [dir]` | Share the whole viewer (every open project, switchable in the header; `dir` picks the one visitors land on) through a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) quick tunnel. Prints a random link; there is no other authentication, so anyone with the link can view and comment while the tunnel runs |
| `tunnel set --provider ngrok --domain <name.ngrok-free.dev>` / `tunnel set --provider cloudflare --hostname <host> --token <token> [--port n]` | Make `tunnel` use a **fixed domain** (stored in `~/.cdesign/tunnel.json`). The link is just the domain, with no authentication: anyone who knows it can view your open projects and send comments to your agent while the tunnel runs. **ngrok** is the free route: one static domain per free account (install ngrok, run `ngrok config add-authtoken …`, claim the domain at dashboard.ngrok.com > Domains). **cloudflare** needs a domain on your Cloudflare account and a named tunnel whose public hostname points to `http://localhost:<port>` (default 4748). `tunnel show` prints it, `tunnel unset` returns to random quick-tunnel URLs |
| `close [dir] [--all]` | Close the project in the viewer; `--all` stops the viewer for every project |
| `shot [page] [--selected\|--selector css] [--responsive\|--width n] [--theme light\|dark] [--format webp\|jpeg\|png] [--full] [--y n]` | Screenshot a page or one element with headless Chrome; `--responsive` captures mobile (390px), tablet portrait (768px) and desktop (1280px) side by side in one image (needs Chrome/Chromium; `CDESIGN_CHROME` overrides the path). Small WebP, long side <= 1568px, so agents spend far fewer tokens than with browser screenshots |
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

## Chat with a local agent

On a desktop screen the left sidebar has **Chat** (selected first) and **Files** tabs; drag its right edge to resize it and use the header button to collapse it. Comments stay on the right. In Chat, pick an installed agent, type a message and press Enter: the reply streams in, and **Stop** ends the turn while keeping what the agent already said. The agent runs in the exact project folder, so its edits reach the preview through the usual live reload.

- **Codex and Claude.** The selector lists both with their real state (ready, not installed, not logged in, update needed); discovery runs only `--version` and the login-status command, never a model turn. A conversation keeps its agent for good; choose **New** to start one with the other agent. A provider's session is never reused by another provider.
  - **Codex** runs `codex app-server` over stdio JSON-RPC with your existing `codex login`. Tested with codex-cli 0.169.0, which is also the minimum (`thread/start`, `turn/start` with per-turn `approvalPolicy`/`sandboxPolicy`, `turn/interrupt`, command and file-change approval requests).
  - **Claude** runs your installed `claude` CLI in bidirectional stream-json mode (`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --allow-dangerously-skip-permissions`) with your existing Claude login; no SDK and no API key are used. Tested with Claude Code 2.1.326, also the minimum. `--permission-prompt-tool stdio` is required: without it the CLI silently denies anything that needs approval. If the process dies, the next turn restarts it with `--resume <session id>` to keep the context (Codex continues with `thread/resume`).
  - Verified live against both CLIs in a throwaway project: streamed replies, a follow-up that remembered the earlier turn, Allow once, Deny, Stop while a permission request was pending (nothing ran afterwards), and switching Normal/Full between turns.
- **Model and reasoning effort.** Two selectors under the agent choose what the *next* turn uses; each saved chat keeps its own choice (reopening restores it; a new chat starts on the agent's defaults). They are disabled while a turn runs, and the server rejects a change then, or an unsupported value, with the reason instead of ignoring it. Lists come from the installed agent and are never invented:
  - **Codex**: the models and per-model reasoning efforts that `codex app-server` reports (`model/list`), sent as `model`/`effort` on `turn/start`. Hidden models are left out. If the list cannot be read, only "Default" is offered and the reason is shown.
  - **Claude**: Claude Code has no model-listing command, so the supported set is what `claude --help` documents (model aliases such as `opus`/`sonnet`, effort levels `low`…`max`); the pane says so. They are passed as `--model`/`--effort`, so changing them resumes the same saved session in a new process. Claude itself reports an alias/effort pairing it does not accept when the turn starts. If the help text cannot be read, only "Default" is offered.
  - Checked live (codex-cli 0.169.0, Claude Code 2.1.326): Codex listed its real models and efforts, and a turn with a non-default model and effort (`gpt-5.6-luna`, `low`) completed; Claude completed a turn with `--model sonnet --effort low`. Not checked live: switching a Codex chat back to "Default" after a non-default model resumes its thread, and Codex may keep the thread's last model.
- **Access mode** (the selector next to the agent, saved per conversation; a **new chat is always Full access** until you change it, and reopening a chat restores *its* mode, never the last one used anywhere):
  - **Full access**: Codex runs with `approvalPolicy: never` and the `dangerFullAccess` sandbox, Claude with `bypassPermissions`. The agent can read, write and run commands in the project without asking; provider or managed restrictions still apply, and if Claude refuses the switch the turn fails with that reason (choose Normal instead).
  - **Normal**: Codex uses `on-request` with the workspace-write sandbox, Claude its default permission rules. A tool request that needs approval pauses the turn and shows the tool, command or path with **Allow once** and **Deny**. Each answer targets exactly that request of the running turn; stale, duplicate or Stopped requests authorize nothing. **Stop** withdraws pending requests and ends the turn.
  - The mode applies between turns; it is disabled while the agent is working. Questions the agent asks the user (for example Claude's AskUserQuestion, Codex's request_user_input) cannot be answered in the pane: they are declined, shown as an "Unsupported agent request" row, and the turn continues or can be stopped. Nothing is ever approved implicitly.
- **History.** Conversations are saved per project in `.cdesign/chats/` (one JSON file each, gitignored, written atomically). Use the conversation menu above the messages to reopen a chat, **New** for another, **Rename**, or **Delete** (click twice). A saved chat keeps its provider session id, access mode, the messages you sent and the tool activity, and continues **its own** provider session when you send a follow-up, not the most recent CLI session. If the provider can no longer resume it (session expired or removed), the chat shows "could not be resumed… start a new chat"; nothing is resubmitted. Delete removes only cdesign's saved copy: the agent's own history and your project files are untouched.
- **Background operation.** The daemon owns the turn, so closing every viewer tab does not stop it, and it counts as activity: the daemon does not idle out while a turn runs or waits for an approval. Reopening the viewer shows the saved snapshot (including a pending Allow once / Deny request, which only one tab can answer) and then only newer updates. One turn runs per project at a time across all chats and tabs; a second submit gets a message naming the working chat (click it to open), while other projects are unaffected. An idle agent process between turns does not keep the daemon alive.
- **Stop and interruption recovery.** **Stop** ends the turn and keeps the partial output; an agent that ignores it is killed. A running chat cannot be deleted until Stop completes. If the daemon exits while a turn is unfinished (crash, `kill`, reboot, or the automatic restart after you edit cdesign's own source), the chat reopens as **Interrupted** with the partial output kept; stale approvals are discarded and the prompt is never retried: send a follow-up to resume the saved session. A graceful daemon shutdown stops the managed agent processes first. Chat is not available on small screens.
- **Messages.** Your messages are plain text. Agent replies render paragraphs, bullet and numbered lists, `inline code`, **bold**, fenced code blocks (scrollable) and links. Rendering builds DOM text nodes (never HTML), so markup in a reply or prompt is shown literally and cannot run, including while a reply is still streaming; only `http(s)` and `mailto` links are clickable (they open in a new tab with `noopener`), and `javascript:`/`data:` links stay plain text. The transcript shows user messages and agent replies.
- **Status.** A line under the selectors says where the chat stands: *New chat*, *Starting the agent*, *Working*, *Waiting for your approval*, *Done*, *Stopped* (you pressed Stop), *Interrupted* (the daemon restarted), *Failed* (the note below carries the error), or *Working in another chat* (the conversation menu marks the busy chat with ●, and clicking the note opens it). Send is disabled for blank prompts. The view follows new output only while you are at the bottom; if you scrolled up to read, it stays put and a **↓ Latest** button appears. Controls are labeled and keyboard-reachable.
- **Design context.** Above the message box, **chips** show what the agent will receive with the next message: the **Page** open in this tab and the **Element** you selected with the pointer tool (file plus its stable `data-cd-id`, e.g. `design/pages/Page.html 2:1 <h1>`). Both follow the current viewer tab and project, so another tab's selection is never sent; having neither is fine. **×** removes a chip from the next message only; opening another page or selecting another element brings its chip back. A chip whose file was deleted or whose element no longer exists turns red ("file no longer exists" / "element no longer exists") and is not sent until you pick something current. Sending snapshots the chips: the agent gets your text plus a compact block with the file, element id and the element's source snippet (not whole files; `cdesign context for <file>` is named for guidance), the saved message records what was attached, and later navigation does not change it. The server re-validates every reference against the project (paths outside it, missing files and stale ids are refused with the reason and start no turn).
- **Comments in chat.** Undelivered comments (draft or queued) are attached to the composer automatically as comment chips (text, file, element id, snippet); × removes one from that message. **Send** works with an empty message: it then says "Run `cdesign review` and apply the comments I sent in the cdesign viewer." Comments delivered this way become `sent` (so they are not attached again); `cdesign resolve` still marks them done. The comments panel lists newest first, with a collapsed **Done** section.
- Checked live in a throwaway project with page and element context (codex-cli 0.169.0, Claude Code 2.1.326): each agent was asked to change the selected heading, edited only that element, and a follow-up in the same saved conversation answered from the earlier turn.
- Chat is local-only: its history, streams and controls return 403 to shared-tunnel visitors, who keep the preview and comment experience. Send to agent / `cdesign wait` for external agents is unchanged.

## Data

Comments are stored in `<project>/.cdesign/comments.json`. `.cdesign/` holds only local state (comments, screenshots, agent status); cdesign puts a `.gitignore` containing `*` inside it automatically, so nothing there is committed and you don't need to edit your own `.gitignore`.

Tailwind tokens retain their meaning as CSS comments immediately preceding declarations; typography utilities use a preceding comment on `@utility type-*`. For example, `/* Raised surfaces: inputs and sidebar. Pair with foreground-primary. */ --color-background-secondary: #fff;`. `cdesign tokens search|show` includes these notes and searches their text. Theme overrides inherit the base note. `cdesign check` warns about undocumented color tokens and typography utilities. JSON migration preserves usage notes; verify values, themes, descriptions and typography before removing old files. Existing stylesheets are preserved and need manual reconciliation if migrated with an older cdesign version.

## Share one screen

**Share screen** in the viewer toolbar opens a small dialog: **Create link for this screen** publishes only the open page (from `design/pages/`) to the shared Vercel project at an unguessable address (`/s-<random>/`) and shows a spinner until the link is ready, then selects and copies it. Every link you made for the project is listed there with **Copy**, **Open** and **Delete** (click twice to confirm). Deleting redeploys without that screen, so it goes offline.

A shared screen is locked: links to other pages, external links, form submits and `window.open` are blocked, only in-page `#anchors` work, and it is marked `noindex` (the origin also serves `robots.txt` disallowing all). Anyone with the link can still view it until you delete it. It uses the same one-time Vercel setup as publishing and is only available in the local viewer.

## Export and publish a website

Use **Export website** in the viewer toolbar to choose a website name, the pages to include, and a starting page. **Export & preview** builds a standalone website and opens a local preview link. **Publish website** uploads it to the configured shared Vercel project; subsequent updates retain the same address.

```bash
cdesign export --name mapvendas --start design/pages/vendas.tsx --preview
cdesign publish --name mapvendas
# From another directory:
cdesign export /path/to/project --name example --start design/pages/home.html
```

HTML pages are expanded into standalone HTML. React pages are bundled with their browser interactions, shared components, CSS and assets. Pages are discovered under `design/pages/`; `--pages file,file` selects a subset. `design/prototype/`, previews, the viewer and comment tooling are excluded. A dependency on an excluded folder fails the export. Exports are written to `.cdesign/export/`; `--out` accepts another directory outside the source tree. `--preview --port 5000` serves the generated files locally. Website choices persist in `design/cdesign.json`.

The starting page is served at `/<name>/`; other pages retain their path below `pages/`, without the source extension, e.g. `/mapvendas/vendas-lista/`. Existing `location.href`, `location.assign`, `location.replace` and `/p/design/pages/...` navigation are adapted during compilation. Root-relative asset URLs, HTML page links and static JSX asset attributes are rewritten. Dynamic asset URLs and framework-specific routers may need to be made aware of the website prefix. Exports support browser code; backend endpoints are not deployed.

### One-time Vercel setup

Install the Vercel CLI, then link a **dedicated shared project** in a local publisher directory:

```bash
mkdir -p ~/.cdesign/publisher
cd ~/.cdesign/publisher
vercel login
vercel link
cdesign publish setup --project-dir ~/.cdesign/publisher --origin https://cdesign-ds.vercel.app
```

Choose or create the shared project during `vercel link`, and use its actual assigned production domain in `--origin` (`cdesign-ds.vercel.app` is subject to availability). The CLI's existing login is used; cdesign does not store Vercel tokens in project files. Publishing runs locally and is unavailable through viewer tunnels.

Publishing assembles all saved website artifacts and sends only prebuilt static output to Vercel. The publisher folder keeps the last successful artifacts and deployment URLs, serializes publication across processes, and rejects names already used by another local project. Failed builds or deployments keep the previous saved artifacts. Back up this folder: every publication needs the previous websites to preserve them. This workflow supports one publishing computer; it does not synchronize a registry across machines. To roll back a deployment, use Vercel's deployment dashboard.

The public website contains no cdesign sidebar or comments, requires no running local server, and is viewable by anyone with the link when the Vercel production project is public. All websites share an origin; export runtime `getItem`, `setItem`, and `removeItem` storage calls are namespaced per website. Browser mock data remains local to each recipient; this does not add a shared database.
