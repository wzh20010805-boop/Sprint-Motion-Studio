import { test, expect } from 'bun:test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureService } from '../../apps/cli/src/client';

test('published service is ready for independent desktop bootstrap and maker cannot acquire it by HTTP', async () => {
 const workspace=join(import.meta.dir,'../../fixtures/generated/human-ai',`task-02-ready-${crypto.randomUUID()}`);mkdirSync(workspace,{recursive:true});
 const info=await ensureService(workspace);
 try {
  expect(existsSync(join(workspace,'.sfs/desktop-bootstrap.json'))).toBe(true);
  const descriptor=JSON.parse(readFileSync(join(workspace,'.sfs/desktop-bootstrap.json'),'utf8'));
  expect(descriptor.instance_id).toBe(info.instance_id);
  expect(JSON.stringify(info)).not.toContain(descriptor.bootstrap_secret);
  const response=await fetch(info.url+'/api/desktop/bootstrap',{method:'POST',headers:{Authorization:`Bearer ${info.token}`,'Content-Type':'application/json'},body:JSON.stringify({actor:'human'})});
  expect(response.status).toBe(404);
 } finally {process.kill(info.pid);}
},40000);

test('server authenticated role boundary has an independent reviewer session implementation',async()=>{
 const sessions:any=await import('../../apps/server/src/localSessions').catch(()=>({}));
 expect(typeof sessions.authenticateLocalRequest).toBe('function');
 expect(typeof sessions.requireRole).toBe('function');
});

