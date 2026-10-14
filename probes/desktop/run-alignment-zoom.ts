import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync} from 'node:fs';
const repo=resolve(import.meta.dir,'../..'),out=resolve(process.argv[2]!);mkdirSync(out,{recursive:true});
const assets=resolve(repo,'../production/character-20261014/v2/output-unified/06-point-left');
const manifest=JSON.parse(readFileSync(join(assets,'manifest.json'),'utf8'));
const built=await Bun.build({entrypoints:[join(repo,'apps/web/src/alignmentZoom.fixture.tsx')],target:'browser',outdir:join(out,'bundle'),naming:{entry:'layout.[ext]',asset:'[name].[ext]'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js'))!,css=built.outputs.find(f=>f.path.endsWith('.css'))!;
let writes=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const p=new URL(req.url).pathname;
 if(req.method!=='GET'){writes++;return new Response('Fixture forbids writes',{status:405});}
 if(p==='/')return new Response('<!doctype html><html><head><link rel="stylesheet" href="/layout.css"></head><body><div id="root"></div><script src="/layout.js"></script></body></html>',{headers:{'Content-Type':'text/html'}});
 if(p==='/layout.js')return new Response(Bun.file(js.path));
 if(p==='/layout.css')return new Response(Bun.file(css.path));
 if(p==='/api/v1/alignment')return Response.json({ok:true,data:{config:manifest.alignment,revision:1}});
 if(p.startsWith('/api/v1/preview/')||p.startsWith('/api/v1/masks/')){await Bun.sleep(150);const index=(Number(p.match(/preview-fixture-(\d+)/)?.[1]??0)%3)*40;return new Response(Bun.file(join(assets,manifest.frames[index].file)),{headers:{'Cache-Control':'no-store'}});}
 if(/^\/fonts\/[a-zA-Z0-9_.-]+$/.test(p))return new Response(Bun.file(join(repo,'apps/web/public',p)));
 return new Response('Missing',{status:404});
}});
const child=Bun.spawn([join(import.meta.dir,'node_modules/electron/dist/electron.exe'),join(import.meta.dir,'alignment-zoom.cjs')],{cwd:repo,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,ALIGNMENT_ZOOM_OUTPUT:out,ALIGNMENT_ZOOM_URL:`http://127.0.0.1:${server.port}/`}});
const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);server.stop(true);
const report=JSON.parse(readFileSync(join(out,'layout.json'),'utf8'));console.log(JSON.stringify({code,stdout,stderr,writes,report}));process.exit(code||writes?1:0);
