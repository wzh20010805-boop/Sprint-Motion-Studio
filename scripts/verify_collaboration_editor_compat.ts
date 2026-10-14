import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {reviewSetup} from '../tests/pipeline/reviewFixture';
import {runCollaborationScript} from '../tests/pipeline/collaborationFixtures';
const root=resolve(import.meta.dir,'..'),bundle=join(process.env.SFS_WORKSPACE!,'compat-bundle');mkdirSync(bundle,{recursive:true});
const build=await Bun.build({entrypoints:[join(root,'probes/desktop/collaboration-editor-fixture.tsx')],target:'browser',outdir:bundle});if(!build.success)throw Error(build.logs.join('\n'));
const fixture=reviewSetup+String.raw`
const {app}=await import('./apps/server/src/app'),queue=await import('./apps/server/src/queue');
const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);playback(candidate.id);await queue.waitForQueueIdle();
const delivery=await import('./apps/server/src/pipeline/collaboration/delivery');
const fixed=await delivery.resolveActionExport({...context,task_id:candidate.task_id},'sequence');assert.equal(fixed.mode,'candidate');
const legacyProject=createProject('Token-free legacy compatibility'),legacyAxis=ensureDefaultTimeline(legacyProject.id).axis,legacyContext={project_id:legacyProject.id,axis_id:legacyAxis.id};
const legacyImport=await importImageSequence(legacyContext,[{name:'legacy.png',bytes}],{request_key:uid(),timing,base_content:d.readDraftContent(legacyContext).token});
for(const id of legacyImport.frame_ids){const state=maskState(id);reviewMask(id,state.version_id,state.revision);}
const alignment=await import('./apps/server/src/pipeline/alignment');alignment.saveAlignment(legacyProject.id,legacyAxis.id,config,getProject(legacyProject.id).revision);await alignment.approveAlignment(legacyProject.id,legacyAxis.id,getProject(legacyProject.id).revision,'synthetic setup only','compatibility fixture');
const identity={context:legacyContext,collaborationContext:context,taskId:candidate.task_id,candidateId:candidate.id,fixed,synthetic_setup_acceptance:true};
writeFileSync(join(STORAGE_ROOT,'identity.json'),JSON.stringify(identity,null,2));
const cookie=auth.issueReviewerSession('synthetic-test-only'),requests=[];let rejectResolver=false;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const url=new URL(req.url);
 if(url.pathname==='/')return new Response('<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',{headers:{'content-type':'text/html'}});
 if(url.pathname==='/fixture.js')return new Response(Bun.file(BUNDLE));
 if(url.pathname==='/styles.css'||url.pathname==='/candy.css')return new Response(Bun.file(join(process.cwd(),'apps/web/src',url.pathname.slice(1))));
 if(url.pathname.startsWith('/fonts/')||url.pathname.startsWith('/art/'))return new Response(Bun.file(join(process.cwd(),'apps/web/public',url.pathname.slice(1))));
 if(url.pathname==='/fixture/identity')return Response.json(identity);
 if(url.pathname==='/fixture/requests')return Response.json(requests);
 if(url.pathname==='/fixture/reject'){rejectResolver=url.searchParams.get('value')==='true';return Response.json({rejectResolver});}
 if(url.pathname.startsWith('/api/')){
  // Faithful historical token-free path: no actor is installed absent a cookie.
  if(req.headers.has('cookie'))try{auth.authenticateLocalRequest(req,url.host);}catch(e){return Response.json({ok:false,error:{message:e.message}},{status:e.status});}
  const item={path:url.pathname,query:url.search,method:req.method,cookie:req.headers.has('cookie'),status:null};requests.push(item);
  const response=rejectResolver&&url.pathname==='/api/v1/export/resolve'?Response.json({ok:false,error:{message:'compatibility resolver rejection'}},{status:409}):await app.handle(req);item.status=response.status;return response;
 }
 return app.handle(req);
}});
let child=null,exit=null,completed=false;try{
 const smoke=[];for(const [path,expected,authenticated] of [
  ['/api/v1/collaboration/action?'+new URLSearchParams(legacyContext),401,false],
  ['/api/v1/export/resolve?'+new URLSearchParams({...legacyContext,format:'sequence'}),200,false],
  ['/api/projects/'+legacyProject.id+'/timeline',200,false],
  ['/api/v1/collaboration/action?'+new URLSearchParams(context),200,true],
  ['/api/v1/export/resolve?'+new URLSearchParams({...context,task_id:candidate.task_id,format:'sequence'}),200,true]]){
  const response=await fetch(new URL(path,server.url),{headers:authenticated?{cookie:'sfs_reviewer='+cookie}:{}}),value=await response.json();assert.equal(response.status,expected,path);if(path.includes('/export/resolve'))assert.equal(value.data.mode,authenticated?'candidate':'legacy');smoke.push({path,status:response.status,value});
 }writeFileSync(join(STORAGE_ROOT,'service-smoke.json'),JSON.stringify(smoke,null,2));
 if(!SERVICE_ONLY){
  child=Bun.spawn([join(process.cwd(),'fixtures/generated/human-ai/desktop-runtime/1b7dd865-7c23-48b7-a305-5ba4603021fc/electron.exe'),join(process.cwd(),'probes/desktop/collaboration-editor-compat-check.cjs')],{windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,SFS_REVIEW_URL:server.url.toString(),SFS_REVIEW_OUTPUT:STORAGE_ROOT,SFS_REVIEW_COOKIE:cookie}});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);exit=code;writeFileSync(join(STORAGE_ROOT,'electron.stdout.log'),out);writeFileSync(join(STORAGE_ROOT,'electron.stderr.log'),err);assert.equal(code,0,err);assert.equal(JSON.parse(readFileSync(join(STORAGE_ROOT,'report.json'),'utf8')).passed,true);
 }completed=true;
}finally{
 if(child&&exit===null){child.kill();exit=await child.exited;}
 const errors=[];let stopped=false,idle=false,closed=false;try{await server.stop(true);stopped=true;}catch(e){errors.push(String(e));}try{await queue.waitForQueueIdle();idle=true;}catch(e){errors.push(String(e));}
 try{writeFileSync(join(STORAGE_ROOT,'api-final-evidence.json'),JSON.stringify({requests,identity,delivery:delivery.readDelivery(fixed.delivery_id),original_source_hash:fileHash(path),synthetic_setup_acceptance:true},null,2));}catch(e){errors.push(String(e));}
 try{db.close();closed=true;}catch(e){errors.push(String(e));}
 writeFileSync(join(STORAGE_ROOT,'fixture-lifecycle.json'),JSON.stringify({electron_pid:child?.pid??null,electron_exit:exit,electron_awaited:!child||exit!==null,listener_stop_awaited:stopped,queue_idle_awaited:idle,db_closed:closed,pending_requests:server.pendingRequests,service_only:SERVICE_ONLY,errors,completed:completed&&!errors.length},null,2));if(errors.length)throw Error(JSON.stringify(errors));
}
`.replace('BUNDLE',JSON.stringify(build.outputs[0]!.path)).replaceAll('SERVICE_ONLY',String(process.argv.includes('--service-only')));
new Bun.Transpiler({loader:'ts'}).transformSync(fixture);
const result=await runCollaborationScript(fixture,'t12');writeFileSync(join(bundle,'fixture-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=result.exit_code;

