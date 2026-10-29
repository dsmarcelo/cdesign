---
title: Preserve token purpose when moving design tokens into CSS
author: Dsmarcelo
date: 2026-10-29
branch: react-mode
id: l-e7070ec9
scope: repo
status: active
src: agent
touches:
  - README.md
  - skills/cdesign-convert/SKILL.md
  - skills/cdesign-review/SKILL.md
  - skills/cdesign-system/SKILL.md
  - skills/cdesign/SKILL.md
  - src/context.ts
  - src/tokens.ts
  - tests/tailwind.test.ts
---

## Decided
Token usage descriptions are part of the design system, not disposable JSON metadata. Preserve them as immediately preceding CSS comments when migrating to Tailwind. Token queries search and return these notes; color tokens and typography utilities without notes produce warnings.

## Tried and ruled out
Inferring purpose from a semantic name or displaying a selector as usage loses intended surfaces, pairings and restrictions. Deleting JSON after migrating values alone loses design knowledge.

## Watch out
Existing root stylesheets are never overwritten. Projects migrated before usage preservation need manual reconciliation with the old JSON before deleting it. Verify themes, values, descriptions and typography contracts first.

In the code: src/tokens.ts, tests/tailwind.test.ts, skills/cdesign*/SKILL.md.
