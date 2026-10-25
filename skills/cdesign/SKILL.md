---
name: cdesign
description: How to prototype in the cdesign viewer: design/ structure, <c-*> components, element comments, review/resolve.
---

# Working with cdesign

Prototypes are references: another agent will later build the real code (React, Astro, ...) from them. Make them faithful and structured so porting is mechanical.

## Structure
- `design/design-system.md`: source of truth (tokens, typography, spacing, components, rules). Read it first. Update it in the same edit as any token/style/component change, then run `cdesign check` (must report "in sync", including a preview for every component).
- `design/tokens.json`: the tokens (color light/dark, type, spacing, radius, size, shadow, fontSize, duration, easing), each with a `usage`. It is large: never read it. `design/tokens.css` is generated from it (never edit). `design/_head.html`: injected into every page's `<head>` (tokens, fonts, Tailwind). Do not repeat these per page.
- `design/pages/*.html`: real app screens only, one per file. Never put component showcases here.
- `design/components/` holds reusable components in three folders: `ui/` (primitives: Button, Input, Select, Dialog), `shared/` (cross-feature: DataTable, SearchBar, FileUpload), `layout/` (Sidebar, Header, PageShell).
- `design/features/<feature>/` holds components specific to one feature (e.g. `features/contracts/contract-table.html`). Promote one to `components/shared/` when a second feature needs it.
- One component per file (fragment, no `<html>`): `button.html`. Its preview lives in a `previews/` folder beside it as `previews/button.preview.html` (a full page; `components/ui/button.html` -> `components/ui/previews/button.preview.html`): every variant x size x state (disabled, invalid, loading, ...) as a labeled matrix built from `<c-button>` tags. Hover, focus and active are checked by interacting. Create or update the preview whenever you create or change a component. Component names are the filename without `.html` and must be unique across all folders.
- `design/prototype/`: work in progress. Build new screens and components there first. When the user seems happy or you consider it done, ASK whether to move it to `components/` (or `features/`) or `pages/`; never move it unasked. On yes: move it, split it into `<c-name>` fragments plus a preview in the sibling `previews/` if it is a component, update design-system.md, run `cdesign check`. Moved files stay editable: when the user asks for changes later, edit them in place without asking again. `cdesign check --fix` moves old side-by-side `.preview.html` files into `previews/`.
- Reuse the project's real tokens/Tailwind classes and mirror its existing components. Never invent values that are not in the design system; add them there first.

## Tokens
- `cdesign open` prints a short digest of token names. Find the right token with `cdesign tokens search <words>` (matches names and usage), or `cdesign tokens show <section> [prefix]`.
- In prototypes use only `var(--color-…)`, `var(--radius-md)`, `var(--space-8)`, `.type-<style>` etc. No hardcoded hex colors or px font sizes/radii (`cdesign check` flags them).
- Add or change tokens only with `cdesign tokens set <section>/<name> --value v [--light v --dark v] --usage "what it is for"` (usage is required) and `cdesign tokens rm`. Never hand-edit tokens.json or tokens.css.
- Do not copy token lists into design-system.md; document rules and patterns there.

## Components
- Use with `<c-name prop="value" class="extra">children</c-name>` (always write the closing tag). `name` is the component filename without `.html`.
- Inside a component: `{{prop}}` or `{{prop|default}}` for props, `<slot></slot>` for children, `<slot name="x">` with `<div slot="x">` for named slots. Variants are just props, e.g. `variant`. No state or logic.
- A component may contain one `<style>` block; the viewer hoists it into `<head>` once, however many instances exist. Style through classes driven by props (`class="btn btn-{{variant|default}}"`), never `{{}}` inside `<style>`.
- Editing a component file updates every page using it. Keep one component per file and give each a clear prop list in design-system.md; this maps 1:1 to a React/Astro component later.

## Comments
- The viewer stamps each element with `data-cd-id="line:col"` (its start tag in its file). Never write `data-cd-id`, `data-cd-file` or `data-cd-use` yourself.
- A comment gives: file, element id, source of the element, the request, and (if inside a component) `used in` = the instance(s). Edit the component file to change all instances, the instance line to change one. Line numbers shift as you edit: re-read before each edit.
- The user adds comments in the viewer, then presses Send to deliver them as one batch. Nothing reaches you before that.
- Receive batches with `cdesign wait` run as a BACKGROUND command (Claude Code: Bash with `run_in_background: true`; never block on it). It exits when the user presses Send, and you are notified with the comments. Apply every one, run `cdesign resolve <id...>` with all the ids, then start `cdesign wait` in the background again. Start it right after `cdesign open`, and keep one running whenever you are idle.
- If you cannot run background commands, run `cdesign review` when the user says they sent comments (it prints the same batch). If it says nothing was sent, ask the user to press Send.
- With the cdesign MCP tools, `review` and `resolve` are tools and `run` takes any other command; `wait` is still a background shell command.

## What the user is looking at
- The viewer reports the page open in its most recently active tab, and the element the user picked with the pointer button (`S`) in the header. When the user is vague ("this page", "change this", "here"), run `cdesign page` (MCP tool `page`) before asking: it prints the page and the selected element (file, `data-cd-id`, selector, source). `open` and `review` print it too.
- If it says cdesign is not open, run `cdesign open`; it reuses a viewer already running for the project (also from a subfolder), so never ask the user for a localhost link.
