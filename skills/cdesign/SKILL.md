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

## Folder organization

Group related pages by feature or screen type under design/pages/ (for example, design/pages/settings/). Describe each user flow in design/flows/<id>.json; put other experiments in a named folder under design/prototype/. Group reusable components by family under design/components/ and feature-specific components under design/features/. Use short, descriptive folder names and reuse existing groups.

## Flows (canvas tabs)

The viewer opens on a free canvas. Each tab across the top is one flow; its pages sit on the canvas as live frames the user drags, resizes and arranges freely. **Design** mode selects and comments on elements and moves frames; **Preview** (`P`) makes every frame interactive (scroll, click, type). Opening a frame shows the page by itself (full page); `Esc` returns to the canvas.

**Files**
- `design/pages/**`: the real screens. Put a page in a flow as a frame. For a dialog, sheet, drawer, filter overlay or other state of a page, show it on the page it opens from (see **Page states in the URL hash** below) and point the frame at `page.tsx#state`, e.g. `design/pages/vendas/nova-venda.tsx#venda/cliente`. Only when a component has no host page yet, use its `Preview` export or preview sidecar as the frame's `page`. The **Files** view holds the project-wide preview inventory.
- `design/flows/<id>.json`: one file per tab. `id` = lowercase letters, digits, dashes. The viewer writes `x`, `y`, `w`, `h` when the user moves or resizes a frame, so read the file before editing it and keep positions you did not mean to change:
```json
{ "title": "Nova venda", "description": "Da lista de vendas à confirmação.",
  "frames": [
    { "id": "lista", "title": "Vendas", "page": "design/pages/vendas/lista.tsx", "x": 0, "y": 0, "w": 402, "h": 874 },
    { "id": "cliente", "title": "Selecionar cliente", "page": "design/pages/vendas/nova-venda.tsx#venda/cliente", "x": 482, "y": 0, "w": 402, "h": 874 } ] }
```
  Use existing, project-relative paths. `w`×`h` is the frame's device size (phone 402×874, tablet 768×1024, desktop 1280×800 or 1440×900); the size menu in the canvas toolbar resizes every frame of the tab. Omit `x`/`y` and the frame goes to the right of the others.
- Prefer the CLI over hand edits: `cdesign flows new <id> --title "Nova venda"`, `cdesign flows add <id> <page[#state]> [--title t]` (placed after the last frame, sized like it), `cdesign flows rm <id> <frame|page>`, `cdesign flows show <id>`, `cdesign flows check`. MCP `flows` has the same actions.
- Order frames in reading order (entry screen first, left to right). There are no arrows: the arrangement on the canvas is the flow.

**Page states in the URL hash**
- A frame's `page` may end in `#state`. cdesign validates the file before `#` and loads the frame with that URL hash; it does not open anything itself. The page must read `location.hash` on load (and on `hashchange`/`popstate`) and render the state, otherwise the frame silently shows the plain page and `flows check` still passes.
- Make overlays hash-driven rather than local state: opening one writes the hash (`history.pushState`, so Back closes it), closing removes it. Use segments joined by `/`, innermost last, each `name` or `name=arg`: `#produto=p3/estoque=p3` is the stock dialog over the product sheet. Name states in the product's language, and let a missing arg mean "the first item" so frames need no real ids. Reuse the project's hash-route helper if it has one (look for `location.hash` in `design/components/shared/`); otherwise add one small shared hook and document its format in its header.
- A state opened directly by link must show content: if it needs data the user would have entered first (items in a cart, a customer with addresses), fill sample data when the page opens on that hash with an empty draft. Never write to persistent demo data from a link.
- A nested state implies its parent: `#venda/item` must also show the screen the item editor opens over (for example mobile step 2), with the editor on top.
- Verify every state renders with `cdesign shot page.tsx#state` (add `--width 1280` for desktop) before finishing.

Run `cdesign flows check`, then review the tab in the viewer. The user can select or comment on an element directly on a frame; `cdesign page` returns the selection and the page it came from.

