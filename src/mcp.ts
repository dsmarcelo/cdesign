import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const CLI = join(import.meta.dir, "cli.ts");

const INSTRUCTIONS = `cdesign is a local viewer for React (TSX) and HTML prototypes and mockups, with element-level comments from the user.
Use it whenever the user mentions cdesign, asks to design, prototype or mock up UI, or asks you to apply design comments.
Start with \`open\`: it scaffolds design/ if missing and returns compact directions and the current target. Use \`context\` to find relevant guidance and component contracts; do not load all documents. Use \`run\` with "skills get cdesign" for the usage guide, "skills get cdesign-system" to build/maintain a system, or "skills get cdesign-review" for a review. For HTML/React conversion, read "skills get cdesign-convert". New projects default to React with Tailwind CSS; existing projects keep their mode.
When the user is vague about location ("this page", "change this", "here", "this button"), call \`page\` before asking anything: it returns the page open in the viewer and the element the user selected with the pointer tool. \`open\` reuses the shared viewer process (one for all projects, chosen by the folder you run in), so never ask the user for a localhost link.
Never read design/tokens.json directly (it is huge); query it with \`run\` ("tokens search <words>").
Flows: the viewer is a canvas with one tab per flow, design/flows/<id>.json; each flow places pages as frames (x, y, w, h) that the user drags and resizes. Call \`flows\` to list or show them, or to add a page to a flow (it is placed after the other frames). A dialog or sheet state is its own frame: its page field is page.tsx#state, and the page must open that state from its URL hash (verify with screenshot of page.tsx#state). Read "skills get cdesign" > Flows for the file format.`;

/** Every tool is a thin wrapper over the CLI, run in the project the agent was started in. */
async function cli(args: string[]) {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return (out + (err ? `\n${err}` : "")).trim() || "(no output)";
}

/** split "tokens set color/x --usage 'a b'" like a shell would (quotes only) */
const split = (s: string) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

const tools = [
  {
    name: "open",
    description: "Start the viewer (scaffolds design/ if missing); return compact directions and the current page/selection. Call first, then retrieve relevant context.",
    inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["react", "html"] }, tailwind: { type: "boolean", description: "Enable or disable Tailwind CSS; new React projects default to enabled." } } },
  },
  {
    name: "context",
    description: "Discover maintained design guidance and component contracts without loading implementation. Start with get design-system#overview; find searches content, for maps a target's direct dependencies. Imported reference bundles are excluded. Results are paginated.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "find", "get", "for"], default: "list" },
        query: { type: "string", description: "Search words, exact context id, or project-relative target path, depending on action." },
        offset: { type: "integer", minimum: 0, description: "Continuation offset from the result: entries for lists/find/for; characters for get." },
      },
    },
  },
  {
    name: "page",
    description: "Return the page currently open in the cdesign viewer for this project (the most recently active tab) and the element the user selected, if any. Use it to resolve vague references like \"this page\" or \"change this\".",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "Screenshot a prototype page or one element and get it back as a compact image (WebP, at most 1568px on the long side), without opening a browser. Cheaper and sharper than screenshotting the viewer. Defaults to the page open in the viewer; use selected:true for the element the user picked, or selector for any CSS selector. Long pages are cropped from the top (see the note in the result): use y, or full, or a selector. Use responsive:true to check the design at all screen sizes at once: one image with mobile (iPhone, 390px), tablet (portrait, 768px) and desktop (1280px) side by side.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "Page path relative to the project, e.g. design/prototype/home.html. Default: the page open in the viewer." },
        selected: { type: "boolean", description: "Capture the element the user selected in the viewer." },
        selector: { type: "string", description: "CSS selector of the element to capture." },
        width: { type: "number", description: "Viewport width in CSS px (default 1280; use 390 for mobile). Ignored with responsive." },
        responsive: { type: "boolean", description: "One image with mobile (390px), tablet portrait (768px) and desktop (1280px) side by side, left to right. Use it to verify a design at every screen size." },
        theme: { type: "string", enum: ["light", "dark"] },
        format: { type: "string", enum: ["webp", "jpeg", "png"], description: "Default webp." },
        y: { type: "number", description: "Page shots: start this many px from the top." },
        full: { type: "boolean", description: "Page shots: do not crop tall pages (the image is scaled down instead)." },
      },
    },
  },
  {
    name: "review",
    description: "Return the batch of comments the user sent from the viewer (Send button). Apply every one, then call resolve with all the ids.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "resolve",
    description: "Mark comments as done after applying them.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
  {
    name: "flows",
    description: "Canvas tabs (design/flows/*.json): list them, show one's frames (page, position, size), check them for errors, create an empty one, or add/remove a page as a frame.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "show", "check", "new", "add", "rm"], default: "list" },
        id: { type: "string", description: "Flow id (file name without .json), e.g. nova-venda." },
        page: { type: "string", description: "add: project-relative page, optionally with #state; rm: frame id or page." },
        title: { type: "string", description: "Title for new, or the frame label for add." },
      },
    },
  },
  {
    name: "run",
    description: 'Run any other cdesign command, for example "tokens search danger border", "tokens set color/x --light #fff --usage \\"…\\"", "check", "comments", "context", "init".',
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Arguments after `cdesign`" } }, required: ["args"] },
  },
];

