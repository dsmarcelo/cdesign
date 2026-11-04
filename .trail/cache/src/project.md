# src/project.ts

- ProjectConfig · type · L4-L4 — type ProjectConfig = { version: 1; mode: "react" | "html"; tailwind: boolean };
- SetupOptions · type · L5-L5 — type SetupOptions = Partial<Pick<ProjectConfig, "mode" | "tailwind">>;
- configPath · function · L6-L6 — configPath = (root: string)
- projectFiles · function · L10-L17 — function projectFiles(root: string, dir = root): string[]
- readConfig · function · L19-L28 — function readConfig(root: string): ProjectConfig
- configure · function · L30-L37 — function configure(root: string, options: SetupOptions = {}): ProjectConfig
- setup · function · L40-L55 — async function setup(root: string, options: SetupOptions): Promise<ProjectConfig>
