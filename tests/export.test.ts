import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportWebsite, websitePages, previewWebsite } from '../src/export';
import { configurePublisher, publishWebsite, deploymentURL, shareScreen, listShares, deleteShare } from '../src/publish';

const dirs: string[]=[];
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'cdesign-export-'));dirs.push(root);const put=(file:string,body:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),body);};put('design/cdesign.json',JSON.stringify({version:1,mode:'react',tailwind:false}));return {root,put};};
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

test('React export preserves stateful code, maps dynamic navigation and bundles dependencies without viewer instrumentation',async()=>{
 const {root,put}=fixture();
 put('design/features/nav.ts',`export const here=()=>location.pathname.replace(/^\\/p\\//,'');export const go=(file:string)=>{location.href=\`/p/\${file}\`};`);
 put('design/components/Counter.tsx',`import {useState} from 'react';export default function Counter(){const [n,set]=useState(0);return <button onClick={()=>set(n+1)}>Count {n}</button>}`);
 put('design/pages/Home.tsx',`import Counter from '../components/Counter';import {go,here} from '../features/nav';export default function Home(){return <main><Counter/><button onClick={()=>go('design/pages/Other.tsx')}>Other</button><p>{here()}</p></main>}`);
 put('design/pages/Other.tsx',`export default function Other(){return <h1>Other</h1>}`);
 put('design/prototype/Secret.tsx',`export default ()=> <div>Secret</div>`);
 expect(websitePages(root)).toEqual(['design/pages/Home.tsx','design/pages/Other.tsx']);
 const {directory,manifest}=await exportWebsite(root,{name:'example',start:'design/pages/Home.tsx'});
 expect(manifest.routes['design/pages/Other.tsx']).toBe('/example/Other/');
 const html=readFileSync(join(directory,'example/index.html'),'utf8');
 expect(html).not.toContain('overlay.js');expect(html).not.toContain('data-cd-file');expect(html).toContain('window.__cdesign');
 const {projectFiles}=await import('../src/project');
 const js=projectFiles(directory).filter(f=>f.endsWith('.js')).map(f=>readFileSync(join(directory,f),'utf8')).join('');
 expect(js).toContain('__cdesign.navigate');expect(js).not.toContain('data-cd-uses');expect(js).not.toContain('Secret');
 const server=previewWebsite(directory);
 try{const base=`http://127.0.0.1:${server.port}`;expect((await fetch(base+'/example/Other/')).status).toBe(200);expect((await fetch(base+'/example/missing/')).status).toBe(404);expect((await fetch(base+'/website.json')).status).toBe(404);}finally{server.stop(true);}
});

test('HTML export expands components, rewrites pages and includes referenced CSS, fonts and images',async()=>{
 const {root,put}=fixture();
 put('design/cdesign.json',JSON.stringify({version:1,mode:'html',tailwind:false}));
 put('design/_head.html','<link rel="stylesheet" href="styles.css">');
 put('design/styles.css','body{background:url("./assets/bg.svg")}');put('design/assets/bg.svg','<svg/>');
 put('design/components/card.html','<section><slot></slot></section>');
 put('design/assets/helper.js',"export const value='included module';");put('design/assets/main.js',"import {value} from './helper.js'; window.example=value;");
 put('design/pages/home.html','<script type="module" src="/design/assets/main.js"></script><c-card><a href="./other.html">Other</a><img src="/design/assets/bg.svg"></c-card>');put('design/pages/other.html','<h1>Other</h1>');
 const result=await exportWebsite(root,{name:'html',start:'design/pages/home.html'});
 const html=readFileSync(join(result.directory,'html/index.html'),'utf8');
 expect(html).toContain('<section>');expect(html).toContain('href="/html/other/"');expect(html).not.toContain('data-cd-');expect(html).not.toContain('<c-card');
 const cssPath=html.match(/href="(\/html\/assets\/[^\"]+\.css)"/)![1];
 expect(readFileSync(join(result.directory,cssPath),'utf8')).toContain('/html/assets/');
});

