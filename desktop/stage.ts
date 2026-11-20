import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tauri = join(root, "src-tauri");
const runtime = join(tauri, "runtime");
const binaries = join(tauri, "binaries");
const host = Bun.spawnSync(["rustc", "-vV"]);
const triple = /^host: (.+)$/m.exec(host.stdout.toString())?.[1].trim();
if (!triple || !/^(x86_64|aarch64)-(unknown-linux-gnu|pc-windows-msvc)$/.test(triple)) {
  throw new Error("Build cdesign with a native Linux GNU or Windows MSVC Rust toolchain.");
}

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(binaries, { recursive: true });
for (const entry of ["src", "ui", "skills", "package.json", "bun.lock"]) {
  cpSync(join(root, entry), join(runtime, entry), { recursive: true });
}
const install = Bun.spawnSync([process.execPath, "install", "--production", "--frozen-lockfile"], {
  cwd: runtime,
  stdio: ["ignore", "inherit", "inherit"],
});
if (install.exitCode !== 0) throw new Error("Could not install cdesign's desktop runtime dependencies.");

rmSync(join(runtime, "node_modules", ".bin"), { recursive: true, force: true });

const suffix = process.platform === "win32" ? ".exe" : "";
if (process.env.CDESIGN_DESKTOP_SYSTEM_BUN !== "1") {
  cpSync(process.execPath, join(binaries, `cdesign-bun-${triple}${suffix}`));
}
