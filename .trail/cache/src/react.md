# src/react.ts

- escape · function · L33-L33 — escape = (s: string)
- errorDocument · function · L34-L36 — function errorDocument(error: unknown): string
- tailwindCss · function · L40-L46 — async function tailwindCss(root: string, extraSources: string[] = [], extraCss = ""): Promise<string>
- onDependency · method · L44-L44 — onDependency()
- Bundle · type · L48-L48 — type Bundle = { html: string; assets: Map<string, Blob> };
- invalidateReact · function · L50-L50 — function invalidateReact(root: string)
- reactAsset · function · L51-L56 — async function reactAsset(root: string, path: string): Promise<Blob | undefined>
- renderReact · function · L58-L69 — function renderReact(root: string, file: string): Promise<Bundle>
- buildReact · function · L71-L123 — async function buildReact(root: string, file: string): Promise<Bundle>
- setup · method · L98-L109 — setup(builder)
