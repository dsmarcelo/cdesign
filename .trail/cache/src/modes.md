# src/modes.ts

- insideProject · function · L9-L11 — function insideProject(root: string, file: string): boolean
- RenderAdapter · type · L12-L18 — type RenderAdapter = { pages(root: string): string[]; components(root: string, duplicates?: string[]): Map<string, string>; render(root: string, file: string): Promise<string>; snippet(source: string, id: string): string; diagnostics(root: string): Promise<string[]>; };
- render · method · L22-L26 — async render(root, file)
- diagnostics · method · L28-L32 — async diagnostics(root)
- components · method · L36-L45 — components(root, duplicates = [])
- render · method · L46-L46 — async render(root, file)
- diagnostics · method · L48-L59 — async diagnostics(root)
- adapter · function · L61-L61 — adapter = (root: string): RenderAdapter
- listPages · function · L62-L62 — listPages = (root: string)
- components · function · L63-L63 — components = (root: string, dups?: string[])
- sourceSnippet · function · L64-L64 — sourceSnippet = (root: string, file: string, id: string)
