import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFlows, readFlow, newFlow, createFlow, updateFlow, deleteFlow, addFrame, removeFrame, pageFlowNote } from "../src/flows";
import { configure } from "../src/project";
import { projectId } from "../src/store";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function project() {
  const root = mkdtempSync(join(tmpdir(), "cdesign-flows-"));
  dirs.push(root);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); };
  configure(root, { mode: "react", tailwind: false });
  put("design/design-system.md", "# DS\n");
  put("design/pages/vendas/nova-venda.tsx", "export default function P(){return <main>page</main>}");
  put("design/pages/vendas/lista.tsx", "export default function P(){return <main>lista</main>}");
  put("design/flows/nova-venda.json", JSON.stringify({
    title: "Nova venda",
    frames: [
      { id: "lista", title: "Vendas", page: "design/pages/vendas/lista.tsx", x: 0, y: 0, w: 402, h: 874 },
      { id: "cliente", page: "design/pages/vendas/nova-venda.tsx#venda/cliente", x: 500, y: 40, w: 402, h: 874 },
    ],
  }));
  return { root, put };
}

test("flows parse frames, validate pages and fill in missing positions", () => {
  const { root, put } = project();
  const [f] = listFlows(root);
  expect(f.title).toBe("Nova venda");
  expect(f.frames.map((x) => [x.id, x.x, x.y])).toEqual([["lista", 0, 0], ["cliente", 500, 40]]);
  expect(f.errors).toEqual([]);

  put("design/flows/bad.json", JSON.stringify({ frames: [{ id: "a", page: "design/pages/missing.tsx#x" }, { id: "a", page: "design/pages/vendas/lista.tsx" }, { id: "Bad Id", page: "x" }, { id: "n" }, { page: "design/pages/vendas/lista.tsx", w: 1280, h: 800 }] }));
  const bad = readFlow(root, "bad");
  expect(bad.errors.join("\n")).toContain('frame "a": page file not found: design/pages/missing.tsx');
  expect(bad.errors.join("\n")).toContain('duplicate frame id "a"');
  expect(bad.errors.join("\n")).toContain("frame id must be lowercase");
  expect(bad.errors.join("\n")).toContain('frame "n": needs a page');
  // A frame without a position goes after the others; one without an id gets one from its page.
  expect(bad.frames.at(-1)).toEqual({ id: "lista", page: "design/pages/vendas/lista.tsx", x: 402 + 80, y: 0, w: 1280, h: 800 });

  put("design/flows/broken.json", "{");
  expect(readFlow(root, "broken").errors[0]).toContain("invalid JSON");
});

test("old step/link flows open as frames of their pages", () => {
  const { root, put } = project();
  put("design/flows/old.json", JSON.stringify({
    title: "Old",
    steps: [
      { id: "cliente", title: "Cliente", wireframe: "design/wireframe/c.tsx", page: "design/pages/vendas/nova-venda.tsx" },
      { id: "ok", decision: "Encontrado?" },
      { id: "itens", title: "Itens", wireframe: "design/wireframe/i.tsx" },
      { id: "lista", page: "design/pages/vendas/lista.tsx" },
    ],
    links: [{ from: "cliente", to: "ok" }],
  }));
  const f = readFlow(root, "old");
  expect(f.errors).toEqual([]);
  expect(f.frames.map((x) => [x.id, x.title, x.x])).toEqual([["cliente", "Cliente", 0], ["lista", undefined, 482]]);
  updateFlow(root, "old", { title: "Old flow" });
  const saved = JSON.parse(readFileSync(join(root, "design/flows/old.json"), "utf8"));
  expect(saved.steps).toBeUndefined();
  expect(saved.frames).toHaveLength(2);
});