test('failed export retains previous output; excluded imports, missing links, duplicate routes and source overwrites fail',async()=>{
 const {root,put}=fixture();put('design/pages/home.tsx','export default ()=> <h1>Good</h1>');
 const options={name:'safe',start:'design/pages/home.tsx'};
 const first=await exportWebsite(root,options);const original=readFileSync(join(first.directory,'safe/index.html'),'utf8');
 put('design/prototype/secret.ts','export default "secret"');put('design/pages/home.tsx','import secret from "../prototype/secret";export default ()=> <p>{secret}</p>');
 await expect(exportWebsite(root,options)).rejects.toThrow('Excluded export dependency');
 expect(readFileSync(join(first.directory,'safe/index.html'),'utf8')).toBe(original);
 await expect(exportWebsite(root,options,join(root,'design'))).rejects.toThrow('Output must');
 put('design/pages/home.tsx','export default ()=> <h1>Good</h1>');put('design/pages/home.html','<h1>Collision</h1>');
 await expect(exportWebsite(root,options)).rejects.toThrow('Duplicate website route');
});

test('publisher preserves other websites, rejects collisions and keeps the previous snapshot on deployment failure',async()=>{
 const a=fixture(),b=fixture(),publisher=fixture();
 const oldHome=process.env.CDESIGN_HOME;process.env.CDESIGN_HOME=join(publisher.root,'home');
 try{
 publisher.put('.vercel/project.json',JSON.stringify({projectId:'prj_test',orgId:'team_test'}));configurePublisher(publisher.root,'https://example.vercel.app');
 a.put('design/pages/home.tsx','export default ()=> <h1>A</h1>');b.put('design/pages/home.tsx','export default ()=> <h1>B</h1>');
 const calls:string[][]=[];
 const run=async(args:string[],cwd:string)=>{calls.push(args);if(args[0]==='deploy')expect(existsSync(join(cwd,'.vercel/output/config.json'))).toBe(true);return args[0]==='deploy'?JSON.stringify({status:'ok',deployment:{url:'https://example-123.vercel.app',readyState:'READY'}}):'';};
 await publishWebsite(a.root,{name:'alpha',start:'design/pages/home.tsx'},run);
 await publishWebsite(b.root,{name:'beta',start:'design/pages/home.tsx'},async(args,cwd)=>{if(args[0]==='deploy')expect(existsSync(join(cwd,'.vercel/output/static/alpha/index.html'))).toBe(true);return run(args,cwd);});
 expect(calls.some(a=>a.includes('--prebuilt')&&a.includes('--prod'))).toBe(true);
 const records=readFileSync(join(publisher.root,'sites.json'),'utf8');
 await expect(publishWebsite(a.root,{name:'alpha',start:'design/pages/home.tsx'},async()=>{throw Error('Offline');})).rejects.toThrow('Offline');
 expect(readFileSync(join(publisher.root,'sites.json'),'utf8')).toBe(records);
 await expect(publishWebsite(b.root,{name:'alpha',start:'design/pages/home.tsx'},run)).rejects.toThrow('another local project');
 expect(existsSync(join(publisher.root,'publish.lock'))).toBe(false);
 }finally{if(oldHome===undefined)delete process.env.CDESIGN_HOME;else process.env.CDESIGN_HOME=oldHome;}
});


test('deployment URL parser handles noninteractive JSON, plain JSON and legacy stdout without accepting failed results',()=>{
 const url='https://example-123.vercel.app';
 expect(deploymentURL(JSON.stringify({status:'ok',deployment:{url,readyState:'READY'},message:'Ready'}))).toBe(url);
 expect(deploymentURL(JSON.stringify({url,readyState:'READY'}))).toBe(url);
 expect(deploymentURL(url+'\n')).toBe(url);
 expect(deploymentURL(JSON.stringify({status:'ok',deployment:{url:'example-123.vercel.app',readyState:'READY'}}))).toBe(url);
 expect(()=>deploymentURL(JSON.stringify({status:'error',message:'Upload failed',deployment:{url}}))).toThrow('Upload failed');
 expect(()=>deploymentURL(JSON.stringify({url,readyState:'ERROR'}))).toThrow('ERROR');
 expect(()=>deploymentURL(JSON.stringify({status:'ok',message:url}))).toThrow('no recognized deployment URL');
 expect(()=>deploymentURL(JSON.stringify({url:'https://vercel.app.attacker.example/'}))).toThrow('no recognized deployment URL');
});

