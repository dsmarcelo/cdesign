---
name: cdesign-review
description: Review cdesign prototypes for design-system alignment, responsive behavior, accessibility and component preview coverage.
---
# Review a cdesign surface

Scope the review to the requested target. Use `cdesign page` for a vague location, `context for <path>` to map direct dependencies, and `context find`/`get` for relevant rules and contracts. Do not load the entire library or imported reference bundles by default.

Read `design/cdesign.json` to identify React TSX versus HTML mode and Tailwind versus plain CSS. React entries must use TSX; component contracts use JSDoc and typed props. Component previews preferably use a same-file named `Preview` export; separate default-export `previews/Name.preview.tsx` entries remain supported. Verify the effective preview (inline takes precedence when opening a component) and supported variants/states. HTML contracts/previews retain their existing conventions.

Run `cdesign check` for undefined tokens/components, missing previews, contract documentation and broken guidance file links. Its success does not prove visual consistency or accessibility.

Inspect the rendered target with `cdesign shot` or MCP screenshot. Prefer an element capture for a component change. Check relevant viewport sizes, themes and states; batch fixes revealed by one inspection before capturing again. Screenshots cannot prove keyboard operation or screen-reader behavior; use interaction/source checks where available and report limits.

Evaluate against the project's own rules:
- Hierarchy, text legibility, semantic color roles, spacing and typography.
- Component reuse, shared responsive variables and preferred patterns.
- Focus, keyboard semantics, labeling, contrast and touch targets.
- Loading, empty, error, disabled, long-content and success states relevant to the task.
- Header contracts and previews matching supported behavior; comparisons and experiments clearly distinguished from preferred examples.

Report concrete findings with file/element, impact and suggested correction. If asked to review only, do not edit. If authorized to fix, update the affected implementation, canonical guidance when rules change, and previews; rerun relevant checks. Preserve the product's identity and scope.

## Tailwind source and component styling

When Tailwind is enabled, `design/tailwind.css` is the canonical, editable Tailwind v4 entry. Define shared tokens in `@theme` and theme overrides in this file. Query with `cdesign tokens search|show`; edit the stylesheet directly. Do not maintain a parallel tokens.json source. Run `cdesign init` to migrate a legacy JSON project once; an existing tailwind.css is preserved.

Style components with utilities in TSX (or HTML), keeping complete literal class strings in variant and size maps. Do not create a paired CSS file for each component or recreate utilities as semantic CSS selectors. Add custom CSS only for a specific need utilities cannot reasonably express; keep shared rules in the root stylesheet. No CDN runtime or host Tailwind installation is required. Plain CSS projects retain tokens.json and generated tokens.css.

Document each semantic token’s purpose in a CSS comment immediately before its declaration in `design/tailwind.css` (and typography purpose before `@utility type-*`). Include intended surfaces/states, pairings and restrictions. `tokens search|show` searches and returns these notes; theme overrides inherit the base description unless documented separately. Broader usage rules belong in linked foundations/patterns guidance. Before removing legacy token files, verify migration preserved values, light/dark themes, usage notes and typography contracts. Existing root stylesheets are never overwritten: reconcile missing notes manually against the legacy source.
