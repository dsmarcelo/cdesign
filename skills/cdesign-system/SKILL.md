---
name: cdesign-system
description: Establish, document or maintain a cdesign design system, its source authority, reusable patterns and component contracts.
---
# Build and maintain a design system

Inspect the existing system and relevant implementation before proposing rules. Capture the user's established identity; do not impose a font, palette, component style or directory taxonomy from another app.

## Discover authority
Use `cdesign context` and `context find <topic>` to locate maintained guidance. Read `design-system#overview` and relevant sections. Inspect shared setup (`design/_head.html`), token usages via `tokens search`, component contracts and representative previews as needed.

Record which source governs tokens, shared behavior and visual decisions. When app components, design-tool libraries, exported mockups and prototypes disagree, record the conflict and freshness; do not overwrite newer decisions by importing an older reference. Link existing product/domain documentation rather than copying it.

## Organize for retrieval
- Keep `design/design-system.md` a short entry point: identity, universal constraints, source authority and links to focused guidance. Put essential rules before the first `##` so `design-system#overview` retrieves them together.
- Split substantial guidance into `design/foundations/*.md` (semantic color, typography, geometry, interaction) and `design/patterns/*.md` (forms, shells, feedback) when useful. Keep tightly coupled rules together, including responsive sizing and composition. Do not create empty topic files.
- Give each rule one canonical home and link it elsewhere. Prose explains token meaning and application; exact values live in tokens.json and are queried/changed through `cdesign tokens`.
- Keep concise component contracts in leading HTML comments: `Purpose:`, `Props:` with defaults and supported values, `Slots:`, plus relevant states, accessibility and dependencies. Extraction can find actual template props and slots but cannot infer the full API or behavior.
- Add longer Markdown guidance beside a component family only when it conveys decisions that the header/source does not. Avoid a duplicate Markdown API for every component.
- Label preferred examples, supported alternatives, experiments and imported references in linked guidance. Do not infer preference from version numbers or modification time. `design/reference/`, `design/references/`, `exported-ds/`, vendor runtimes and previews are excluded from guidance discovery; document pointers and authority in maintained Markdown outside them.
- Use relative Markdown links for maintained documents and examples. `cdesign check` checks local file targets; it does not validate heading anchors or prove semantic agreement.

## Change without accumulating prose
When a shared rule, token meaning or component contract changes, update its canonical guidance/header and affected previews in the same edit. Local text and page composition changes usually need no system-document edit. Keep established files editable; promotion of experiments follows the user's authorization.

When a monolithic file becomes hard to navigate, move existing sections without changing their meaning, update inbound links and retain a short entry point. Heading-based retrieval already supports old files, so migration is not a prerequisite for ordinary UI work. Never silently migrate unrelated app files while working on another task.

Run `cdesign check`; review relevant rendered states and sizes. Check contract vs implementation where behavior changed. Report source conflicts or unsupported checks instead of claiming the system is fully verified.
