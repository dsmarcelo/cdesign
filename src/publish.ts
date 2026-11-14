import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { homeDir } from "./store";
import { exportWebsite, websiteName, websitePages, saveWebsite, type WebsiteOptions } from "./export";

type PublisherConfig = { directory: string; origin: string; projectId: string; orgId: string };
type Published = { root: string; url: string; publishedAt: string; deployment: string; share?: { page: string } };
export const publisherDirectory = () => join(homeDir(), "publisher");
const configuration = () => join(homeDir(), "publisher.json");
const read = <T>(path: string, fallback: T): T => existsSync(path) ? JSON.parse(readFileSync(path,"utf8")) : fallback;
export function publisherConfig(): PublisherConfig | undefined { return read(configuration(), undefined); }
export function configurePublisher(directory: string, origin: string) {
  directory = resolve(directory);
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Publisher origin must be an HTTPS origin, e.g. https://cdesign-ds.vercel.app");
  const link = read<{projectId?: string; orgId?: string}>(join(directory,".vercel/project.json"), {});
  if (!link.projectId || !link.orgId) throw new Error(`First run vercel link in ${directory}, choosing the shared cdesign project`);
  const config: PublisherConfig = {directory, origin:url.origin, projectId:link.projectId, orgId:link.orgId};
  mkdirSync(homeDir(), {recursive:true}); writeFileSync(configuration(),JSON.stringify(config,null,2)+'\n');
  return config;
}
export function publishingStatus(root: string, name?: string) {
  const config = publisherConfig();
  const records = config ? read<Record<string,Published>>(join(config.directory,"sites.json"),{}) : {};
  const previous = Object.entries(records).find(([slug, p]) => p.root === root && !p.share && (!name || slug === name));
  return { configured:!!config, origin:config?.origin, previous: previous ? {name:previous[0],...previous[1]} : undefined,
    setup: `mkdir -p "${publisherDirectory()}"\ncd "${publisherDirectory()}"\nvercel login\nvercel link\ncdesign publish setup --project-dir "${publisherDirectory()}" --origin https://cdesign-ds.vercel.app` };
}
export async function vercelCommand(args: string[], cwd: string) {
  const binary = Bun.which("vercel");
  if (!binary) throw new Error("Install Vercel CLI and run vercel login before publishing");
  const proc = Bun.spawn([binary,...args], {cwd, stdin:"ignore",stdout:"pipe",stderr:"pipe", env:{...process.env,VERCEL_TELEMETRY_DISABLED:"1"}});
  const timer = setTimeout(() => proc.kill(), 10 * 60 * 1000);
  try {
    const [stdout,stderr,exit] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
    if (exit !== 0) throw new Error(`Vercel ${args[0]} failed: ${(stderr || stdout).slice(-4000)}`);
    return stdout.trim();
  } finally {clearTimeout(timer);}
}

