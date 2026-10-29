---
name: cdesign
description: Prototype React TSX or HTML interfaces with cdesign components, viewer selections, screenshots and element comments.
---
# Working with cdesign

Prototypes are structured references for later implementation in the app's framework. Preserve the project's identity and choices.

## Retrieve only what the task needs
- `cdesign open` starts/reuses the shared viewer, scaffolds missing design files and returns compact directions. It does not load the system or every skill.
- Read `cdesign context get "design-system#overview"` once, then `context find <words>` for relevant rules. `context` lists document/component IDs; `context get <id>` reads one. Use the printed continuation command when results have more text.
- `context for <project-relative-file>` maps direct component dependencies and nearby documentation without expanding them. For a small edit, begin with the selected component instead of loading the whole page.
- `context get component/<name>` returns header contract, extracted props/defaults, slots, dependencies and preview path. Inspect source when changing implementation. Existing monolithic design systems are indexed by heading; no migration is required.
- Use semantic token variables and type classes instead of hardcoded colors, font sizes and radii.
- Find tokens with `tokens search <words>` or `tokens show <section> [prefix]`. In Tailwind mode query the editable root stylesheet; in plain CSS mode change JSON tokens with `tokens set|rm`.
- Building or maintaining the system: `cdesign skills get cdesign-system`. Reviewing a surface: `cdesign skills get cdesign-review`. Load only the applicable skill.

## Mode and React components
- Read `design/cdesign.json`: new projects default to `{ "version": 1, "mode": "react", "tailwind": true }`. Existing unconfigured HTML projects retain HTML behavior. `cdesign init|open --mode react|html --tailwind|--no-tailwind` persists an explicit choice; changing it does not convert files. CLI interactive setup offers the choices; noninteractive setup uses defaults.
- In React mode author **TSX only**, using imports, typed props and hooks. Default-export page entries in `design/pages/` and `design/prototype/`. Reusable components live in `design/components/{ui,shared,layout}/` or `design/features/` and may use named or default exports; keep contracts in leading JSDoc and types named `NameProps`.
- Prefer a named `export function Preview()` (or `export const Preview`) in the component file, rendering explicit examples of supported variants and states. Opening that file renders `Preview`; normal imports remain unchanged. Hooks, providers and wrappers work. Separate `previews/Name.preview.tsx` files with default exports remain supported for larger showcases or heavy preview-only dependencies. Inline previews take precedence when opening a component; sidecars remain directly openable. Without either, the viewer shows a helpful empty state rather than guessing props. Context and checks recognize both formats.
- React/Tailwind are provided by cdesign. Host project dependencies can be imported when browser-compatible; cdesign uses its own React consistently. Server framework features are not a preview runtime.
- `design/tailwind.css` supplies shared tokens, themes and styles in Tailwind mode. Plain CSS mode uses `design/styles.css` and generated tokens.css. Local CSS and asset imports work. Tailwind utilities and token mappings compile locally when enabled; do not add a CDN runtime or require a host Tailwind install. Plain CSS mode has no Tailwind processing.
- Source selection, comments and screenshots work for TSX. Let the compiler produce `data-cd-*` attributes. Reuse shared components or edit their caller for instance-specific changes.
- For conversion in either direction, read `cdesign skills get cdesign-convert`; preserve originals and verify behavior before switching project mode.

## HTML files and components (HTML mode only)
- `design/_head.html` supplies shared styles, tokens, fonts and responsive variables. Do not repeat them per page.
- `design/pages/` holds app screens; `design/prototype/` holds work in progress. Build new experiments there. Ask before promoting them into pages/components unless the user already authorized promotion. Edit established files in place.
- Reusable fragments live in `design/components/{ui,shared,layout}/`; feature-specific ones in `design/features/<feature>/`. Component names (filenames without `.html`) must be unique. Group related components in a named family folder when useful.
- Use `<c-name prop="value">children</c-name>` with a closing tag. Props substitute `{{prop}}` or `{{prop|default}}`; children use `<slot></slot>` or named slots. These fragments have no template logic or state engine.
- A component's `<style>` is hoisted once. Drive variants with classes such as `btn-{{variant|default}}`; never put template expressions inside CSS.
- Keep the short contract in leading HTML comments. Every component has a sibling `previews/<name>.preview.html`, a full page composed from its `<c-name>` tags covering supported variants, sizes and states. Update affected examples with the component.

## Viewer and comments (both modes)
- For vague references, run `cdesign page` before asking: it gives the most recently active page and selected element. Never request a localhost link when `open` can start the viewer.
- Comments contain the source file, element `data-cd-id`, selector, source snippet and component instance chain. Change the component for every instance, or its caller for one instance. Re-read source before editing because line numbers shift. Never author `data-cd-id`, `data-cd-file` or `data-cd-use`.
- The user presses Send to deliver a batch. When background shell notifications are supported, run `cdesign wait` in the background, apply the received batch, `resolve <ids>`, then start another background wait. Never block on wait. Otherwise use `review` when the user says comments were sent. MCP exposes review/resolve; wait remains a background shell command.
- Verify rendered changes with `cdesign shot [page] --selected` or `--selector`; omit targeting for a page shot. Use `--width` and `--theme dark` when relevant. Tall pages are cropped; use `--y`, a selector or `--full` as needed. MCP screenshot returns the image; CLI prints its saved path. Chrome/Chromium is required.
- Run `cdesign check` after changes. It checks structural consistency, not visual correctness or accessibility.

## Tailwind source and component styling

When Tailwind is enabled, `design/tailwind.css` is the canonical, editable Tailwind v4 entry. Define shared tokens in `@theme` and theme overrides in this file. Query with `cdesign tokens search|show`; edit the stylesheet directly. Do not maintain a parallel tokens.json source. Run `cdesign init` to migrate a legacy JSON project once; an existing tailwind.css is preserved.

Style components with utilities in TSX (or HTML), keeping complete literal class strings in variant and size maps. Do not create a paired CSS file for each component or recreate utilities as semantic CSS selectors. Add custom CSS only for a specific need utilities cannot reasonably express; keep shared rules in the root stylesheet. No CDN runtime or host Tailwind installation is required. Plain CSS projects retain tokens.json and generated tokens.css.

Document each semantic token’s purpose in a CSS comment immediately before its declaration in `design/tailwind.css` (and typography purpose before `@utility type-*`). Include intended surfaces/states, pairings and restrictions. `tokens search|show` searches and returns these notes; theme overrides inherit the base description unless documented separately. Broader usage rules belong in linked foundations/patterns guidance. Before removing legacy token files, verify migration preserved values, light/dark themes, usage notes and typography contracts. Existing root stylesheets are never overwritten: reconcile missing notes manually against the legacy source.
