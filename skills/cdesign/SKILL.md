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

Group related pages by feature or screen type under design/pages/ (for example, design/pages/settings/). Put lo-fi wireframes under design/wireframe/ (grouped like the pages) and describe each user flow in design/flows/<id>.json; put other experiments in a named folder under design/prototype/. Group reusable components by family under design/components/ and feature-specific components under design/features/. Use short, descriptive folder names and reuse existing groups.

## Flows, wireframes and sync

Build **wireframes** and **pages** in the same **Flows** canvas. Use the **Wireframes** or **Screens & Components** toggle to review each layer. `M` switches between the canvas and an opened file.

**Files**
- `design/wireframe/**.tsx|html`: lo-fi screens (grayscale boxes, real control shapes, skeleton text). They are prototypes: render, select and comment on them like any page. Group them like the pages (`design/wireframe/vendas/…`).
  - **Devices.** A wireframe can exist for phone, desktop or both. One unsuffixed file (`cliente.tsx`) is responsive and is shown on both. For separate layouts add siblings `cliente.phone.tsx` and `cliente.desktop.tsx` (point the flow step at either one; the other is found automatically). There are no tablet wireframes. The map draws each screen at real device size (phone 402×874, iPhone 18; desktop 1280×800) and has a Phone/Desktop toggle; a screen missing on the chosen device falls back to the other one, labeled "Phone only"/"Desktop only".
  - **Fill the viewport.** The map already draws the device frame. A wireframe must render the screen itself edge to edge (`min-h-screen w-full`), never its own phone bezel, fixed `w-[390px]` box, rounded device border or gray page padding around it.
- `design/pages/**`: the real screens. Link finished screens using each flow step’s `page` field. Include only the screens and component states used in that journey. For a dialog, sheet, drawer, filter overlay or other state of a page, show it on the page it opens from (see **Page states in the URL hash** below) and point the step at `page.tsx#state`, e.g. `design/pages/vendas/nova-venda.tsx#venda/cliente`. Only when a component has no host page yet, use its `Preview` export or preview sidecar as the step's `page`. The **Files** view holds the project-wide preview inventory.
- `design/flows/<id>.json`: one file per user flow. `id` = lowercase letters, digits, dashes. Define each navigation arrow as a link in this file:
```json
{ "title": "Nova venda", "description": "Da lista de vendas à confirmação.",
  "steps": [
    { "id": "lista", "title": "Vendas", "wireframe": "design/wireframe/vendas/lista.tsx" },
    { "id": "pedido", "title": "Revisar pedido", "wireframe": "design/wireframe/vendas/pedido.tsx" },
    { "id": "registrou", "decision": "Venda registrada?" },
    { "id": "confirmacao", "title": "Venda registrada", "wireframe": "design/wireframe/vendas/confirmacao.tsx" },
    { "id": "cliente", "title": "Selecionar cliente", "wireframe": "design/wireframe/vendas/cliente.tsx", "page": "design/pages/vendas/nova-venda.tsx#venda/cliente" } ],
  "links": [
    { "from": "lista", "to": "pedido", "label": "Nova venda" },
    { "from": "pedido", "to": "registrou", "label": "Registrar" },
    { "from": "pedido", "to": "cliente", "label": "Cliente" },
    { "from": "cliente", "to": "pedido", "label": "Selecionar", "dashed": true },
    { "from": "registrou", "to": "confirmacao", "label": "Sim" },
    { "from": "registrou", "to": "pedido", "label": "Não · Tentar novamente", "dashed": true } ] }
```
  A screen step has a `wireframe`, a `page`, or both. Use existing, project-relative paths. Use `decision` for a question and label its outgoing links with the outcomes.

