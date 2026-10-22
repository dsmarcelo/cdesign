# cdesign

A lightweight viewer for HTML prototypes, built for coding agents. The agent writes prototypes, you comment on any element in the browser, and the agent receives the comment with the exact file and line to change. The finished prototypes are references another agent can use to build the real code (React, Astro, …).

## How it works

- **Viewer:** `cdesign open` serves your project's `.html` files with live reload, a folder tree, and a comment mode.
- **Element ids:** the server stamps every element with `data-cd-id="line:col"` at serve time. Your files are never modified.
- **Comments to the agent:** a comment carries the file, element id, selector, the element's source and your text. The agent receives it through `cdesign wait`.
- **Skills on demand:** `cdesign open` prints the usage skill and the project context, so nothing is installed per project.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun link
```

## Use

In any project:

```bash
cdesign init     # once: scaffold design/
cdesign open     # start the viewer and print skills + context for the agent
```

Tell your agent to run `cdesign open`. Then in the viewer, press `C`, click an element and press Ctrl+Enter to send.

| Command | What it does |
|---|---|
| `open [dir] [--port n] [--no-browser]` | Start the viewer in the background; print skills and project context |
| `wait [--timeout s]` | Block until a comment arrives, then print it |
| `resolve <id...>` | Mark comments done |
| `comments [--all]` | List pending comments |
| `init [dir]` | Scaffold the `design/` structure |
| `tokens <sub>` | Search, show, set, remove, build and export tokens |
| `check` | Verify tokens and components are defined and documented |
| `skills` | Print the cdesign usage skill |
| `context [dir]` | Print design system, tokens, components and pages |
| `serve [dir]` | Run the viewer in the foreground |

The agent loop is: edit the file, run `cdesign wait`, apply the comment, run `cdesign resolve <id>`, then `cdesign wait` again.

## Project structure

```
design/
  design-system.md        source of truth: tokens, typography, components, rules
  tokens.json             design tokens (source of truth, query with `cdesign tokens`)
  tokens.css              generated from tokens.json
  _head.html              injected into every page's <head> (tokens, fonts, Tailwind)
  pages/                  real app screens, one per .html file
  components/             one component per .html file
  preview/                one page per component: all variants, sizes and states
```

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

## Components

Components are plain HTML fragments in a `components/` folder, resolved by filename and used as `<c-name>` tags.

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