const mcp = new Server({ name: "cdesign", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as { mode?: "react" | "html"; tailwind?: boolean; action?: string; query?: string; offset?: number; ids?: string[]; args?: string; page?: string; selected?: boolean; selector?: string; width?: number; theme?: string; format?: string; y?: number; full?: boolean; responsive?: boolean; id?: string; title?: string; };
  let text: string;
  switch (req.params.name) {
    case "open": text = await cli(["open", ...(a.mode ? ["--mode", a.mode] : []), ...(a.tailwind === undefined ? [] : [a.tailwind ? "--tailwind" : "--no-tailwind"])]); break;
    case "context": text = await cli(["context", a.action ?? "list", ...(a.query ? [a.query] : []), "--offset", String(a.offset ?? 0)]); break;
    case "page": text = await cli(["page"]); break;
    case "screenshot": {
      const args = ["shot", "--json"];
      if (a.page) args.push(a.page);
      if (a.selected) args.push("--selected");
      if (a.selector) args.push("--selector", a.selector);
      if (a.width) args.push("--width", String(a.width));
      if (a.responsive) args.push("--responsive");
      if (a.theme) args.push("--theme", a.theme);
      if (a.format) args.push("--format", a.format);
      if (a.y) args.push("--y", String(a.y));
      if (a.full) args.push("--full");
      const out = await cli(args);
      try {
        const info = JSON.parse(out.split("\n").filter((l) => l.startsWith("{")).pop() ?? "");
        const note = `${info.page}${info.selector ? ` ${info.selector}` : ""}: ${info.width}x${info.height} ${info.mime}, ${(info.bytes / 1024).toFixed(1)} KB, saved at ${info.path}${info.note ? `\n${info.note}` : ""}`;
        return { content: [{ type: "image", data: readFileSync(info.path).toString("base64"), mimeType: info.mime }, { type: "text", text: note }] };
      } catch {
        return { content: [{ type: "text", text: out }], isError: true };
      }
    }
    case "review": text = await cli(["review"]); break;
    case "flows": text = await cli(["flows", a.action ?? "list", ...(a.id ? [a.id] : []), ...(a.page ? [a.page] : []), ...(a.title ? ["--title", a.title] : [])]); break;
    case "resolve": text = await cli(["resolve", ...(a.ids ?? [])]); break;
    case "run": text = await cli(split(a.args ?? "")); break;
    default: throw new Error(`unknown tool: ${req.params.name}`);
  }
  return { content: [{ type: "text", text }] };
});

export const startMcp = () => mcp.connect(new StdioServerTransport());
