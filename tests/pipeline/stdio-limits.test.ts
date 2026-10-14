import {test,expect} from 'bun:test';
import {bridgeStdio} from '../../apps/cli/src/mcpBridge';
import {join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {boundedByteLines} from '../../apps/cli/src/byteLines';
test('byte boundaries exclude CRLF, preserve UTF8 split chunks and discard exactly one oversized line',async()=>{
 async function collect(chunks:Uint8Array[],limit=1048576){const out=[];for await(const line of boundedByteLines((async function*(){yield* chunks;})(),limit))out.push(line);return out;}
 const exact=Buffer.alloc(1048576,97);const lines=await collect([exact,Buffer.from('\r'),Buffer.from('\nnext\n')]);expect(lines.map(x=>x?.length)).toEqual([1048576,4]);
 expect(await collect([exact,Buffer.from('xno-newline'),Buffer.from('\nvalid\r\n')])).toEqual([null,'valid']);
 expect(await collect([...Buffer.from('中🙂\r\n第二\nlast')].map(b=>Buffer.from([b])))).toEqual(['中🙂','第二','last']);
 expect(await collect([Buffer.from('ab\rc\n\n')],3)).toEqual([null,'']);
 expect(await collect([Buffer.from('abc\r')],3)).toEqual([null]);
 expect(await collect([Buffer.from('a\nb\nc\n')],1)).toEqual(['a','b','c']);
});
test('raw stdio rejects oversized UTF8 then retains valid line and emits parse error id null',async()=>{
 const root=join(import.meta.dir,'../..'),workspace=join(root,'fixtures/generated/human-ai','t10-'+crypto.randomUUID().slice(0,8));mkdirSync(workspace,{recursive:true});
 const received:any[]=[];const server=Bun.serve({port:0,async fetch(req){if(new URL(req.url).pathname==='/api/health')return Response.json({});const p=await req.json() as any;received.push(p);return Response.json({jsonrpc:'2.0',id:p.id,result:{ok:true}});}});
 const script=`import {bridgeStdio} from './apps/cli/src/mcpBridge';await bridgeStdio(${JSON.stringify({url:server.url.origin,token:'fixture'})});`;
 writeFileSync(join(workspace,'bridge-script.ts'),script);
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:root,env:{...process.env,SFS_WORKSPACE:workspace},stdin:'pipe',stdout:'pipe',stderr:'pipe',windowsHide:true});
 const unsafe=JSON.stringify({id:99,pad:'中'.repeat(350000)});child.stdin.write(unsafe+'\r\n'+JSON.stringify({id:1})+'\n{invalid\n');child.stdin.end();
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);writeFileSync(join(workspace,'limits.json'),JSON.stringify({code,out,err,received},null,2));const replies=out.trim().split('\n').map(x=>JSON.parse(x));expect(received.map(x=>x.id)).toEqual([1]);expect(replies.filter(x=>x.error).map(x=>x.id)).toEqual([null,null]);expect(replies.find(x=>x.id===1).result.ok).toBe(true);}finally{server.stop(true);}
},20000);
