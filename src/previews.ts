import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPreview, previewOf } from "./render";
import { tsxInfo } from "./tsx";

export const isReactComponent = (file: string) => /^design\/(components|features)\//.test(file) && file.endsWith(".tsx")
  && !file.includes("/previews/") && !isPreview(file) && !file.split("/").pop()!.startsWith("_");

/** Inline examples take precedence; existing sidecars remain valid entries. */
export function componentPreview(root: string, file: string): { file: string; inline: boolean } | undefined {
  if (tsxInfo(readFileSync(join(root, file), "utf8"), file).preview) return { file, inline: true };
  const sidecar = previewOf(file);
  if (existsSync(join(root, sidecar))) return { file: sidecar, inline: false };
}
