import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync} from 'node:fs';
import {ensureService} from '../../apps/cli/src/client';
const repo=resolve(import.meta.dir,'../..'),out=resolve(process.argv[2]!);mkdirSync(out,{recursive:true});
const production=resolve(repo,'../production/character-20261014/v2');
const state=JSON.parse(readFileSync(join(production,'batch-state.json'),'utf8'));
const service=await ensureService(join(production,'workspace'));
const built=await Bun.build({entrypoints:[join(repo,'apps/web/src/wholeReview.fixture.tsx')],target:'browser',outdir:join(out,'bundle'),naming:{entry:'review.[ext]',asset:'[name].[ext]'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js'))!,css=built.outputs.find(f=>f.path.endsWith('.css'))!;let writes=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const url=new URL(req.url),p=url.pathname;
 if(req.method==='POST'&&p==='/api/v1/collaboration/maker/compare_candidates')return fetch(service.url+p,{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json'},body:await req.arrayBuffer()});
 if(req.method!=='GET'){writes++;return new Response('Read-only UI verification',{status:405});}
 if(p==='/')return new Response('<!doctype html><html><head><link rel="stylesheet" href="/review.css"></head><body><div id="root"></div><script type="module" src="/review.js"></script></body></html>',{headers:{'Content-Type':'text/html'}});
 if(p==='/review.js')return new Response(Bun.file(js.path));if(p==='/review.css')return new Response(Bun.file(css.path));
 if(p.startsWith('/api/'))return fetch(service.url+p+url.search,{headers:{Authorization:`Bearer ${service.token}`}});
 if(/^\/fonts\/[a-zA-Z0-9_.-]+$/.test(p))return new Response(Bun.file(join(repo,'apps/web/public',p)));
 return new Response('Missing',{status:404});
}});
const child=Bun.spawn([join(import.meta.dir,'node_modules/electron/dist/electron.exe'),join(import.meta.dir,'whole-review.cjs')],{cwd:repo,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,WHOLE_REVIEW_OUTPUT:out,WHOLE_REVIEW_URL:`http://127.0.0.1:${server.port}/?task=${state.actions[0].task.id}`}});
const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);server.stop(true);
console.log(JSON.stringify({code,stdout,stderr,writes,report:JSON.parse(readFileSync(join(out,'ui.json'),'utf8'))}));process.exit(code||writes?1:0);
