---
title: Keep the compiler API available for source-aware TSX previews
author: Dsmarcelo
date: 2026-10-28
branch: react-mode
id: l-5f32de2b
scope: repo
status: active
src: agent
touches:
  - README.md
  - bun.lock
  - package.json
  - skills/cdesign-review/SKILL.md
  - skills/cdesign-system/SKILL.md
  - skills/cdesign/SKILL.md
  - src/cli.ts
  - src/context.ts
  - src/mcp.ts
  - src/render.ts
---

## Decided
Keep the TypeScript dependency on the compiler-API-compatible 5.9 line. JSX locations must come from the original syntax tree before transpilation so comments point to authored source.

## Tried and ruled out
Installing the default latest TypeScript resolved to 7.0.2 in this environment. Its default package export did not expose createSourceFile or transpileModule, so it could not support this implementation's AST transforms and contract extraction.

## Watch out
Before upgrading across this boundary, verify the public compiler API and rerun source-location, contract and browser comment tests. A successful TypeScript CLI invocation does not prove that the library API is available.

In the code: package.json pins typescript to ~5.9.3; src/tsx.ts consumes the compiler API. Run bun test and bun run typecheck.