test("tabs are created, renamed, laid out and deleted", () => {
  const { root } = project();
  expect(newFlow(root, "cadastro", "Cadastro")).toBe("design/flows/cadastro.json");
  expect(() => newFlow(root, "cadastro")).toThrow("already exists");
  expect(() => newFlow(root, "No")).toThrow("lowercase");
  expect(createFlow(root, "Cadastro").id).toBe("cadastro-2");
  expect(createFlow(root, "Revisão de pedido").id).toBe("revisao-de-pedido");

  const f = updateFlow(root, "cadastro", { title: "Cadastro novo", frames: [{ page: "design/pages/vendas/lista.tsx", x: 10.4, y: -20, w: 50, h: 9000 }] });
  expect(f.title).toBe("Cadastro novo");
  expect(f.frames).toEqual([{ id: "lista", page: "design/pages/vendas/lista.tsx", x: 10, y: -20, w: 200, h: 4000 }]);
  expect(() => updateFlow(root, "cadastro", { frames: [{ page: "design/pages/nope.tsx" }] })).toThrow("page file not found");
  expect(() => updateFlow(root, "nope", { title: "x" })).toThrow("does not exist");

  const added = addFrame(root, "cadastro", "design/pages/vendas/nova-venda.tsx#venda/cliente", "Cliente");
  expect(added).toEqual({ id: "cliente", title: "Cliente", page: "design/pages/vendas/nova-venda.tsx#venda/cliente", x: 290, y: -20, w: 200, h: 4000 });
  expect(pageFlowNote(root, "design/pages/vendas/nova-venda.tsx")).toBe("Flow: shown as cadastro/cliente, nova-venda/cliente.");
  expect(removeFrame(root, "cadastro", "cliente")).toBe(true);
  expect(removeFrame(root, "cadastro", "cliente")).toBe(false);

  deleteFlow(root, "cadastro");
  expect(existsSync(join(root, "design/flows/cadastro.json"))).toBe(false);
  expect(() => deleteFlow(root, "cadastro")).toThrow("does not exist");
});

test("CLI and daemon expose flows", async () => {
  const { root } = project();
  const run = (...a: string[]) => { const p = Bun.spawnSync([process.execPath, cli, ...a], { cwd: root, env: { ...process.env, CDESIGN_HOME: join(root, ".home") } }); return p.stdout.toString() + p.stderr.toString(); };
  expect(run("flows")).toContain("nova-venda  Nova venda  (2 frames)");
  expect(run("flows", "check")).toContain("flows ok");
  expect(run("flows", "show", "nova-venda")).toContain('lista "Vendas": design/pages/vendas/lista.tsx at 0,0 size 402×874');
  expect(run("flows", "add", "nova-venda", "design/pages/vendas/lista.tsx", "--title", "Outra")).toContain("added frame outra");
  expect(run("flows", "rm", "nova-venda", "outra")).toContain("removed outra");
  expect(run("sync")).not.toContain("wireframe"); // the sync command is gone

  const home = join(root, ".home");
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" }, stdout: "ignore", stderr: "ignore" });
  try {
    let port = 0;
    for (let i = 0; i < 200 && !port; i++) { try { port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await Bun.sleep(50); } }
    const url = (p: string) => `http://127.0.0.1:${port}/__cd/${p}?project=${projectId(root)}`;
    const data = await (await fetch(url("flows"))).json() as any;
    expect(data.flows[0].title).toBe("Nova venda");
    const created = await (await fetch(url("flows"), { method: "POST", body: JSON.stringify({ title: "Checkout" }) })).json() as any;
    expect(created.flow.id).toBe("checkout");
    const moved = await (await fetch(url("flows/checkout"), { method: "POST", body: JSON.stringify({ frames: [{ id: "a", page: "design/pages/vendas/lista.tsx", x: 5, y: 6, w: 768, h: 1024 }] }) })).json() as any;
    expect(moved.flow.frames[0]).toEqual({ id: "a", page: "design/pages/vendas/lista.tsx", x: 5, y: 6, w: 768, h: 1024 });
    expect((await fetch(url("flows/checkout"), { method: "POST", body: JSON.stringify({ frames: [{ page: "../x.tsx" }] }) })).status).toBe(400);
    expect((await fetch(url("flows/checkout/delete"), { method: "POST", body: "{}" })).status).toBe(200);
    expect(existsSync(join(root, "design/flows/checkout.json"))).toBe(false);
    expect((await fetch(url("app/main.js").replace(/\?.*/, ""))).status).toBe(200);
    expect((await fetch(url("app/main.css").replace(/\?.*/, ""))).status).toBe(200);
  } finally { daemon.kill(); await daemon.exited; }
});
