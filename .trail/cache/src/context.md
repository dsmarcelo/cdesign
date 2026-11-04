# src/context.ts

- Entry · type · L8-L8 — type Entry = { id: string; title: string; file: string; body: string; kind: "doc" | "section" | "component" };
- slug · function · L11-L11 — slug = (s: string)
- read · function · L12-L12 — read = (root: string, file: string)
- outside · function · L13-L13 — outside = (path: string)
- guidanceFiles · function · L16-L29 — function guidanceFiles(root: string): string[]
- scan · function · L18-L26 — scan = (dir: string)
- contract · function · L31-L44 — function contract(root: string, file: string): string
- entries · function · L46-L70 — function entries(root: string): Entry[]
- context · function · L72-L98 — function context(root: string, action = "list", query = "", offset = 0): string
- score · function · L94-L94 — score = (e: Entry)
- list · function · L100-L102 — function list(rows: string[], offset: number, command: string): string
- startup · function · L104-L106 — function startup(): string
