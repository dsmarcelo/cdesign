---
name: cdesign-review
description: Review cdesign prototypes for design-system alignment, responsive behavior, accessibility and component preview coverage.
---
# Review a cdesign surface

Scope the review to the requested target. Use `cdesign page` for a vague location, `context for <path>` to map direct dependencies, and `context find`/`get` for relevant rules and contracts. Do not load the entire library or imported reference bundles by default.

Run `cdesign check` for undefined tokens/components, missing previews, contract documentation and broken guidance file links. Its success does not prove visual consistency or accessibility.

Inspect the rendered target with `cdesign shot` or MCP screenshot. Prefer an element capture for a component change. Check relevant viewport sizes, themes and states; batch fixes revealed by one inspection before capturing again. Screenshots cannot prove keyboard operation or screen-reader behavior; use interaction/source checks where available and report limits.

Evaluate against the project's own rules:
- Hierarchy, text legibility, semantic color roles, spacing and typography.
- Component reuse, shared responsive variables and preferred patterns.
- Focus, keyboard semantics, labeling, contrast and touch targets.
- Loading, empty, error, disabled, long-content and success states relevant to the task.
- Header contracts and previews matching supported behavior; comparisons and experiments clearly distinguished from preferred examples.

Report concrete findings with file/element, impact and suggested correction. If asked to review only, do not edit. If authorized to fix, update the affected implementation, canonical guidance when rules change, and previews; rerun relevant checks. Preserve the product's identity and scope.
