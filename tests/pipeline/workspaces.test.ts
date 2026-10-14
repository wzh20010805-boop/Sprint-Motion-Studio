import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWorkspace, workspaceRegistryPath, registerWorkspace, selectWorkspace, listWorkspaces } from '../../apps/cli/src/workspaces';
import { readService } from '../../apps/cli/src/client';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'sfs-workspaces-'));
 const workspace=join(root,'production');mkdirSync(workspace);
 return {root,workspace,options:{repositoryRoot:root,env:{}}};
}

test('统一工作区选择遵循显式参数、环境、登记选择、默认路径顺序',()=>{
 const {root,workspace,options}=fixture();
 expect(resolveWorkspace(options)).toBe(join(root,'workspaces','default'));
 registerWorkspace(options,'production',workspace);
 expect(selectWorkspace(options,{name:'production'})).toBe(realpathSync(workspace));
 expect(resolveWorkspace(options)).toBe(realpathSync(workspace));
 const env={SFS_WORKSPACE:join(root,'environment')};
 expect(resolveWorkspace({...options,env})).toBe(env.SFS_WORKSPACE);
 expect(resolveWorkspace({...options,env,explicit:join(root,'explicit')})).toBe(join(root,'explicit'));
});

test('便携版登记与默认工作区落在用户目录而非安装目录',()=>{
 const {root}=fixture();const options={repositoryRoot:root,distributionRoot:root,env:{LOCALAPPDATA:join(root,'user')}};
 expect(workspaceRegistryPath(options)).toBe(join(root,'user','SpriteMotionStudio','workspaces.json'));
 expect(resolveWorkspace(options)).toBe(join(root,'user','SpriteMotionStudio','workspaces','default'));
});

test('登记拒绝路径别名、名称覆盖和不存在目录，列举不创建工作区',async()=>{
 const {root,workspace,options}=fixture();
 const result=await listWorkspaces(options);
 expect(result.entries).toHaveLength(1);
 expect(existsSync(join(root,'workspaces'))).toBe(false);
 registerWorkspace(options,'production',workspace);
 expect(()=>registerWorkspace(options,'alias',join(workspace,'.'))).toThrow('WORKSPACE_ALREADY_REGISTERED');
 const second=join(root,'second');mkdirSync(second);
 expect(()=>registerWorkspace(options,'production',second)).toThrow('WORKSPACE_NAME_CONFLICT');
 expect(()=>registerWorkspace(options,'missing',join(root,'missing'))).toThrow('WORKSPACE_NOT_FOUND');
 expect(()=>selectWorkspace(options,{name:'missing'})).toThrow('WORKSPACE_NOT_FOUND');
});

test('损坏登记与丢失的已选工作区不会静默切换到另一份数据',()=>{
 const {root,options}=fixture();mkdirSync(join(root,'.sfs'));
 const registry=workspaceRegistryPath(options);
 writeFileSync(registry,'{bad json');
 expect(()=>resolveWorkspace(options)).toThrow('WORKSPACE_REGISTRY_INVALID');
 writeFileSync(registry,JSON.stringify({schema_version:1,current:join(root,'missing'),workspaces:[]}));
 expect(()=>resolveWorkspace(options)).toThrow('WORKSPACE_NOT_FOUND');
 writeFileSync(registry,JSON.stringify({schema_version:1,current:null,workspaces:[{name:'a',path:'relative'}]}));
 expect(()=>resolveWorkspace(options)).toThrow('WORKSPACE_REGISTRY_INVALID');
});

test('工作区列举仅返回验证过的服务身份和地址，不暴露令牌或启动进程',async()=>{
 const {workspace,options}=fixture();registerWorkspace(options,'production',workspace);selectWorkspace(options,{name:'production'});
 mkdirSync(join(workspace,'.sfs'));
 const secret='a'.repeat(64),path=join(workspace,'.sfs/service.json');
 writeFileSync(path,JSON.stringify({pid:2147483647,workspace,url:'http://127.0.0.1:9',instance_id:'dead',token:secret}));
 const stale=await listWorkspaces(options);
 expect(stale.entries.find(entry=>entry.name==='production')?.service.status).toBe('stale');
 expect(JSON.stringify(stale)).not.toContain(secret);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({ok:true,pid:process.pid,instance_id:'live'})});
 try {
  writeFileSync(path,JSON.stringify({pid:process.pid,workspace,url:`http://127.0.0.1:${server.port}`,instance_id:'wrong',token:secret}));
  expect((await listWorkspaces(options)).entries.find(entry=>entry.name==='production')?.service.status).toBe('unreachable');
  writeFileSync(path,JSON.stringify({pid:process.pid,workspace,url:`http://127.0.0.1:${server.port}`,instance_id:'live',token:secret}));
  const live=await listWorkspaces(options);
  expect(live.entries.find(entry=>entry.name==='production')?.service).toEqual({status:'running',pid:process.pid,url:`http://127.0.0.1:${server.port}`});
  expect(JSON.stringify(live)).not.toContain(secret);
  expect(JSON.parse(readFileSync(path,'utf8')).token).toBe(secret);
 } finally {server.stop(true);}
});

test('用目录直接选择只登记选择位置，不创建材料或修改数据库',()=>{
 const {workspace,options}=fixture();writeFileSync(join(workspace,'framebaker.db'),'retained bytes');
 expect(selectWorkspace(options,{directory:workspace})).toBe(realpathSync(workspace));
 expect(resolveWorkspace(options)).toBe(realpathSync(workspace));
 expect(readFileSync(join(workspace,'framebaker.db'),'utf8')).toBe('retained bytes');
});

