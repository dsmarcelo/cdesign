---
title: Tailwind projects own their tokens in an editable root stylesheet
author: Dsmarcelo
date: 2026-10-29
branch: react-mode
id: l-c4c1a0de
scope: repo
status: active
src: agent
touches:
  - README.md
  - bun.lock
  - package.json
  - skills/cdesign-convert/SKILL.md
  - skills/cdesign-review/SKILL.md
  - skills/cdesign-system/SKILL.md
  - skills/cdesign/SKILL.md
  - src/cli.ts
  - src/context.ts
  - src/modes.ts
---

## Decided
Tailwind mode uses design/tailwind.css as the editable token and theme source, compiled by cdesign. Components use utility classes and complete literal variant maps rather than paired component CSS files. This keeps the project understandable as a normal Tailwind v4 project.

## Tried and ruled out
Changing agent instructions alone leaves compilation and token discovery tied to a hidden JSON-generated theme. A parallel editable JSON source would require synchronization.

## Watch out
Plain CSS projects retain JSON token commands. Legacy Tailwind projects can run cdesign init for a non-overwriting migration; old files remain for compatibility but the root stylesheet takes authority. Keep TypeScript pinned as before.

In the code: src/tokens.ts, src/react.ts, src/cli.ts and skills/cdesign*/SKILL.md.
