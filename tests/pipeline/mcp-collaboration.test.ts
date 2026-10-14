import {test,expect} from 'bun:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {PRODUCTION_API_VERSION} from '../../packages/shared/src/index';

test('real stdio removes human approval and exposes usable maker creation and versioned limits',async()=>{
 const root=join(import.meta.dir,'../..'),workspace=join(root,'fixtures/generated/human-ai','t10-'+crypto.randomUUID().slice(0,8));mkdirSync(workspace,{recursive:true});
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'task10',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'inspect_capabilities',arguments:{}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'create_project',arguments:{name:'literal task10 project'}}}];
 const child=Bun.spawn([process.execPath,join(root,'apps/cli/src/index.ts'),'mcp','--stdio','--workspace',workspace],{cwd:root,env:{...process.env,SFS_WORKSPACE:workspace},stdin:'pipe',stdout:'pipe',stderr:'pipe',windowsHide:true});child.stdin.write(messages.map(x=>JSON.stringify(x)).join('\n')+'\n');child.stdin.end();
 try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);writeFileSync(join(workspace,'stdio.json'),JSON.stringify({code,out,err},null,2));expect(code,err).toBe(0);const replies=out.trim().split('\n').map(x=>JSON.parse(x)),names=replies.find(x=>x.id===2).result.tools.map((x:any)=>x.name);expect(names).not.toContain('apply_review_patch');expect(names).toContain('create_task');const caps=JSON.parse(replies.find(x=>x.id===3).result.content[0].text);expect(caps.production_api_version).toBe(PRODUCTION_API_VERSION);expect(caps.limits.stdio_line_bytes).toBe(1048576);const project=JSON.parse(replies.find(x=>x.id===4).result.content[0].text);expect(project.name??project.project?.name).toBe('literal task10 project');}
 finally{try{process.kill(JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8')).pid);}catch{}}
},60000);
