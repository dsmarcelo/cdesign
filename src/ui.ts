import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

type UiBundle = { stamp: number; assets: Map<string, Blob> };
let cached: Promise<UiBundle> | null = null;
let cachedStamp = -1;

function uiStamp(dir: string): number {
  let max = 0;
  for (const name of readdirSync(dir)) {
    if (!/\.(tsx?|css)$/.test(name)) continue;
    const m = statSync(join(dir, name)).mtimeMs;
    if (m > max) max = m;
  }
  return max;
}

async function buildUi(dir: string, stamp: number): Promise<UiBundle> {
  const res = await Bun.build({
    entrypoints: [join(dir, "main.tsx")],
    target: "browser",
    format: "esm",
    publicPath: "/__cd/app/",
    naming: "[name].[ext]",
    minify: process.env.NODE_ENV === "production",
  });
  if (!res.success) {
    throw new Error(res.logs.map((l) => l.message).join("\n") || "Failed to build cdesign UI");
  }
  const assets = new Map<string, Blob>();
  for (const out of res.outputs) {
    assets.set(basename(out.path), out);
  }
  return { stamp, assets };
}

export async function uiAsset(dir: string, name: string): Promise<Blob | undefined> {
  const stamp = uiStamp(dir);
  if (!cached || stamp !== cachedStamp) {
    cachedStamp = stamp;
    cached = buildUi(dir, stamp).catch((err) => {
      cached = null;
      cachedStamp = -1;
      throw err;
    });
  }
  return (await cached).assets.get(name);
}
