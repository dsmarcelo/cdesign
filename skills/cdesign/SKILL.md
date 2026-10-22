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
- `design/components/*.html`: one component per file (fragment, no `<html>`).
- `design/preview/<component>.html`: one page per component, same name as the component, showing every variant x size x state (disabled, invalid, loading, ...) as a labeled matrix built from `<c-name>` tags. Hover, focus and active are checked by interacting. Create or update the preview whenever you create or change a component.
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
- When the user asks you to apply the comments (or says they sent them): run `cdesign review`, apply every comment in the batch, then `cdesign resolve <id...>` with all the ids it printed. If it says nothing was sent, ask the user to press Send.
- Optional: `cdesign wait` blocks until a batch is sent, if you want to stay in a loop.