test('shared screens are single-page, navigation-locked, unguessable and deletable without touching other sites',async()=>{
 const a=fixture(),b=fixture(),publisher=fixture();
 const oldHome=process.env.CDESIGN_HOME;process.env.CDESIGN_HOME=join(publisher.root,'home');
 try{
 publisher.put('.vercel/project.json',JSON.stringify({projectId:'prj_test',orgId:'team_test'}));configurePublisher(publisher.root,'https://example.vercel.app');
 a.put('design/pages/Home.tsx',`export default ()=> <main><a href="./Other.tsx">Other</a><a href="https://example.org">Out</a><button onClick={()=>{location.href='/p/design/pages/Other.tsx'}}>Go</button></main>`);
 a.put('design/pages/Other.tsx','export default ()=> <h1>Other</h1>');
 a.put('design/pages/page.html','<a href="./Other.tsx">Other</a><h1>Plain</h1>');
 b.put('design/pages/home.tsx','export default ()=> <h1>B</h1>');
 const deployed:string[][]=[];
 const run=async(args:string[],cwd:string)=>{if(args[0]==='deploy'){deployed.push(['alpha',join(cwd,'.vercel/output/static')]);return JSON.stringify({status:'ok',deployment:{url:'https://example-123.vercel.app',readyState:'READY'}});}return '';};
 await publishWebsite(b.root,{name:'beta',start:'design/pages/home.tsx'},run);
 const first=await shareScreen(a.root,'design/pages/Home.tsx',run), second=await shareScreen(a.root,'design/pages/Home.tsx',run);
 expect(first.name).toMatch(/^s-[0-9a-f]{16}$/);expect(first.name).not.toBe(second.name);expect(first.url).toBe(`https://example.vercel.app/${first.name}/`);
 const site=join(publisher.root,'home/..','sites',first.name);
 const html=readFileSync(join(site,'index.html'),'utf8');
 expect(html).toContain('noindex');expect(html).toContain('navigate:()=>{}');expect(html).not.toContain('Other/');expect(existsSync(join(site,'Other'))).toBe(false);
 expect(readFileSync(join(publisher.root,'sites.json'),'utf8')).toContain('"share"');
 await shareScreen(a.root,'design/pages/page.html',run);
 await expect(shareScreen(a.root,'design/prototype/x.tsx',run)).rejects.toThrow('Only pages in design/pages');
 expect(listShares(a.root).length).toBe(3);expect(listShares(b.root)).toEqual([]);
 await expect(deleteShare(b.root,first.name,run)).rejects.toThrow('not found');
 await expect(deleteShare(a.root,'beta',run)).rejects.toThrow('not found');
 await expect(deleteShare(a.root,first.name,async()=>{throw Error('Offline');})).rejects.toThrow('Offline');
 expect(listShares(a.root).length).toBe(3);
 let staticDir='';
 await deleteShare(a.root,first.name,async(args,cwd)=>{if(args[0]==='deploy'){staticDir=join(cwd,'.vercel/output/static');expect(existsSync(join(staticDir,first.name))).toBe(false);expect(existsSync(join(staticDir,second.name,'index.html'))).toBe(true);expect(existsSync(join(staticDir,'beta/index.html'))).toBe(true);expect(readFileSync(join(staticDir,'robots.txt'),'utf8')).toContain('Disallow: /');}return run(args,cwd);});
 expect(staticDir).not.toBe('');expect(listShares(a.root).map(s=>s.name)).not.toContain(first.name);expect(existsSync(site)).toBe(false);
 }finally{if(oldHome===undefined)delete process.env.CDESIGN_HOME;else process.env.CDESIGN_HOME=oldHome;}
});