**Page states in the URL hash**
- A step's `page` may end in `#state`. cdesign validates and hashes the file before `#` and loads the preview with that URL hash; it does not open anything itself. The page must read `location.hash` on load (and on `hashchange`/`popstate`) and render the state, otherwise the step silently shows the plain page and `flows check` still passes.
- Make overlays hash-driven rather than local state: opening one writes the hash (`history.pushState`, so Back closes it), closing removes it. Use segments joined by `/`, innermost last, each `name` or `name=arg`: `#produto=p3/estoque=p3` is the stock dialog over the product sheet. Name states in the product's language, and let a missing arg mean "the first item" so flow steps need no real ids. Reuse the project's hash-route helper if it has one (look for `location.hash` in `design/components/shared/`); otherwise add one small shared hook and document its format in its header.
- A state opened directly by link must show content: if it needs data the user would have entered first (items in a cart, a customer with addresses), fill sample data when the page opens on that hash with an empty draft. Never write to persistent demo data from a link.
- A nested state implies its parent: `#venda/item` must also show the screen the item editor opens over (for example mobile step 2), with the editor on top.
- Each `page#state` is its own sync pair. Verify every state renders with `cdesign shot page.tsx#state` (add `--width 1280` for desktop) before finishing.
- The wireframe of a dialog or sheet step draws the screen it opens over, dimmed, with the dialog on top, so both layers read the same way.

- `design/sync.json`: written by `cdesign sync`; never edit it by hand. It stores, per page, the content hashes of the pair when it was last confirmed in sync, and explicit `outdated` marks with notes. Commit it with the design.

**Authoring a flow layout**

- The canvas grows to the right as a tree: each screen's destinations sit in the next column, stacked top to bottom in link order, with the screen centred beside them and joined by elbow arrows. A screen sits next to the first screen (breadth-first from the entry step) that links to it.
- List the entry screen first. For each step, list its links in the order you want the destinations stacked.
- Give each detour (dialog, sheet, editor) its own step linked from the screen that opens it. Link back to that screen when it closes: a link back to the opener shows as a ↩ badge on the screen instead of a second arrow. Links between sibling screens bend around the right of their column; any other return or skip runs in a lane above the flow. Mark every return and retry link `"dashed": true`.
- A screen opened from several places is drawn once, next to the opener closest to the entry; link the others to it as usual.
- Use short labels that explain the action or outcome at a glance.
- Run `cdesign flows check`, then open **Flows** and use **Fit** to review the whole journey on the supported devices. The screens are live previews. Select or comment on an element directly on the canvas. Use `cdesign page` to retrieve the selection and the page it came from.

**Sync rules**
- A wireframe change does **not** require a page change: wireframes are a prototype until the user decides to build or update the page. Do not touch the page unless asked.
- "Changed since last sync" (hash drift) is informational. Only explicit **outdated** marks mean "this file must be updated".
- After you change one side of a pair, decide whether the other side must follow. If yes (or the user says so), mark the side that is now behind: `cdesign sync outdated <that file> --note "what must change"`. If it is a pure prototype exploration, leave it.
- After you bring a pair in line (page updated from its wireframe, or the wireframe updated to match a shipped page), run `cdesign sync done <either file>`: it records both hashes and clears the marks on both sides. `cdesign sync clear <file>` drops a mark without confirming sync (the user decided not to apply it).
- When the user asks what needs syncing / updating / is outdated, run `cdesign sync` (MCP `sync`) and answer from it: marked outdated first (with notes), then pairs changed since last sync, never-synced pairs, and wireframes without a page yet. `cdesign sync --json` gives the raw pairs. `cdesign flows show <id>` gives one flow with each step's state; `cdesign page` also prints the open file's flow, counterpart and sync state.

**What to update when**
| You changed | Also update |
|---|---|
| Added a screen to a flow | create its wireframe, add the step and its links in `design/flows/<id>.json`, `flows check` |
| Added a dialog/sheet step | make the page open it from its URL hash, point the step at `page.tsx#state`, `flows check`, `shot page.tsx#state` |
| A wireframe | nothing required; if the page must follow, `sync outdated <page> --note …` |
| A page built from a wireframe | set the step's `page`, then `sync done <page>` once it matches |
| A page (shipped behavior changed) | if the wireframe should reflect it, `sync outdated <wireframe> --note …` |
| Renamed or moved a wireframe/page | update every flow step that points to it, `flows check`, then `sync done` if the pair is still aligned |
| Removed a screen | remove its step and links from the flow |

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
