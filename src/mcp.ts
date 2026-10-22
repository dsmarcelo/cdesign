import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

const INSTRUCTIONS = `cdesign is a local viewer for HTML prototypes and mockups, with element-level comments from the user.
Use it whenever the user mentions cdesign, asks to design, prototype or mock up UI, or asks you to apply design comments.
Start by calling the \`open\` tool, even if the project has no design/ folder yet: it scaffolds design/, starts the viewer and returns the full usage guide and project context. Follow that guide.
Never read design/tokens.json directly (it is huge); query it with \`run\` ("tokens search <words>").`;

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
    description: "Start the cdesign viewer for this project (scaffolds design/ if missing) and return the usage guide, design system, tokens digest and project context. Call this first.",
    inputSchema: { type: "object", properties: {} },
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
    name: "run",
    description: 'Run any other cdesign command, for example "tokens search danger border", "tokens set color/x --light #fff --usage \\"…\\"", "check", "comments", "context", "init".',
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Arguments after `cdesign`" } }, required: ["args"] },
  },
];

const mcp = new Server({ name: "cdesign", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as { ids?: string[]; args?: string };
  let text: string;
  switch (req.params.name) {
    case "open": text = await cli(["open"]); break;
    case "review": text = await cli(["review"]); break;
    case "resolve": text = await cli(["resolve", ...(a.ids ?? [])]); break;
    case "run": text = await cli(split(a.args ?? "")); break;
    default: throw new Error(`unknown tool: ${req.params.name}`);
  }
  return { content: [{ type: "text", text }] };
});

export const startMcp = () => mcp.connect(new StdioServerTransport());