test('CLI登记、选择和查询无需运行后端，环境覆盖仍然优先',async()=>{
 const {root,workspace}=fixture();mkdirSync(join(root,'apps/server/src'),{recursive:true});writeFileSync(join(root,'apps/server/src/runtimeBootstrap.ts'),'throw new Error("must not start")');
 const cli=resolve(import.meta.dir,'../../apps/cli/src/index.ts');
 async function command(args:string[],override?:string){
  const child=Bun.spawn([process.execPath,cli,...args],{env:{...process.env,SFS_REPO_ROOT:root,SFS_WORKSPACE:override??''},stdout:'pipe',stderr:'pipe'});
  const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(stderr).toBe('');expect(exitCode).toBe(0);return JSON.parse(stdout);
 }
 expect((await command(['workspace','add','--name','production','--directory',workspace])).data.workspace).toBe(realpathSync(workspace));
 expect((await command(['workspace','use','--name','production'])).data.workspace).toBe(realpathSync(workspace));
 expect((await command(['workspace','current'])).data.workspace).toBe(realpathSync(workspace));
 expect((await command(['workspace','current'],join(root,'override'))).data.workspace).toBe(join(root,'override'));
 const listed=await command(['workspace','list']);expect(listed.data.entries.some((entry:any)=>entry.current&&entry.name==='production')).toBe(true);
 expect(existsSync(join(workspace,'.sfs'))).toBe(false);
 expect(existsSync(join(workspace,'framebaker.db'))).toBe(false);
});

test('工作区登记写锁明确拒绝并发修改，不清除未知所有者的记录',()=>{
 const {root,workspace,options}=fixture();mkdirSync(join(root,'.sfs'));
 const lock=workspaceRegistryPath(options)+'.lock';writeFileSync(lock,'unknown owner');
 expect(()=>registerWorkspace(options,'production',workspace)).toThrow('WORKSPACE_REGISTRY_LOCKED');
 expect(()=>selectWorkspace(options,{directory:workspace})).toThrow('WORKSPACE_REGISTRY_LOCKED');
 expect(readFileSync(lock,'utf8')).toBe('unknown owner');
 expect(existsSync(workspaceRegistryPath(options))).toBe(false);
});

test('并发 CLI 登记成功的名称全部保留，竞争失败必须明确返回锁错误',async()=>{
 const {root}=fixture();mkdirSync(join(root,'apps/server/src'),{recursive:true});writeFileSync(join(root,'apps/server/src/runtimeBootstrap.ts'),'throw new Error("must not start")');
 const cli=resolve(import.meta.dir,'../../apps/cli/src/index.ts');
 const results=await Promise.all(Array.from({length:24},async(_,index)=>{
  const directory=join(root,'parallel-'+index);mkdirSync(directory);
  const child=Bun.spawn([process.execPath,cli,'workspace','add','--name','parallel-'+index,'--directory',directory],{env:{...process.env,SFS_REPO_ROOT:root,SFS_WORKSPACE:''},stdout:'pipe',stderr:'pipe'});
  const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(stderr).toBe('');return {name:'parallel-'+index,exitCode,body:JSON.parse(stdout)};
 }));
 const persisted=JSON.parse(readFileSync(workspaceRegistryPath({repositoryRoot:root,env:{}}),'utf8'));
 const succeeded=results.filter(result=>result.exitCode===0);
 expect(succeeded.length).toBeGreaterThan(0);
 expect(persisted.workspaces.map((entry:any)=>entry.name).sort()).toEqual(succeeded.map(result=>result.name).sort());
 for(const failed of results.filter(result=>result.exitCode!==0))expect(failed.body.error.code).toBe('WORKSPACE_REGISTRY_LOCKED');
});

test('默认和当前目录提示不会与已登记名称冲突',async()=>{
 const {workspace,options}=fixture();registerWorkspace(options,'default',workspace);
 const entries=(await listWorkspaces(options)).entries;
 expect(new Set(entries.map(entry=>entry.name)).size).toBe(entries.length);
 expect(entries.find(entry=>entry.name==='default')?.path).toBe(realpathSync(workspace));
 expect(selectWorkspace(options,{name:'default'})).toBe(realpathSync(workspace));
});

test('已存在目录的参数、环境和登记选择统一为真实目录路径',()=>{
 const {root,workspace,options}=fixture();const alias=join(root,'alias');symlinkSync(workspace,alias,process.platform==='win32'?'junction':'dir');
 expect(resolveWorkspace({...options,explicit:alias})).toBe(realpathSync(workspace));
 expect(resolveWorkspace({...options,env:{SFS_WORKSPACE:alias}})).toBe(realpathSync(workspace));
 registerWorkspace(options,'production',alias);selectWorkspace(options,{name:'production'});
 expect(resolveWorkspace(options)).toBe(realpathSync(workspace));
 mkdirSync(join(workspace,'.sfs'));
 const descriptor={pid:process.pid,workspace:alias,url:'http://127.0.0.1:12345',token:'b'.repeat(64),instance_id:'alias-instance'};
 const path=join(workspace,'.sfs/service.json');writeFileSync(path,JSON.stringify(descriptor));
 expect(readService(workspace)?.instance_id).toBe('alias-instance');
 expect(JSON.parse(readFileSync(path,'utf8')).workspace).toBe(alias);
});

test.skipIf(process.platform!=='win32')('Windows 工作区服务发现忽略盘符和目录大小写差异',()=>{
 const {workspace}=fixture();mkdirSync(join(workspace,'.sfs'));
 writeFileSync(join(workspace,'.sfs/service.json'),JSON.stringify({pid:process.pid,workspace:workspace.toLowerCase(),url:'http://127.0.0.1:12345',token:'c'.repeat(64),instance_id:'case-instance'}));
 expect(readService(workspace)?.instance_id).toBe('case-instance');
});
