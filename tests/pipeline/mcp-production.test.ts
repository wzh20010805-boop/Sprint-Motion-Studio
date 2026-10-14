import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {readFileSync,mkdirSync} from 'node:fs';

test('real CLI stdio MCP exposes narrow maker tools and queries shared service',async()=>{
 const root=join(import.meta.dir,'../..'),workspace=join(root,'fixtures/generated/mcp-production',crypto.randomUUID());mkdirSync(workspace,{recursive:true});
 const proc=Bun.spawn([process.execPath,join(root,'apps/cli/src/index.ts'),'mcp','--stdio','--workspace',workspace],{cwd:root,env:{...process.env,SFS_IDLE_TIMEOUT_MS:'1000'},stdin:'pipe',stdout:'pipe',stderr:'pipe',windowsHide:true});
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'sfs-test',version:'1.0'}}},{jsonrpc:'2.0',method:'notifications/initialized'}, {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'inspect_capabilities',arguments:{}}}];
 proc.stdin.write(messages.slice(0,3).map(v=>JSON.stringify(v)).join('\n')+'\n');
 // 保持stdio开启并跨过服务空闲退出时间，再发送真正的业务调用。
 await Bun.sleep(3500);
 proc.stdin.write(JSON.stringify(messages[3])+'\n');proc.stdin.end();
 try{const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);const replies=out.trim().split('\n').map(v=>JSON.parse(v));expect(code,err+out).toBe(0);expect(replies.find(v=>v.id===1)?.result?.serverInfo?.name).toBe('soldier-frame-studio');const tools=replies.find(v=>v.id===2)?.result?.tools;expect(tools.map((v:any)=>v.name)).toContain('create_task');expect(tools.map((v:any)=>v.name)).not.toContain('apply_review_patch');expect(tools.map((v:any)=>v.name)).not.toContain('delete_project');expect(JSON.parse(replies.find(v=>v.id===3).result.content[0].text).pipeline_requires_review).toBeTrue();}
 finally{try{const info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));process.kill(info.pid);}catch{}}
},60000);
