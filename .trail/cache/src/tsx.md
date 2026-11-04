# src/tsx.ts

- sourceFile · function · L5-L5 — sourceFile = (source: string, file = "source.tsx")
- jsxSnippet · function · L6-L18 — function jsxSnippet(source: string, id: string, max = 600): string
- visit · function · L9-L15 — visit = (node: ts.Node)
- tsxInfo · function · L20-L44 — function tsxInfo(source: string, file: string)
- visit · function · L22-L32 — visit = (node: ts.Node)
- directComponents · function · L46-L55 — function directComponents(root: string, file: string, index: Map<string, string>): string[]
- instrument · function · L58-L83 — function instrument(source: string, file: string): string
- visit · function · L64-L76 — visit: ts.Visitor = node
- relocateImports · function · L86-L105 — function relocateImports(source: string, from: string, to: string): string
- visit · function · L88-L101 — visit = (node: ts.Node)
