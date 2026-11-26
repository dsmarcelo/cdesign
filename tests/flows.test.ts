import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFlows, readFlow, syncItems, markOutdated, markSynced, clearOutdated, syncReport, pageFlowNote, newFlow, variantsOf } from "../src/flows";
import { listPages } from "../src/modes";
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
  put("design/wireframe/vendas/cliente.tsx", "export default function W(){return <main>wire cliente</main>}");
  put("design/wireframe/vendas/itens.tsx", "export default function W(){return <main>wire itens</main>}");
  put("design/pages/vendas/nova-venda.tsx", "export default function P(){return <main>page</main>}");
  put("design/flows/nova-venda.json", JSON.stringify({
    title: "Nova venda",
    steps: [
      { id: "cliente", title: "Cliente", wireframe: "design/wireframe/vendas/cliente.tsx", page: "design/pages/vendas/nova-venda.tsx" },
      { id: "ok", decision: "Encontrado?" },
      { id: "itens", title: "Itens", wireframe: "design/wireframe/vendas/itens.tsx" },
    ],
    links: [{ from: "cliente", to: "ok" }, { from: "ok", to: "itens", label: "Sim" }, { from: "itens", to: "cliente", label: "Voltar", dashed: true }],
  }));
  return { root, put };
}

test("flows parse, validate and list wireframes as React previews", () => {
  const { root, put } = project();
  const [f] = listFlows(root);
  expect(f.id).toBe("nova-venda");
  expect(f.errors).toEqual([]);
  expect(f.steps.map((s) => s.id)).toEqual(["cliente", "ok", "itens"]);
  expect(f.links[2]).toEqual({ from: "itens", to: "cliente", label: "Voltar", dashed: true });
  expect(listPages(root)).toContain("design/wireframe/vendas/cliente.tsx");

  put("design/flows/bad.json", JSON.stringify({ steps: [{ id: "a", wireframe: "design/wireframe/missing.tsx" }, { id: "a", decision: "x" }, { id: "Bad Id" }, { id: "d", decision: "q", page: "design/pages/vendas/nova-venda.tsx" }], links: [{ from: "a", to: "zzz" }] }));
  const bad = readFlow(root, "bad").errors.join("\n");
  expect(bad).toContain("wireframe file not found: design/wireframe/missing.tsx");
  expect(bad).toContain('duplicate step id "a"');
  expect(bad).toContain("lowercase");
  expect(bad).toContain("a decision has no wireframe or page");
  expect(bad).toContain("unknown step id");
  put("design/flows/broken.json", "{");
  expect(readFlow(root, "broken").errors[0]).toContain("invalid JSON");

  expect(newFlow(root, "cadastro", "Cadastro")).toBe("design/flows/cadastro.json");
  expect(() => newFlow(root, "cadastro")).toThrow("already exists");
  expect(() => newFlow(root, "No")).toThrow("lowercase");
});

test("sync states follow content hashes; only explicit marks mean outdated", () => {
  const { root } = project();
  const page = "design/pages/vendas/nova-venda.tsx", wire = "design/wireframe/vendas/cliente.tsx";
  const pair = () => syncItems(root).find((i) => i.page === page)!;
  expect(pair().state).toBe("never-synced");
  expect(syncItems(root).find((i) => i.wireframe === "design/wireframe/vendas/itens.tsx")!.state).toBe("no-page");

  markSynced(root, page);
  expect(pair().state).toBe("in-sync");
  appendFileSync(join(root, wire), "\n// changed");
  expect(pair().state).toBe("wireframe-changed");
  expect(pair().outdated).toEqual([]); // drift alone is not "outdated"
  appendFileSync(join(root, page), "\n// changed");
  expect(pair().state).toBe("both-changed");

  markOutdated(root, page, "add CPF search");
  expect(pair().outdated).toMatchObject([{ file: page, side: "page", note: "add CPF search" }]);
  expect(syncReport(root)).toContain(`page ${page} must follow ${wire} — add CPF search`);
  expect(pageFlowNote(root, wire)).toContain("wireframe of nova-venda/cliente; counterpart: design/pages/vendas/nova-venda.tsx");
  expect(JSON.parse(readFileSync(join(root, "design/sync.json"), "utf8")).outdated[page].note).toBe("add CPF search");

  markSynced(root, wire); // either side confirms the pair and clears both marks
  expect(pair()).toMatchObject({ state: "in-sync", outdated: [] });
  markOutdated(root, wire);
  expect(clearOutdated(root, wire)).toBe(true);
  expect(clearOutdated(root, wire)).toBe(false);
  expect(() => markOutdated(root, "design/pages/other.tsx")).toThrow("not a wireframe or page of any flow");
  expect(() => markSynced(root, "design/wireframe/vendas/itens.tsx")).toThrow("nothing to sync");
});

