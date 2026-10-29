---
name: cdesign-convert
description: Convert cdesign HTML fragments and pages to React TSX, or React TSX to cdesign HTML, preserving appearance, behavior, tokens and component contracts.
---
# Convert between HTML and React

Read `design/cdesign.json`, relevant `cdesign context` contracts and the source before converting. New projects default to React with Tailwind; preserve the user's target mode and styling preference. React source is TSX only. This is an agent-guided migration, not a lossless compiler for arbitrary React applications.

## Establish the conversion boundary

Use the user's requested page, component family or whole design project. Trace its imports or `<c-name>` dependencies, assets, shared CSS, scripts and previews. Include shared dependencies needed by the target, preserving reusable boundaries. For a partial conversion leave the project configuration unchanged. For a whole-project conversion update it only after verification.

Capture the source at matching desktop/mobile widths and light/dark themes with `cdesign shot` (or MCP screenshot). Record relevant interactions: keyboard/focus, form submission, validation, expanded/selected states and asynchronous states. Keep original files intact until verification finishes; do not overwrite an existing target file. Prefer converting in a temporary project directory with a copy of the required design files and assets, configured for the target mode. This lets both modes render while the original project's mode stays unchanged. Record target-to-source paths so imports and assets resolve after moving the verified files back.

## HTML → React TSX

- Convert fragments into PascalCase React components and typed `NameProps`. Preserve defaults from `{{prop|default}}`, permitted values, states and leading contracts as JSDoc. Use a default export for page and `.preview.tsx` entry files.
- Replace `<c-name>` with imports and React component calls. Convert the default slot to `children` and named slots to typed `ReactNode` props. Preserve fallback content and component variants.
- Translate attributes (`className`, `htmlFor`, boolean properties, SVG attributes), inline style strings to style objects, and DOM scripts/event handlers to React state, callbacks, refs and effects. Preserve cleanup and accessibility. Avoid direct DOM mutation of React-managed content.
- Move shared `_head.html` styles and fonts into `design/styles.css` or appropriate imports; preserve applicable metadata and script dependencies deliberately. The React renderer loads tokens and shared styles; `_head.html` is HTML-only.
- Create `previews/Name.preview.tsx` beside components with the same variants, sizes and interactive states. Reuse semantic tokens and local assets. Never copy generated `data-cd-*` attributes.

## React TSX → cdesign HTML

- Translate reusable components into unique HTML fragment names used through `<c-name>`. Map representable scalar props/defaults to `{{prop|default}}`, children to `<slot>`, and named content to named slots.
- React expressions, conditional rendering, loops and object/function props are not evaluated by the HTML fragment renderer. Use explicit HTML compositions or browser JavaScript to preserve their behavior; document any variant/state mapping in the contract.
- Recreate supported state/effects/event handling in browser JavaScript with instance-scoped selectors, initialization and cleanup. Preserve keyboard behavior, form semantics, async/loading/error states and multiple component instances.
- Identify hooks, context, routing, third-party components, server-only dependencies or behavior needing an alternative implementation. Ask for a decision before simplifying or removing behavior; report blocked portions rather than silently flattening an interactive component into a static snapshot.
- Use `_head.html` for shared styles/fonts/scripts and `previews/name.preview.html` for variant coverage. Preserve plain HTML contracts with Purpose, Props/defaults, Slots, States and Dependencies.

## Styling and verification

Retain Tailwind utilities when enabled in the target; cdesign compiles them locally. When disabled, replace utilities with equivalent CSS, including responsive, hover, focus and dark states. Keep semantic token variables instead of baking current token values into styles. Preserve CSS order and asset URLs.

Run `cdesign check` in the target staging project. Compare before/after screenshots at identical widths/themes and exercise the recorded interactions in a browser; screenshots alone do not verify behavior. Fix discrepancies before calling the conversion complete. If a check cannot run, explicitly report what remains unverified and preserve the original configuration/files.

Copy verified target files back without overwriting existing targets; update imports, preview paths, maintained guidance and contracts. For a whole-project conversion, set `design/cdesign.json` to the target mode and requested Tailwind preference only after this verification, then reopen and rerun checks/screenshots. Retain original files unless their removal was authorized. Report converted targets, any adaptations, unresolved portions and validation performed. Generated annotations belong to the renderer, not authored source.
