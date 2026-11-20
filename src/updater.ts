import { lstatSync, realpathSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

type Archive = { kind: "archive"; repo: string; ref: string; sha: string };
type Candidate = { kind: "archive" | "checkout"; sha: string } | { kind: "reload" };
const isSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const runtimeDirs = ["src", "ui", "skills"];

async function run(cmd: string[], cwd: string, env?: NodeJS.ProcessEnv, timeout = 30_000) {
  const proc = Bun.spawn(cmd, {
    cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(timeout),
  });
  const [output, error, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(error.trim().split("\n").at(-1) || `${cmd[0]} exited with status ${code}`);
  return output.trim();
}

export class Updater {
  readonly archive: Archive | undefined;
  readonly linked: boolean;
  private readonly baseline: string;
  private cached: Candidate | null = null;
  private checkedAt = 0;
  private checking: Promise<void> | undefined;

  constructor(
    readonly root = resolve(import.meta.dir, ".."),
    link = process.env.CDESIGN_INSTALL_LINK ?? "",
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  ) {
    try { this.linked = lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(root); }
    catch { this.linked = false; }
    try {
      const a = JSON.parse(readFileSync(join(root, ".install.json"), "utf8"));
      if (!this.linked && a.kind === "archive" && /^[\w.-]+\/[\w.-]+$/.test(a.repo) &&
          typeof a.ref === "string" && a.ref && isSha(a.sha)) this.archive = a;
    } catch { /* Legacy, unpackaged, or native install. */ }
    this.baseline = this.linked ? this.fingerprint() : "";
  }

  private fingerprint() {
    const hash = new Bun.CryptoHasher("sha256");
    const add = (path: string) => {
      hash.update(path + "\0");
      try {
        const full = join(this.root, path);
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          for (const entry of readdirSync(full).sort()) add(join(path, entry));
        } else if (stat.isFile()) {
          hash.update(String(stat.size) + "\0");
          hash.update(readFileSync(full));
        }
      } catch { /* Absent files are part of the snapshot. */ }
    };
    for (const path of [...runtimeDirs, "package.json", "bun.lock", "install.sh"]) add(path);
    return hash.digest("hex");
  }

  private git(...args: string[]) {
    return run(["git", ...args], this.root, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
  }

  private async github(path: string) {
    const response = await this.request(`https://api.github.com/repos/${this.archive!.repo}/${path}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    return response.json();
  }

  async check(): Promise<Candidate | null> {
    if (this.linked) {
      if (this.fingerprint() !== this.baseline) return { kind: "reload" };
      try {
        await this.git("rev-parse", "--verify", "@{upstream}");
        if (await this.git("status", "--porcelain")) return null;
        await this.git("fetch", "--quiet");
        const upstream = await this.git("rev-parse", "--verify", "@{upstream}");
        if (!isSha(upstream) || upstream === await this.git("rev-parse", "HEAD")) return null;
        await this.git("merge-base", "--is-ancestor", "HEAD", upstream);
        return { kind: "checkout", sha: upstream };
      } catch { return null; }
    }
    if (this.archive) {
      try {
        const { sha } = await this.github("commits/" + encodeURIComponent(this.archive.ref));
        if (!isSha(sha) || sha === this.archive.sha) return null;
        const { status } = await this.github(`compare/${this.archive.sha}...${sha}`);
        if (status === "ahead") return { kind: "archive", sha };
      } catch { /* A failed check leaves the current install usable. */ }
    }
    return null;
  }

  get supported() { return Boolean(this.archive || this.linked); }

  async verifyRuntime() {
    await run([process.execPath, join(this.root, "src/cli.ts"), "help"], this.root);
  }

  async apply(candidate?: Candidate) {
    await this.checking;
    candidate ??= await this.check();
    if (!candidate) throw new Error("No update could be verified. Check your connection or checkout and try again.");
    if (candidate.kind === "reload") return;
    if (candidate.kind === "checkout") {
      if (await this.git("status", "--porcelain")) throw new Error("The checkout changed. Save your work and try again.");
      await this.git("merge", "--ff-only", candidate.sha);
      return;
    }
    const { repo, ref } = this.archive!;
    await run(["bash", join(this.root, "install.sh")], this.root, {
      ...process.env, CDESIGN_HOME: this.root, CDESIGN_REPO: repo, CDESIGN_REF: ref,
      CDESIGN_SRC: "", CDESIGN_INSTALL_SHA: candidate.sha, CDESIGN_INSTALL_UPDATE: "1",
    }, 600_000);
  }

  status() {
    if (!this.supported) return { available: false, checking: false };
    const interval = this.linked ? 60_000 : 300_000;
    if (!this.checking && (!this.checkedAt || Date.now() - this.checkedAt >= interval)) {
      this.checking = this.check().then((candidate) => { this.cached = candidate?.kind === "reload" ? null : candidate; }).finally(() => {
        this.checkedAt = Date.now();
        this.checking = undefined;
      });
    }
    return { available: Boolean(this.cached) || (this.linked && this.fingerprint() !== this.baseline), checking: Boolean(this.checking) };
  }
}