**What to update when**
| You changed | Also update |
|---|---|
| Added a screen to a flow | `flows add <id> <page>`, `flows check` |
| Added a dialog/sheet state | make the page open it from its URL hash, `flows add <id> page.tsx#state`, `shot page.tsx#state` |
| Renamed or moved a page | update every frame that points to it, `flows check` |
| Removed a screen | `flows rm <id> <frame>` |

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
- Comments reach you when the user presses Send in the viewer's chat (see below) or, for an external agent, once they are queued. When background shell notifications are supported, run `cdesign wait` in the background, apply the received batch, `resolve <ids>`, then start another background wait. Never block on wait. Otherwise use `review` when the user says comments were sent. MCP exposes review/resolve; wait remains a background shell command.
- The viewer also has a desktop Chat tab that runs a local Codex or Claude agent in the project (Normal asks the user before risky actions, Full access does not). It is separate from the comment handoff here: chat prompts arrive as ordinary agent turns, not through `wait`/`review`. Chats are saved per project under `.cdesign/chats/` and keep working when the viewer is closed; a turn cut short by a daemon restart is shown as Interrupted and is never retried automatically. The user picks the model and reasoning effort per chat from the agent's reported list (Claude: the aliases and levels in `claude --help`); the choice applies to the next turn only and is rejected, with a reason, while a turn runs or when unsupported. New chats start on Full access. Chat messages can carry the viewer's current page, selected element (file + `data-cd-id`, with its source snippet) and undelivered comments, which are attached automatically when the user presses Send (saving a comment does not start a turn); that context is appended to the prompt together with a guide to apply every comment and run `cdesign resolve <ids>`, and those comments become `sent`. The composer also accepts the agent's own `/commands` and skills (Claude: `/compact`, `/clear`, `/context`, `/ui-design ...`); built-in ones are sent untouched without design context or comments, and a chat's agent session can be reopened in a terminal with `claude --resume <session id>` from the project folder.
- Verify rendered changes with `cdesign shot [page] --selected` or `--selector`; omit targeting for a page shot. **Always check the design at every screen size with one command: `cdesign shot [page] --responsive` (MCP screenshot `responsive:true`): one image with mobile (iPhone 390px), tablet (portrait 768px) and desktop (1280px) side by side; fix layout problems at any size before finishing.** Use `--width` for a single width and `--theme dark` when relevant. Tall pages are cropped; use `--y`, a selector or `--full` as needed. MCP screenshot returns the image; CLI prints its saved path. Chrome/Chromium is required.
- Run `cdesign check` after changes. It checks structural consistency, not visual correctness or accessibility.

## Tailwind source and component styling

When Tailwind is enabled, `design/tailwind.css` is the canonical, editable Tailwind v4 entry. Define shared tokens in `@theme` and theme overrides in this file. Query with `cdesign tokens search|show`; edit the stylesheet directly. Do not maintain a parallel tokens.json source. Run `cdesign init` to migrate a legacy JSON project once; an existing tailwind.css is preserved.

Style components with utilities in TSX (or HTML), keeping complete literal class strings in variant and size maps. Do not create a paired CSS file for each component or recreate utilities as semantic CSS selectors. Add custom CSS only for a specific need utilities cannot reasonably express; keep shared rules in the root stylesheet. No CDN runtime or host Tailwind installation is required. Plain CSS projects retain tokens.json and generated tokens.css.

Document each semantic token’s purpose in a CSS comment immediately before its declaration in `design/tailwind.css` (and typography purpose before `@utility type-*`). Include intended surfaces/states, pairings and restrictions. `tokens search|show` searches and returns these notes; theme overrides inherit the base description unless documented separately. Broader usage rules belong in linked foundations/patterns guidance. Before removing legacy token files, verify migration preserved values, light/dark themes, usage notes and typography contracts. Existing root stylesheets are never overwritten: reconcile missing notes manually against the legacy source.
