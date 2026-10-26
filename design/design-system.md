# Design system

Source of truth for prototypes. Update it in the same edit as any token, style or component change.

## Tokens
Source of truth: `design/tokens.json` (query it with `cdesign tokens search|show`, change it with `cdesign tokens set|rm`). Do not list tokens here; document rules for using them.

## Typography and layout rules

## Components
Files in `design/components/<ui|shared|layout>/` and `design/features/<feature>/`, each with a `previews/<name>.preview.html` in a `previews/` folder beside it. Used as `<c-name prop="x">children</c-name>`.
| Component | Props | Slots | Notes |
|---|---|---|---|

## Prototypes
Work in progress lives in `design/prototype/`. When one is done, ask the user whether to move it to `components/`, `features/` or `pages/`.

## Patterns and rules
