# cdesign

A lightweight viewer for HTML prototypes, built for coding agents. The agent writes prototypes, you comment on any element in the browser, and the agent receives the comment with the exact file and line to change. The finished prototypes are references another agent can use to build the real code (React, Astro, …).

## How it works

- **Viewer:** `cdesign open` serves your project's `.html` files with live reload, a folder tree, and a comment mode.
- **Element ids:** the server stamps every element with `data-cd-id="line:col"` at serve time. Your files are never modified.
- **Comments to the agent:** a comment carries the file, element id, selector, the element's source and your text. Comments stay drafts until you press **Send to agent**, which delivers them all as one batch to an agent running `cdesign wait`.
- **Skills on demand:** `cdesign open` prints the usage skill and the project context, so nothing is installed per project.

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
cdesign init     # once: scaffold design/
cdesign open     # start the viewer and print skills + context for the agent
```

Tell your agent to run `cdesign open`. Then in the viewer, press `C`, click elements and add comments (Ctrl+Enter). When you are done, press **Send to agent**. The header shows whether an agent is listening: it is if the agent has `cdesign wait` running in the background, and the batch reaches it in the same conversation. If none is listening, the batch is queued and a prompt is copied for you to paste (the agent then runs `cdesign review`).

| Command | What it does |
|---|---|
| `open [dir] [--port n] [--no-browser]` | Open the project in the viewer (starts the shared viewer process if needed); print skills and project context |
| `close [dir] [--all]` | Close the project in the viewer; `--all` stops the viewer for every project |
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
| `skills` | Print the cdesign usage skill |
| `context [dir]` | Print design system, tokens, components and pages |
| `serve [dir] [--port n]` | Run the viewer in the foreground (it normally starts by itself) |

`open` scaffolds `design/` if it does not exist yet.

Comment flow: `draft` (in the viewer) → `queued` (Send) → `sent` (agent ran `cdesign review`) → `done` (`cdesign resolve`). The agent is never interrupted: it reads the batch when you tell it to.

## MCP (agents know cdesign without per-project setup)

Register the MCP server once, user-wide, and any agent that starts in any project knows what cdesign is and calls `open` when you mention it (the server's instructions are loaded into the agent). `open` scaffolds `design/` if needed, starts the viewer and returns the usage guide.

`install.sh` does this for you; to redo it, run `cdesign install-mcp`. For other agents, use the command `bun <install dir>/src/cli.ts mcp` in their MCP config. Tools: `open`, `page`, `review`, `resolve`, and `run` (any other command, such as `tokens search`). The server uses the working directory the agent was started in as the project.

## One viewer for all projects

A single background process serves every project (default port 4747, localhost only; its address is kept in `~/.cdesign/daemon.json`). Each project has its own address, `http://<project>.localhost:4747/`, and the header has a project switcher (add a folder, close a project). Agents address their own project from the folder they run in, so several agents on several projects do not mix. The process stops by itself after 2 minutes with no viewer tab open and no agent running `cdesign wait` (`CDESIGN_IDLE_SECONDS` changes this), so nothing is left behind; the next `cdesign open` starts it again.

## Project structure

```
design/
  design-system.md        source of truth: tokens, typography, components, rules
  tokens.json             design tokens (source of truth, query with `cdesign tokens`)
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

Keep `design-system.md` in sync with every token, style or component change. `cdesign check` flags what is missing.

## Tokens

`design/tokens.json` holds the tokens in the Claude Design shape: color (light and dark), type, spacing, radius, size, shadow, fontSize, duration and easing, each with a `usage` note. Drop a file extracted from Claude Design in as is.

Agents never read the file. `cdesign open` prints a short digest of names, and they query the rest:

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

## Components

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

`skills/cdesign/SKILL.md` teaches the agent the structure, components and comment loop. `cdesign open` prints it, so nothing is installed per project. Design skills (visual style, taste) are installed separately in the agent itself.

## Data

Comments are stored in `<project>/.cdesign/comments.json`. Add `.cdesign` to the project's `.gitignore`.
