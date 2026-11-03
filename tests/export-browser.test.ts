import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportWebsite, previewWebsite } from '../src/export';
import { projectId } from '../src/store';
const chrome=process.env.CDESIGN_CHROME ?? Bun.which('google-chrome') ?? Bun.which('chromium');
async function until(fn:()=>Promise<any>,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){try{const value=await fn();if(value)return value;}catch{}await Bun.sleep(30);}throw Error('Timed out waiting for exported website');}

test.skipIf(!chrome)('browser: standalone navigation, hooks, storage isolation, refresh, HTML and viewer export dialog',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cdesign-export-browser-'));
 const put=(file:string,body:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),body);};
 put('design/cdesign.json',JSON.stringify({version:1,mode:'react',tailwind:true}));
 put('design/design-system.md','# Example');
 put('design/pages/Home.tsx',`import {useState} from 'react';export default function Home(){const [n,set]=useState(0);return <main><button className="p-4" id="count" onClick={()=>{set(n+1);sessionStorage.setItem('count',String(n+1));}}>Count {n}</button><button id="next" onClick={()=>location.href='/p/design/pages/Other.tsx'}>Other</button></main>}`);
 put('design/pages/Other.tsx',`export default function Other(){return <main><h1>Other</h1><p id="saved">{sessionStorage.getItem('count')}</p><p id="source">{location.pathname.replace(/^\\/p\\//,'')}</p><button id="back" onClick={()=>location.assign('/p/design/pages/Home.tsx')}>Back</button></main>}`);
 put('design/pages/plain.html','<h1>Plain HTML</h1><a href="/p/design/pages/Home.tsx">Home</a>');
 const artifact=await exportWebsite(root,{name:'demo',start:'design/pages/Home.tsx'});
 const server=previewWebsite(artifact.directory);
 const base=`http://127.0.0.1:${server.port}`;
 const browser=Bun.spawn([chrome!,'--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${join(root,'.cdesign/chrome')}`,'about:blank'],{stdout:'ignore',stderr:'pipe'});
 let socket:WebSocket|undefined,daemon:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const ws=await new Promise<string>((ok,fail)=>{const timer=setTimeout(()=>fail(Error('Chrome failed to start')),15000);(async()=>{let buffer='';for await(const chunk of browser.stderr as ReadableStream<Uint8Array>){buffer+=new TextDecoder().decode(chunk);const m=buffer.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);ok(m[1]);return;}}})().catch(fail);});
  socket=new WebSocket(ws);await new Promise<void>((ok,fail)=>{socket!.onopen=()=>ok();socket!.onerror=()=>fail(Error('CDP failed'));});
  let id=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  socket.onmessage=e=>{const m=JSON.parse(String(e.data)),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
  const send=(method:string,params:object={},sessionId?:string):Promise<any>=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket!.send(JSON.stringify({id:n,method,params,sessionId}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const cmd=(method:string,params={})=>send(method,params,sessionId);
  const ev=async(expression:string)=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r.result.value;};
  const navigate=async(url:string,selector:string)=>{await cmd('Page.navigate',{url});await until(()=>ev(`document.readyState==='complete' && !!document.querySelector(${JSON.stringify(selector)}) && window.__cdReady!==false`));};
  await cmd('Page.enable');
  await navigate(base+'/demo/','#count');
  expect(await ev("getComputedStyle(document.querySelector('#count')).padding")).toBe('16px');
  expect(await ev("document.querySelector('[data-cd-file]')===null")).toBe(true);
  await ev("document.querySelector('#count').click()");await until(()=>ev("document.querySelector('#count').textContent==='Count 1'"));
  expect(await ev("sessionStorage.getItem('count')")).toBe('1');
  expect(await ev("Storage.prototype.getItem.call(sessionStorage,'cdesign:demo:count')")).toBe('1');
  await ev("document.querySelector('#next').click()");await until(()=>ev("location.pathname==='/demo/Other/' && !!document.querySelector('#saved')"));
  expect(await ev("document.querySelector('#saved').textContent")).toBe('1');expect(await ev("document.querySelector('#source').textContent")).toBe('design/pages/Other.tsx');
  await cmd('Page.reload');await until(()=>ev("document.readyState==='complete' && document.querySelector('#saved')?.textContent==='1'"));
  await navigate(base+'/demo/plain/','a');await ev("document.querySelector('a').click()");await until(()=>ev("location.pathname==='/demo/Home/' && !!document.querySelector('#count')"));
  if (process.env.CDESIGN_EXPORT_EXAMPLE) {
    const example=process.env.CDESIGN_EXPORT_EXAMPLE;
    const built=await exportWebsite(example,{name:'mapvendas',start:'design/pages/vendas.tsx'},join(root,'.cdesign/example'));
    const exampleServer=previewWebsite(built.directory), origin=`http://127.0.0.1:${exampleServer.port}`;
    try {
      for (const route of Object.values(built.manifest.routes)) {
        await navigate(origin+route,'#__cd-root > *');
        expect(await ev("document.querySelector('#__cd-error')?.textContent || null")).toBe(null);
      }
      await navigate(origin+'/mapvendas/','#__cd-root > *');
      await ev("[...document.querySelectorAll('button,[role=button]')].find(b=>b.textContent.trim()==='Produtos').click()");
      await until(()=>ev("location.pathname==='/mapvendas/products/' && window.__cdReady===true"));
      expect(await ev("document.body.textContent.includes('Produtos')")).toBe(true);
      await cmd('Page.reload');await until(()=>ev("window.__cdReady===true && !!document.querySelector('#__cd-root > *')"));
      expect(await ev("document.querySelector('#__cd-error')?.textContent || null")).toBe(null);
      console.log(`Verified ${built.manifest.pages!.length} example pages, sidebar navigation and refresh`);
    } finally {exampleServer.stop(true);}
  }
  const home=join(root,'.cdesign/test-home');mkdirSync(home,{recursive:true});
  daemon=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'serve',root,'--port','0'],{env:{...process.env,CDESIGN_HOME:home,CDESIGN_IDLE_SECONDS:'300'},stdout:'ignore',stderr:'pipe'});
  const state=await until(async()=>existsSync(join(home,'daemon.json'))?JSON.parse(readFileSync(join(home,'daemon.json'),'utf8')):null);
  const viewer=`http://${projectId(root)}.localhost:${state.port}`;
  await navigate(viewer+'/#design/pages/Home.tsx','#website');await ev("document.querySelector('#website').click()");
  await until(()=>ev("document.querySelector('#website-dialog').open"));
  expect(await ev("document.querySelectorAll('#website-pages input').length")).toBe(3);
  expect(await ev("document.querySelector('#website-publish').disabled")).toBe(true);
  await ev("document.querySelector('#website-preview').click()");
  await until(()=>ev("!document.querySelector('#website-result').hidden"));
  expect(await ev("document.querySelector('#website-open').href")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cdesign-export-browser-/);
  expect(await ev("document.querySelector('#website-status').textContent")).toContain('Export ready');
 }finally{socket?.close();browser.kill();daemon?.kill();if(daemon)await daemon.exited;await browser.exited;server.stop(true);rmSync(root,{recursive:true,force:true});}
},60000);
