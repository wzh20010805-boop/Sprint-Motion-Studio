import { test,expect } from 'bun:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

const desktopTest=process.env.SFS_DESKTOP_CAPABILITY_TEST==='1'?test:test.skip;
desktopTest('two actual desktop hosts use private sessions and HttpOnly reviewer cookies in sandboxed hidden windows',async()=>{
 const repo=resolve(import.meta.dir,'../..'),workspace=join(repo,'fixtures/generated/human-ai',`task-02-desktop-${crypto.randomUUID()}`);mkdirSync(workspace,{recursive:true});
 const evidence=join(repo,'fixtures/generated/human-ai/sdd-2026-10-13-human-ai-animation-workflow');
 const runtime=join(repo,'probes/desktop/node_modules/electron/dist');
 const backend=Bun.spawn([process.execPath,join(repo,'tests/fixtures/runtime-capability-service.ts')],{cwd:repo,env:{...process.env,SFS_WORKSPACE:workspace},windowsHide:true,stdout:'pipe',stderr:'pipe'});
 const stdout=new Response(backend.stdout).text(),stderr=new Response(backend.stderr).text();let info:any;
 try{
  for(let i=0;i<150;i++){try{info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));const ready=await fetch(info.url+'/__fixture/review',{method:'POST',headers:{Authorization:`Bearer ${info.token}`}});if(ready.status===403)break;}catch{}await Bun.sleep(100);}
  expect(info?.pid).toBe(backend.pid);
  const descriptor=JSON.parse(readFileSync(join(workspace,'.sfs/desktop-bootstrap.json'),'utf8'));
  const aclScript="$p=$env:SFS_DESCRIPTOR_PATH;$a=[System.IO.File]::GetAccessControl($p);$sddl=$a.GetSecurityDescriptorSddlForm('All');[Console]::WriteLine($sddl)";
  const acl=Bun.spawn(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(aclScript,'utf16le').toString('base64')],{env:{...process.env,SFS_DESCRIPTOR_PATH:join(workspace,'.sfs/desktop-bootstrap.json')},windowsHide:true,stdout:'pipe',stderr:'pipe'});
  const dacl=await new Response(acl.stdout).text();expect(await acl.exited).toBe(0);expect(dacl).toContain('D:P');expect(dacl).not.toContain(';;;BU)');expect(dacl).not.toContain(';;;AU)');writeFileSync(join(workspace,'descriptor-dacl.txt'),dacl);
  const electron=spawn(join(runtime,'electron.exe'),[join(repo,'tests/fixtures/desktop-capability-host.cjs'),'--smoke'],{cwd:repo,windowsHide:true,env:{...process.env,SFS_WORKSPACE:workspace,SFS_REPO_ROOT:repo,SFS_FIXTURE_BUN:process.execPath,SFS_SERVICE_URL:info.url,SFS_SERVICE_TOKEN:info.token},stdio:['ignore','pipe','pipe']});
  let out='',err='';electron.stdout!.on('data',chunk=>out+=chunk);electron.stderr!.on('data',chunk=>err+=chunk);
  const code=await new Promise<number|null>((resolve,reject)=>{electron.on('error',reject);electron.on('close',resolve);});
  writeFileSync(join(workspace,'electron.stdout.log'),out);writeFileSync(join(workspace,'electron.stderr.log'),err);writeFileSync(join(evidence,workspace.split(/[\\/]/).pop()+'.result.json'),JSON.stringify({workspace,code,runtime},null,2));
  expect(err).not.toContain('FATAL');expect(code).toBe(0);
  const result=JSON.parse(readFileSync(join(workspace,'desktop-evidence/capabilities.json'),'utf8'));expect(result.hosts.length).toBe(2);
  for(const host of result.hosts){expect(host.visible).toBe(false);expect(host.usesDefaultSession).toBe(false);expect(host.preferences).toEqual({sandbox:true,contextIsolation:true,nodeIntegration:false});expect(host.result).toMatchObject({read:200,edit:200,review:200,ws:true,cookieVisible:'',require:'undefined',process:'undefined'});expect(host.cookies.find((v:any)=>v.name==='sfs_reviewer')).toMatchObject({httpOnly:true,sameSite:'strict',path:'/',hostOnly:true});}
  expect(out+err+JSON.stringify(result)).not.toContain(descriptor.bootstrap_secret);
 }finally{backend.kill();const [out,err]=await Promise.all([stdout,stderr]);writeFileSync(join(workspace,'backend.stdout.log'),out);writeFileSync(join(workspace,'backend.stderr.log'),err);}
},65000);
