---
name: cdesign-system
description: Establish, document or maintain a cdesign design system, its source authority, reusable patterns and component contracts.
---
# Build and maintain a design system

Inspect the existing system and relevant implementation before proposing rules. Capture the user's established identity; do not impose a font, palette, component style or directory taxonomy from another app.

## Discover authority
Use `cdesign context` and `context find <topic>` to locate maintained guidance. Read `design-system#overview` and relevant sections. Read `design/cdesign.json` for mode and styling. Inspect shared setup (`design/styles.css` for React; `design/_head.html` for HTML), token usages via `tokens search`, component contracts and representative previews as needed.

Record which source governs tokens, shared behavior and visual decisions. When app components, design-tool libraries, exported mockups and prototypes disagree, record the conflict and freshness; do not overwrite newer decisions by importing an older reference. Link existing product/domain documentation rather than copying it.

## Organize for retrieval
- Keep `design/design-system.md` a short entry point: identity, universal constraints, source authority and links to focused guidance. Put essential rules before the first `##` so `design-system#overview` retrieves them together.
- Split substantial guidance into `design/foundations/*.md` (semantic color, typography, geometry, interaction) and `design/patterns/*.md` (forms, shells, feedback) when useful. Keep tightly coupled rules together, including responsive sizing and composition. Do not create empty topic files.
- Give each rule one canonical home and link it elsewhere. Prose explains token meaning and application; exact values live in design/tailwind.css for Tailwind projects, or tokens.json for plain CSS projects.
- Keep concise component contracts in leading JSDoc for React TSX, with typed `NameProps`, or leading HTML comments for HTML mode: `Purpose:`, `Props:` with defaults and supported values, `Slots:`, plus relevant states, accessibility and dependencies. Extraction can find typed props/defaults and imports in TSX, or template props and slots in HTML but cannot infer the full API or behavior.
- Prefer same-file named `Preview` exports for React component examples, covering supported variants, sizes and interactive states. Separate default-export `previews/Name.preview.tsx` files remain supported for larger showcases or preview-only dependencies. Inline previews take precedence when opening a component; HTML preview conventions are unchanged.
- Add longer Markdown guidance beside a component family only when it conveys decisions that the header/source does not. Avoid a duplicate Markdown API for every component.
- Label preferred examples, supported alternatives, experiments and imported references in linked guidance. Do not infer preference from version numbers or modification time. `design/reference/`, `design/references/`, `exported-ds/`, vendor runtimes and previews are excluded from guidance discovery; document pointers and authority in maintained Markdown outside them.
- Use relative Markdown links for maintained documents and examples. `cdesign check` checks local file targets; it does not validate heading anchors or prove semantic agreement.

## Change without accumulating prose
When a shared rule, token meaning or component contract changes, update its canonical guidance/header and affected previews in the same edit. Local text and page composition changes usually need no system-document edit. Keep established files editable; promotion of experiments follows the user's authorization.

When a monolithic file becomes hard to navigate, move existing sections without changing their meaning, update inbound links and retain a short entry point. Heading-based retrieval already supports old files, so migration is not a prerequisite for ordinary UI work. Never silently migrate unrelated app files while working on another task.

Run `cdesign check`; review relevant rendered states and sizes. Check contract vs implementation where behavior changed. Report source conflicts or unsupported checks instead of claiming the system is fully verified.

For HTML ↔ React conversion, read `cdesign skills get cdesign-convert`. Changing the project configuration does not migrate source.

## Tailwind source and component styling

When Tailwind is enabled, `design/tailwind.css` is the canonical, editable Tailwind v4 entry. Define shared tokens in `@theme` and theme overrides in this file. Query with `cdesign tokens search|show`; edit the stylesheet directly. Do not maintain a parallel tokens.json source. Run `cdesign init` to migrate a legacy JSON project once; an existing tailwind.css is preserved.

Style components with utilities in TSX (or HTML), keeping complete literal class strings in variant and size maps. Do not create a paired CSS file for each component or recreate utilities as semantic CSS selectors. Add custom CSS only for a specific need utilities cannot reasonably express; keep shared rules in the root stylesheet. No CDN runtime or host Tailwind installation is required. Plain CSS projects retain tokens.json and generated tokens.css.
