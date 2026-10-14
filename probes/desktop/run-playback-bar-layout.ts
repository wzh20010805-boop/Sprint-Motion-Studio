import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync} from 'node:fs';
const repo=resolve(import.meta.dir,'../..'),out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const built=await Bun.build({entrypoints:[join(repo,'apps/web/src/playbackBarLayout.fixture.tsx')],target:'browser',outdir:join(out,'bundle'),naming:{entry:'layout.[ext]',asset:'[name].[ext]'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js'))!,css=built.outputs.find(f=>f.path.endsWith('.css'))!;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const p=new URL(req.url).pathname;if(p==='/')return new Response('<!doctype html><html><head><link rel="stylesheet" href="/layout.css"></head><body><div id="root"></div><script src="/layout.js"></script></body></html>',{headers:{'Content-Type':'text/html'}});if(p==='/layout.js')return new Response(Bun.file(js.path));if(p==='/layout.css')return new Response(Bun.file(css.path));if(/^\/fonts\/[a-zA-Z0-9_.-]+$/.test(p))return new Response(Bun.file(join(repo,'apps/web/public',p)));return new Response('Missing',{status:404});}});
const child=Bun.spawn([join(import.meta.dir,'node_modules/electron/dist/electron.exe'),join(import.meta.dir,'playback-bar-layout.cjs')],{cwd:repo,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,PLAYBACK_LAYOUT_OUTPUT:out,PLAYBACK_LAYOUT_URL:`http://127.0.0.1:${server.port}/`}});
const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);server.stop(true);console.log(JSON.stringify({code,stdout,stderr,report:JSON.parse(readFileSync(join(out,'layout.json'),'utf8'))}));process.exit(code);