test('real HTTP and pipe enforce reviewer authority, framing, PID, replay, expiry and restart',async()=>{
 const s:any=await import('../../apps/server/src/localSessions').catch(()=>({}));
 const b:any=await import('../../apps/server/src/desktopReviewBroker').catch(()=>({}));
 expect(typeof b.startDesktopReviewBroker).toBe('function');
 const {connect}=await import('node:net');
 const {setSystemTime}=await import('bun:test');
 const instance=crypto.randomUUID(),token='b'.repeat(64);
 s.initializeLocalSessions(instance,token);
 const broker=await b.startDesktopReviewBroker(instance);
 const descriptor=JSON.parse(readFileSync(join(process.env.SFS_WORKSPACE!,'.sfs/desktop-bootstrap.json'),'utf8'));
 const rpc=(message:any,fragment=false)=>new Promise<any>((resolve,reject)=>{const socket=connect(broker.pipe_name);let data='';socket.setTimeout(4500,()=>{socket.destroy();reject(Error('timeout'));});socket.on('error',reject);socket.on('data',chunk=>{data+=chunk;if(data.includes('\n')){socket.destroy();resolve(JSON.parse(data));}});socket.on('connect',()=>{const text=typeof message==='string'?message:JSON.stringify({instance_id:instance,...message})+'\n';if(fragment){socket.write(text.slice(0,7));setTimeout(()=>socket.write(text.slice(7)),10);}else socket.write(text);});});
 const issue=()=>rpc({method:'issue',bootstrap_secret:descriptor.bootstrap_secret,desktop_pid:process.pid},true);
 const consume=(nonce:string,pid=process.pid)=>rpc({method:'consume',nonce,desktop_pid:pid});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,server){try{s.authenticateLocalRequest(req,`127.0.0.1:${server.port}`);const actor=s.getRequestActor(req);s.requireRole(actor,new URL(req.url).pathname==='/review'?'reviewer':'maker');return Response.json(actor);}catch(error:any){return Response.json({code:error.code},{status:error.status??500});}}});
 const call=(cookie='',headers:any={},body:any={})=>fetch(`http://127.0.0.1:${server.port}/review`,{method:'POST',headers:{cookie,...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  expect((await call('',{Authorization:`Bearer ${token}`})).status).toBe(403);
  expect((await call(`sfs_token=${token}`,{}, {actor:'human',role:'reviewer'})).status).toBe(403);
  expect((await rpc({method:'issue',bootstrap_secret:token,desktop_pid:process.pid})).code).toBe('BOOTSTRAP_UNAUTHORIZED');
  expect((await rpc({method:'issue',instance_id:'old',bootstrap_secret:descriptor.bootstrap_secret,desktop_pid:process.pid})).code).toBe('BOOTSTRAP_INSTANCE_MISMATCH');
  expect((await rpc({method:'issue',bootstrap_secret:descriptor.bootstrap_secret,desktop_pid:-1})).code).toBe('BOOTSTRAP_INVALID_REQUEST');
  expect((await rpc('{invalid}\n')).code).toBe('BOOTSTRAP_INVALID_REQUEST');
  expect((await rpc({method:'unknown',desktop_pid:process.pid})).code).toBe('BOOTSTRAP_INVALID_REQUEST');
  expect((await rpc('{}\n{}\n')).code).toBe('BOOTSTRAP_INVALID_REQUEST');
  expect((await rpc('partial')).code).toBe('BOOTSTRAP_TIMEOUT');
  expect((await rpc('x'.repeat(9000))).code).toBe('BOOTSTRAP_FRAME_TOO_LARGE');
  const first=await issue();expect(typeof first.nonce).toBe('string');
  expect((await consume(first.nonce,process.pid+1)).code).toBe('BOOTSTRAP_PID_MISMATCH');
  const results=await Promise.all([consume(first.nonce),consume(first.nonce)]);
  expect(results.filter(r=>r.reviewer_cookie).length).toBe(1);expect(results.filter(r=>r.code==='BOOTSTRAP_REPLAY').length).toBe(1);
  const secret=results.find(r=>r.reviewer_cookie).reviewer_cookie,cookie=`sfs_reviewer=${secret}`;
  expect((await call(cookie)).status).toBe(200);
  expect((await call(cookie,{Authorization:`Bearer ${token}`})).status).toBe(200);
  expect((await call('sfs_reviewer=stale',{Authorization:`Bearer ${token}`})).status).toBe(403);
  expect((await call(cookie,{origin:'https://evil.example'})).status).toBe(403);
  expect((await call(cookie,{host:'evil.example'})).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${server.port}/edit`,{headers:{cookie}})).status).toBe(200);
  expect(JSON.stringify(descriptor)).not.toContain(secret);
  const expires=await issue();setSystemTime(new Date(Date.now()+31000));expect((await consume(expires.nonce)).code).toBe('BOOTSTRAP_EXPIRED');setSystemTime();
  s.initializeLocalSessions(crypto.randomUUID(),token);expect((await call(cookie)).status).toBe(401);
 } finally{setSystemTime();server.stop(true);broker.close();}
},15000);

test('desktop helper verifies live identity before consuming bootstrap and supports production transport',async()=>{
 const h:any=await import('../../apps/desktop/review-bootstrap.cjs').catch(()=>({}));
 expect(typeof h.obtainDesktopReviewSession).toBe('function');
 const workspace=join(import.meta.dir,'../../fixtures/generated/human-ai',`task-02-helper-${crypto.randomUUID()}`);mkdirSync(workspace,{recursive:true});
 const info=await ensureService(workspace);
 try{
  await expect(h.obtainDesktopReviewSession(workspace,{...info,instance_id:'wrong'})).rejects.toThrow('DESKTOP_SERVICE_IDENTITY');
  const result=await h.obtainDesktopReviewSession(workspace,info);
  expect(result.instance_id).toBe(info.instance_id);
  const cookie=`sfs_reviewer=${result.reviewer_cookie}`;
  const response=await fetch(info.url+'/api/v1/projects',{headers:{cookie}});expect(response.status).toBe(200);
  expect((await fetch(info.url+'/api/v1/projects',{headers:{cookie,origin:'http://bad.example'}})).status).toBe(403);
  expect(readFileSync(join(workspace,'.sfs/service.json'),'utf8')).not.toContain(result.reviewer_cookie);
  expect(readFileSync(join(workspace,'.sfs/service.log'),'utf8')).not.toContain(result.reviewer_cookie);
  const bootstrap=JSON.parse(readFileSync(join(workspace,'.sfs/desktop-bootstrap.json'),'utf8'));
  expect(readFileSync(join(workspace,'.sfs/service.json'),'utf8')+readFileSync(join(workspace,'.sfs/service.log'),'utf8')).not.toContain(bootstrap.bootstrap_secret);
  expect(h.desktopPartition(workspace)).toBe(h.desktopPartition(workspace));
  expect(h.desktopPartition(workspace)).not.toBe(h.desktopPartition(workspace+'-other'));
 }finally{process.kill(info.pid);}
},40000);

test('production fetch binds adapter actors and rejects invalid WebSocket Host/Origin after authentication',async()=>{
 const repo=join(import.meta.dir,'../..'),workspace=join(repo,'fixtures/generated/human-ai',`task-02-http-${crypto.randomUUID()}`);mkdirSync(workspace,{recursive:true});
 const child=Bun.spawn([process.execPath,join(repo,'tests/fixtures/runtime-capability-service.ts')],{cwd:repo,env:{...process.env,SFS_WORKSPACE:workspace},windowsHide:true,stdout:'pipe',stderr:'pipe'});
 const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();let info:any;
 try{
  for(let i=0;i<150;i++){try{info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));const ready=await fetch(info.url+'/__fixture/review',{method:'POST',headers:{Authorization:`Bearer ${info.token}`}});if(ready.status===403)break;}catch{}await Bun.sleep(100);}
  expect(info?.pid).toBe(child.pid);
  const {obtainDesktopReviewSession}=await import('../../apps/desktop/review-bootstrap.cjs');const session=await obtainDesktopReviewSession(workspace,info);
  const review=(headers:any)=>fetch(info.url+'/__fixture/review',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({actor:'human',role:'reviewer'})});
  expect((await review({Authorization:`Bearer ${info.token}`})).status).toBe(403);
  expect((await review({Cookie:`sfs_token=${info.token}`})).status).toBe(403);
  const cookie=`sfs_reviewer=${session.reviewer_cookie}`;expect((await review({Cookie:cookie})).status).toBe(200);
  expect((await fetch(info.url+'/api/v1/projects',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'reviewer-can-make'})})).status).toBe(200);
  expect((await fetch(info.url+'/ws',{headers:{Cookie:cookie,Origin:'https://evil.example',Upgrade:'websocket'}})).status).toBe(403);
  expect((await fetch(info.url+'/ws',{headers:{Cookie:cookie,Host:'evil.example',Upgrade:'websocket'}})).status).toBe(403);
  expect((await fetch(info.url+'/ws',{headers:{Upgrade:'websocket'}})).status).toBe(401);
  const opened=await new Promise<boolean>(resolve=>{const socket=new WebSocket(info.url.replace('http:','ws:')+'/ws',{headers:{Cookie:cookie}});const timeout=setTimeout(()=>{socket.close();resolve(false)},2000);socket.onopen=()=>{clearTimeout(timeout);socket.close();resolve(true)};socket.onerror=()=>{clearTimeout(timeout);resolve(false)};});expect(opened).toBe(true);
 }finally{child.kill();const {writeFileSync}=await import('node:fs');writeFileSync(join(workspace,'http-fixture.log'),await output+await errors);}
},30000);

test('service restart invalidates reviewer cookies and bootstrap descriptors without touching maker outputs',async()=>{
 const workspace=join(import.meta.dir,'../../fixtures/generated/human-ai',`task-02-restart-${crypto.randomUUID()}`);mkdirSync(workspace,{recursive:true});
 const {obtainDesktopReviewSession}=await import('../../apps/desktop/review-bootstrap.cjs');
 let info=await ensureService(workspace);
 try{
  const oldInfo=info,old=await obtainDesktopReviewSession(workspace,info);
  process.kill(info.pid);for(let i=0;i<100;i++){try{process.kill(info.pid,0);}catch{break;}await Bun.sleep(20);}
  info=await ensureService(workspace);expect(info.instance_id).not.toBe(oldInfo.instance_id);
  expect((await fetch(info.url+'/api/v1/projects',{headers:{Cookie:`sfs_reviewer=${old.reviewer_cookie}`}})).status).toBe(401);
  await expect(obtainDesktopReviewSession(workspace,oldInfo)).rejects.toThrow('DESKTOP_SERVICE_IDENTITY');
  const fresh=await obtainDesktopReviewSession(workspace,info);
  expect((await fetch(info.url+'/api/v1/projects',{headers:{Cookie:`sfs_reviewer=${fresh.reviewer_cookie}`}})).status).toBe(200);
 }finally{process.kill(info.pid);}
},40000);