test("wireframe device variants are discovered and hashed together", () => {
  const { root, put } = project();
  expect(variantsOf(root, "design/wireframe/vendas/cliente.tsx")).toEqual({ phone: "design/wireframe/vendas/cliente.tsx", desktop: "design/wireframe/vendas/cliente.tsx" });
  put("design/wireframe/vendas/itens.phone.tsx", "export default function W(){return <main>phone</main>}");
  expect(variantsOf(root, "design/wireframe/vendas/itens.phone.tsx")).toEqual({ phone: "design/wireframe/vendas/itens.phone.tsx", desktop: undefined });
  put("design/wireframe/vendas/itens.desktop.tsx", "export default function W(){return <main>desktop</main>}");
  expect(variantsOf(root, "design/wireframe/vendas/itens.phone.tsx").desktop).toBe("design/wireframe/vendas/itens.desktop.tsx");
  expect(variantsOf(root, "design/wireframe/vendas/itens.tsx")).toEqual({ phone: "design/wireframe/vendas/itens.phone.tsx", desktop: "design/wireframe/vendas/itens.desktop.tsx" });
  expect(readFlow(root, "nova-venda").steps[2].wireframes?.desktop).toBe("design/wireframe/vendas/itens.desktop.tsx");

  put("design/wireframe/vendas/cliente.desktop.tsx", "export default function W(){return <main>d</main>}");
  const page = "design/pages/vendas/nova-venda.tsx";
  markSynced(root, page);
  const pair = () => syncItems(root).find((i) => i.page === page)!;
  expect(pair().state).toBe("in-sync");
  appendFileSync(join(root, "design/wireframe/vendas/cliente.desktop.tsx"), "\n// changed");
  expect(pair().state).toBe("wireframe-changed"); // a variant edit counts as a wireframe change
});

test("CLI and daemon expose flows and sync", async () => {
  const { root } = project();
  const run = (...a: string[]) => { const p = Bun.spawnSync([process.execPath, cli, ...a], { cwd: root, env: { ...process.env, CDESIGN_HOME: join(root, ".home") } }); return p.stdout.toString() + p.stderr.toString(); };
  expect(run("flows")).toContain("nova-venda  Nova venda  (2 screens, 1 decisions, 3 links)");
  expect(run("flows", "check")).toContain("flows ok");
  expect(run("flows", "show", "nova-venda")).toContain('ok -> itens "Sim"');
  expect(run("sync", "outdated", "design/pages/vendas/nova-venda.tsx", "--note", "follow the wireframe")).toContain("marked outdated");
  expect(run("sync")).toContain("Marked outdated (1)");
  expect(JSON.parse(run("sync", "--json"))[0].outdated[0].note).toBe("follow the wireframe");
  expect(run("sync", "done", "design/pages/vendas/nova-venda.tsx")).toContain("in sync:");

  const home = join(root, ".home");
  const daemon = Bun.spawn([process.execPath, cli, "serve", root, "--port", "0"], { env: { ...process.env, CDESIGN_HOME: home, CDESIGN_IDLE_SECONDS: "300" }, stdout: "ignore", stderr: "ignore" });
  try {
    let port = 0;
    for (let i = 0; i < 200 && !port; i++) { try { port = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")).port; } catch { await Bun.sleep(50); } }
    const url = (p: string) => `http://127.0.0.1:${port}/__cd/${p}?project=${projectId(root)}`;
    const data = await (await fetch(url("flows"))).json() as any;
    expect(data.flows[0].title).toBe("Nova venda");
    expect(data.sync.find((i: any) => i.page).state).toBe("in-sync");
    const r = await fetch(url("sync"), { method: "POST", body: JSON.stringify({ action: "outdated", file: "design/wireframe/vendas/itens.tsx", note: "x" }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).sync.find((i: any) => i.wireframe === "design/wireframe/vendas/itens.tsx").outdated[0].note).toBe("x");
    expect((await fetch(url("sync"), { method: "POST", body: JSON.stringify({ action: "nope", file: "a" }) })).status).toBe(400);
    expect((await fetch(url("map.js").replace(/\?.*/, ""))).status).toBe(200);
  } finally { daemon.kill(); await daemon.exited; }
});
