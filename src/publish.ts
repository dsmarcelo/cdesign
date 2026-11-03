import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homeDir } from "./store";
import { exportWebsite, websiteName, saveWebsite, type WebsiteOptions } from "./export";

type PublisherConfig = { directory: string; origin: string; projectId: string; orgId: string };
type Published = { root: string; url: string; publishedAt: string; deployment: string };
export const publisherDirectory = () => join(homeDir(), "publisher");
const configuration = () => join(homeDir(), "publisher.json");
const read = <T>(path: string, fallback: T): T => existsSync(path) ? JSON.parse(readFileSync(path,"utf8")) : fallback;
export function publisherConfig(): PublisherConfig | undefined { return read(configuration(), undefined); }
export function configurePublisher(directory: string, origin: string) {
  directory = resolve(directory);
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Publisher origin must be an HTTPS origin, e.g. https://cdesign.vercel.app");
  const link = read<{projectId?: string; orgId?: string}>(join(directory,".vercel/project.json"), {});
  if (!link.projectId || !link.orgId) throw new Error(`First run vercel link in ${directory}, choosing the shared cdesign project`);
  const config: PublisherConfig = {directory, origin:url.origin, projectId:link.projectId, orgId:link.orgId};
  mkdirSync(homeDir(), {recursive:true}); writeFileSync(configuration(),JSON.stringify(config,null,2)+'\n');
  return config;
}
export function publishingStatus(root: string, name?: string) {
  const config = publisherConfig();
  const records = config ? read<Record<string,Published>>(join(config.directory,"sites.json"),{}) : {};
  const previous = Object.entries(records).find(([slug, p]) => p.root === root && (!name || slug === name));
  return { configured:!!config, origin:config?.origin, previous: previous ? {name:previous[0],...previous[1]} : undefined,
    setup: `mkdir -p "${publisherDirectory()}"\ncd "${publisherDirectory()}"\nvercel login\nvercel link\ncdesign publish setup --project-dir "${publisherDirectory()}" --origin https://cdesign.vercel.app` };
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

/** The directory lock serializes CLI and daemon publications, including artifact assembly. */
export async function publishWebsite(root: string, options: WebsiteOptions, run = vercelCommand) {
  websiteName(options.name);
  const config = publisherConfig();
  if (!config) throw new Error("Publishing is not configured. Run cdesign publish setup --project-dir <linked-folder> --origin https://cdesign.vercel.app");
  mkdirSync(config.directory, {recursive:true});
  const lock = join(config.directory,"publish.lock");
  try {mkdirSync(lock);} catch {throw new Error(`A publication is already running. If it was interrupted, remove ${lock} after checking no publisher is active.`);}
  const job = join(config.directory,"jobs",randomUUID());
  try {
    const link = read<{projectId?:string;orgId?:string}>(join(config.directory,".vercel/project.json"),{});
    if (link.projectId !== config.projectId || link.orgId !== config.orgId) throw new Error("Publisher Vercel link changed. Run publish setup again to select the intended project.");
    const records = read<Record<string,Published>>(join(config.directory,"sites.json"),{});
    if (records[options.name] && records[options.name].root !== root) throw new Error(`Website name ${options.name} belongs to another local project; choose another name`);
    const built = await exportWebsite(root, options, join(job,"export"));
    const deploy = join(job,"deploy"), output = join(deploy,".vercel/output"), staticDir = join(output,"static");
    mkdirSync(staticDir,{recursive:true});
    for (const slug of Object.keys(records)) {
      websiteName(slug);
      if (slug === options.name) continue;
      const snapshot = join(config.directory,"sites",slug);
      if (!existsSync(snapshot)) throw new Error(`Missing published artifact for ${slug}; restore the publisher directory before updating`);
      cpSync(snapshot, join(staticDir,slug),{recursive:true});
    }
    cpSync(join(built.directory,options.name),join(staticDir,options.name),{recursive:true});
    const slugs = [...new Set([...Object.keys(records),options.name])];
    // Explicit route mapping gives static hosts clean directory URLs and real 404s.
    const routes: object[] = [];
    const scan = (dir:string, prefix:string) => {for(const e of readdirSync(dir,{withFileTypes:true})) {const p=join(dir,e.name), url=prefix+'/'+e.name; if(e.isDirectory())scan(p,url);else if(e.name==='index.html') {const page=url.slice(0,-10); const escaped=page.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); routes.push({src:escaped.slice(0,-1),status:308,headers:{Location:page}},{src:escaped,dest:url});}}};
    scan(staticDir,"");
    for (const slug of slugs) routes.unshift({src:`/${slug}`,status:308,headers:{Location:`/${slug}/`}});
    routes.push({handle:"filesystem"});
    writeFileSync(join(output,"config.json"),JSON.stringify({version:3,routes}));
    mkdirSync(join(deploy,".vercel"),{recursive:true});
    writeFileSync(join(deploy,".vercel/project.json"),JSON.stringify(link));
    // Inspect resolves the existing link without permitting implicit project creation.
    await run(["project","inspect","--non-interactive"],deploy);
    const result = await run(["deploy","--prebuilt","--prod","--yes","--non-interactive"],deploy);
    const deployment = result.split(/\s+/).reverse().find(s=>/^https:\/\/[a-z0-9.-]+\.vercel\.app\/?$/i.test(s));
    if (!deployment) throw new Error("Vercel returned no deployment URL. Check Vercel status before retrying.");
    const published: Published = {root,url:`${config.origin}/${options.name}/`,publishedAt:new Date().toISOString(),deployment};
    const snapshot = join(config.directory,"sites",options.name), next = snapshot+'.next', previous = snapshot+'.previous';
    mkdirSync(join(config.directory,"sites"),{recursive:true});
    rmSync(next,{recursive:true,force:true}); cpSync(join(staticDir,options.name),next,{recursive:true});
    rmSync(previous,{recursive:true,force:true}); if(existsSync(snapshot))renameSync(snapshot,previous); renameSync(next,snapshot);
    records[options.name] = published;
    writeFileSync(join(config.directory,"sites.json.next"),JSON.stringify(records,null,2)+'\n'); renameSync(join(config.directory,"sites.json.next"),join(config.directory,"sites.json"));
    saveWebsite(root, options);
    return published;
  } finally {rmSync(job,{recursive:true,force:true});rmSync(lock,{recursive:true,force:true});}
}