/** Current noninteractive CLI output wraps the deployment in an agent result. */
export function deploymentURL(output: string): string {
  const text = output.trim();
  let candidate: unknown;
  if (text.startsWith("{")) {
    const result = JSON.parse(text);
    if (result.status && result.status !== "ok") throw new Error(result.message || result.error?.message || `Vercel deployment status: ${result.status}`);
    const deployment = result.deployment ?? result;
    if (deployment.readyState && deployment.readyState !== "READY") throw new Error(`Vercel deployment is ${deployment.readyState}, not READY`);
    candidate = deployment.url;
  } else {
    candidate = text.split(/\s+/).reverse().find(s => /^https:\/\/[a-z0-9.-]+\.vercel\.app\/?$/i.test(s));
  }
  if (typeof candidate === 'string') {
    const url = new URL(candidate.startsWith('https://') ? candidate : `https://${candidate}`);
    if (url.protocol === 'https:' && url.hostname.endsWith('.vercel.app') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  }
  throw new Error("Vercel finished but returned no recognized deployment URL. The website may already be live; check Vercel deployment status.");
}

type Records = Record<string, Published>;
const publisherRoot = (config: PublisherConfig) => join(config.directory, "sites");
const writeRecords = (config: PublisherConfig, records: Records) => {
  writeFileSync(join(config.directory, "sites.json.next"), JSON.stringify(records, null, 2) + '\n');
  renameSync(join(config.directory, "sites.json.next"), join(config.directory, "sites.json"));
};

/** The directory lock serializes CLI and daemon publications, including artifact assembly. */
async function withPublisher<T>(work: (config: PublisherConfig, records: Records, job: string) => Promise<T>): Promise<T> {
  const config = publisherConfig();
  if (!config) throw new Error("Publishing is not configured. Run cdesign publish setup --project-dir <linked-folder> --origin https://cdesign-ds.vercel.app");
  mkdirSync(config.directory, {recursive:true});
  const lock = join(config.directory,"publish.lock");
  try {mkdirSync(lock);} catch {throw new Error(`A publication is already running. If it was interrupted, remove ${lock} after checking no publisher is active.`);}
  const job = join(config.directory,"jobs",randomUUID());
  try {
    const link = read<{projectId?:string;orgId?:string}>(join(config.directory,".vercel/project.json"),{});
    if (link.projectId !== config.projectId || link.orgId !== config.orgId) throw new Error("Publisher Vercel link changed. Run publish setup again to select the intended project.");
    return await work(config, read<Records>(join(config.directory,"sites.json"),{}), job);
  } finally {rmSync(job,{recursive:true,force:true});rmSync(lock,{recursive:true,force:true});}
}

/** Assemble every saved site (minus `skip`, plus `extra`: slug -> built directory) into one prebuilt Vercel deployment. */
async function deployStatic(config: PublisherConfig, records: Records, job: string, run: typeof vercelCommand, skip: string[] = [], extra: Record<string,string> = {}) {
  const deploy = join(job,"deploy"), output = join(deploy,".vercel/output"), staticDir = join(output,"static");
  mkdirSync(staticDir,{recursive:true});
  const slugs = Object.keys(records).filter(slug => !skip.includes(slug) && !(slug in extra));
  for (const slug of slugs) {
    websiteName(slug);
    const snapshot = join(publisherRoot(config),slug);
    if (!existsSync(snapshot)) throw new Error(`Missing published artifact for ${slug}; restore the publisher directory before updating`);
    cpSync(snapshot, join(staticDir,slug),{recursive:true});
  }
  for (const [slug,directory] of Object.entries(extra)) cpSync(join(directory,slug),join(staticDir,slug),{recursive:true});
  slugs.push(...Object.keys(extra));
  // Shared screens are unlisted: keep crawlers away from the whole origin.
  writeFileSync(join(staticDir,"robots.txt"),"User-agent: *\nDisallow: /\n");
  // Explicit route mapping gives static hosts clean directory URLs and real 404s.
  const routes: object[] = [];
  const scan = (dir:string, prefix:string) => {for(const e of readdirSync(dir,{withFileTypes:true})) {const p=join(dir,e.name), url=prefix+'/'+e.name; if(e.isDirectory())scan(p,url);else if(e.name==='index.html') {const page=url.slice(0,-10); const escaped=page.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); routes.push({src:escaped.slice(0,-1),status:308,headers:{Location:page}},{src:escaped,dest:url});}}};
  scan(staticDir,"");
  for (const slug of slugs) routes.unshift({src:`/${slug}`,status:308,headers:{Location:`/${slug}/`}});
  routes.push({handle:"filesystem"});
  writeFileSync(join(output,"config.json"),JSON.stringify({version:3,routes}));
  mkdirSync(join(deploy,".vercel"),{recursive:true});
  writeFileSync(join(deploy,".vercel/project.json"),JSON.stringify({projectId:config.projectId,orgId:config.orgId}));
  // Inspect resolves the existing link without permitting implicit project creation.
  await run(["project","inspect","--non-interactive"],deploy);
  const result = await run(["deploy","--prebuilt","--prod","--yes","--non-interactive","--json"],deploy);
  return { deployment: deploymentURL(result), staticDir };
}

export async function publishWebsite(root: string, options: WebsiteOptions, run = vercelCommand, share?: { page: string }) {
  websiteName(options.name);
  return withPublisher(async (config, records, job) => {
    if (records[options.name] && records[options.name].root !== root) throw new Error(`Website name ${options.name} belongs to another local project; choose another name`);
    const built = await exportWebsite(root, options, join(job,"export"));
    const {deployment, staticDir} = await deployStatic(config, records, job, run, [], {[options.name]:built.directory});
    const published: Published = {root,url:`${config.origin}/${options.name}/`,publishedAt:new Date().toISOString(),deployment,...(share ? {share} : {})};
    const snapshot = join(publisherRoot(config),options.name), next = snapshot+'.next', previous = snapshot+'.previous';
    mkdirSync(publisherRoot(config),{recursive:true});
    rmSync(next,{recursive:true,force:true}); cpSync(join(staticDir,options.name),next,{recursive:true});
    rmSync(previous,{recursive:true,force:true}); if(existsSync(snapshot))renameSync(snapshot,previous); renameSync(next,snapshot);
    records[options.name] = published;
    writeRecords(config, records);
    if (!options.locked) saveWebsite(root, options);
    return published;
  });
}

export type Share = { name: string; url: string; page: string; publishedAt: string };
const shareOf = (name: string, p: Published): Share => ({name, url:p.url, page:p.share!.page, publishedAt:p.publishedAt});
export function listShares(root: string): Share[] {
  const config = publisherConfig();
  if (!config) return [];
  return Object.entries(read<Records>(join(config.directory,"sites.json"),{})).filter(([, p]) => p.root === root && p.share)
    .map(([name, p]) => shareOf(name, p)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** Publish one page as an unlisted, navigation-locked site at an unguessable address. */
export async function shareScreen(root: string, page: string, run = vercelCommand): Promise<Share> {
  if (!websitePages(realpathSync(root)).includes(page)) throw new Error("Only pages in design/pages can be shared. Open a page first.");
  const name = "s-" + randomBytes(8).toString("hex");
  return shareOf(name, await publishWebsite(root, {name, start:page, pages:[page], locked:true}, run, {page}));
}

/** Redeploy without the share, then drop its snapshot; a failed deployment leaves it live and listed. */
export async function deleteShare(root: string, name: string, run = vercelCommand) {
  websiteName(name);
  return withPublisher(async (config, records, job) => {
    const record = records[name];
    if (!record?.share || record.root !== root) throw new Error("Shared link not found");
    await deployStatic(config, records, job, run, [name]);
    delete records[name];
    writeRecords(config, records);
    const snapshot = join(publisherRoot(config),name);
    for (const path of [snapshot, snapshot+'.previous', snapshot+'.next']) rmSync(path,{recursive:true,force:true});
  });
}
