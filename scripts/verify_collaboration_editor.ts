import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {reviewSetup} from '../tests/pipeline/reviewFixture';
import {runCollaborationScript} from '../tests/pipeline/collaborationFixtures';
const root=resolve(import.meta.dir,'..'),bundle=join(process.env.SFS_WORKSPACE!,'editor-bundle');mkdirSync(bundle,{recursive:true});
const build=await Bun.build({entrypoints:[join(root,'probes/desktop/collaboration-editor-fixture.tsx')],target:'browser',outdir:bundle});
if(!build.success)throw Error(build.logs.join('\n'));
if(process.argv.includes('--build-only')){console.log('Editor fixture bundle built');process.exit(0);}
const seed=reviewSetup+String.raw`
 timing.value={mode:"explicit_durations",durations:[{num:1,den:10},{num:1,den:7},{num:2,den:9},{num:11,den:60}]};
 const {request}=await seedCandidate(4);const draft=d.readDraftContent(context);db.query('UPDATE frames SET offset_x=3 WHERE id=?').run(draft.frames[0].frame_id);
 const candidate=await c.buildPrivateCandidate(request());await submit(candidate);
 writeFileSync(join(STORAGE_ROOT,'identity.json'),JSON.stringify({context,taskId:candidate.task_id,candidateId:candidate.id,manifest:c.readCandidateManifest(candidate.id)}));
 await (await import('./apps/server/src/queue')).waitForQueueIdle();db.close();
`;
const fixture=(String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const repo=process.cwd(),workspace=process.env.SFS_WORKSPACE,runtime=join(repo,'fixtures/generated/human-ai/desktop-runtime/1b7dd865-7c23-48b7-a305-5ba4603021fc');
const makerRuns=[];
async function maker(script,name){writeFileSync(join(workspace,name+'.ts'),script);const child=Bun.spawn([process.execPath,'-e',script],{cwd:repo,env:process.env,windowsHide:true,stdout:'pipe',stderr:'pipe'});const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);const record={name,pid:child.pid,exit,awaited:true,exited_at:Date.now()};makerRuns.push(record);writeFileSync(join(workspace,name+'.output.json'),JSON.stringify({record,out,err}));assert.equal(exit,0,err);return record;}
await maker(SEED,'maker-seed');
const {db,STORAGE_ROOT,uid}=await import('./apps/server/src/db'),c=await import('./apps/server/src/pipeline/collaboration/candidates'),r=await import('./apps/server/src/pipeline/collaboration/reviews'),ops=await import('./apps/server/src/pipeline/collaboration/operations'),delivery=await import('./apps/server/src/pipeline/collaboration/delivery'),{fileHash}=await import('./apps/server/src/pipeline/alignment');
const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('synthetic-editor-only','test-maker');const credential=auth.issueReviewerSession('synthetic-editor-only');
const {app}=await import('./apps/server/src/app'),queue=await import('./apps/server/src/queue');
const identity=JSON.parse(readFileSync(join(workspace,'identity.json'),'utf8')),requests=[],frozen=[identity.manifest];
const original=Object.fromEntries(identity.manifest.frames.map(f=>[f.frame_id,{sha256:fileHash(c.candidateFilePath(identity.candidateId,f.files.png)),duration:f.duration,grid_cell:f.grid_cell}]));
let newCandidate=null;
const childScript=String.raw`+
"`"+String.raw`
import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const {db,STORAGE_ROOT,uid}=await import('./apps/server/src/db');const identity=JSON.parse(readFileSync(join(STORAGE_ROOT,'identity.json'),'utf8'));
const d=await import('./apps/server/src/pipeline/collaboration/drafts'),c=await import('./apps/server/src/pipeline/collaboration/candidates'),s=await import('./apps/server/src/pipeline/collaboration/samplingStore'),r=await import('./apps/server/src/pipeline/collaboration/reviews'),{checkCandidate}=await import('./apps/server/src/pipeline/collaboration/checks');
const actor={session_id:'isolated-maker-process',role:'maker'};
const candidate=await c.buildPrivateCandidate({...identity.context,task_id:identity.taskId,parent_candidate_id:identity.candidateId,base_content:d.readDraftContent(identity.context).token,request_key:uid()});await checkCandidate(candidate.id);
const plan=s.getCandidateSamplingPlan(candidate.id,actor);s.recordSampleObservations(candidate.id,plan.plan_hash,plan.samples.map(sample=>({candidate_id:candidate.id,content_hash:plan.content_hash,plan_hash:plan.plan_hash,frame_id:sample.frame_id,frame_content_hash:sample.frame_content_hash,viewed:false,result:'uncertain',explanation:'Synthetic fixture; not AI visual acceptance',evidence_source:'test-only'})),actor);c.submitCandidate(candidate.id,candidate.content_hash,actor);
const issues=r.readReviewState(identity.candidateId).issues;for(const issue of issues)r.recordIssueRepair({task_id:identity.taskId,candidate_id:identity.candidateId,base_review_revision:c.readCandidate(identity.candidateId).review_revision,request_key:uid()},{issue_id:issue.id,repair_candidate_id:candidate.id,frame_ids:issue.frame_ids,note:'Synthetic repair: actual manual center operation'},actor);
writeFileSync(join(STORAGE_ROOT,'child-identity.json'),JSON.stringify({candidateId:candidate.id,manifest:c.readCandidateManifest(candidate.id)}));await (await import('./apps/server/src/queue')).waitForQueueIdle();db.close();
`+"`"+String.raw`;
function evidence(){const current=newCandidate?.candidateId??identity.candidateId;return {makerRuns,requests,state:r.readReviewState(current),parent:r.readReviewState(identity.candidateId),operations:db.query("SELECT id,request_key,state,attempt_job_ids_json,result_json,payload_hash,payload_json FROM collab_operations WHERE kind='deliver_candidate'").all(),draft:db.query('SELECT f.id,f.offset_x,f.offset_y FROM frames f JOIN animation_tracks t ON t.id=f.track_id WHERE t.axis_id=? ORDER BY f.idx').all(identity.context.axis_id)};}
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const url=new URL(req.url);
 if(url.pathname==='/')return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',{headers:{'Content-Type':'text/html'}});
 if(url.pathname==='/fixture.js')return new Response(Bun.file(BUNDLE));
 if(url.pathname==='/styles.css'||url.pathname==='/candy.css')return new Response(Bun.file(join(repo,'apps/web/src',url.pathname.slice(1))));
 if(url.pathname.startsWith('/fonts/')||url.pathname.startsWith('/art/'))return new Response(Bun.file(join(repo,'apps/web/public',url.pathname.slice(1))));
 if(url.pathname==='/fixture/identity')return Response.json(identity);
 if(url.pathname==='/fixture/evidence')return Response.json(evidence());
 if(url.pathname==='/fixture/new-candidate'&&req.method==='POST'){assert.equal(newCandidate,null);await maker(childScript,'maker-repair');newCandidate=JSON.parse(readFileSync(join(workspace,'child-identity.json'),'utf8'));frozen.push(newCandidate.manifest);return Response.json(newCandidate);}
 if(url.pathname.startsWith('/api/')){try{auth.authenticateLocalRequest(req,url.host);}catch(e){return Response.json({ok:false,error:{code:e.code,message:e.message}},{status:e.status});}const item={path:url.pathname,method:req.method,body:['POST','PATCH'].includes(req.method)?await req.clone().json().catch(()=>null):null,at:Date.now(),status:null};requests.push(item);const response=await app.handle(req);item.status=response.status;return response;}
 return app.handle(req);
}});
let child=null,exit=null,bodyCompleted=false;
try{
 const smoke=[];for(const path of ['/fixture/evidence','/api/v1/collaboration/action?project_id='+identity.context.project_id+'&axis_id='+identity.context.axis_id,'/api/v1/collaboration/tasks/'+identity.taskId,'/api/projects/'+identity.context.project_id+'/timeline','/api/v1/collaboration/candidates/'+identity.candidateId+'/review-state']){const response=await fetch(new URL(path,server.url),{headers:{cookie:'sfs_reviewer='+credential}});assert.equal(response.status,200,path);const value=await response.json();assert.equal(typeof value,'object');assert.notEqual(value,null);if(path.includes('/collaboration/'))assert.equal(value.ok,true,path);if(path==='/fixture/evidence'){assert.equal(value.makerRuns[0].exit,0);assert.equal(value.state.frame_reviews.length,4);assert.equal(value.draft.length,4);}if(path.includes('/action?'))assert.equal(value.data.tasks[0].id,identity.taskId);smoke.push({path,status:response.status,value});}writeFileSync(join(workspace,'service-smoke.json'),JSON.stringify(smoke,null,2));
 if(!SERVICE_ONLY){
 child=Bun.spawn([join(runtime,'electron.exe'),join(repo,'probes/desktop/collaboration-editor-check.cjs')],{cwd:repo,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,SFS_REVIEW_URL:server.url.toString(),SFS_REVIEW_OUTPUT:workspace,SFS_REVIEW_COOKIE:credential}});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);exit=code;writeFileSync(join(workspace,'electron.stdout.log'),out);writeFileSync(join(workspace,'electron.stderr.log'),err);assert.equal(code,0,err);
 const report=JSON.parse(readFileSync(join(workspace,'report.json'),'utf8'));assert.equal(report.passed,true,JSON.stringify(report.failures));
 const current=evidence();assert.equal(current.operations.length,2);const fileEvidence=[];
 for(const op of current.operations){assert.equal(op.state,'succeeded');assert.equal(JSON.parse(op.attempt_job_ids_json).length,1);const result=delivery.readDelivery(op.id),m=c.readCandidateManifest(result.candidate_id),saved=JSON.parse(readFileSync(join(result.directory,'candidate-manifest.json'),'utf8'));assert.deepEqual(saved,m);for(const f of m.frames){assert.equal(fileHash(c.candidateFilePath(m.candidate_id,f.files.png)),f.png_sha256);assert.equal(fileHash(join(result.directory,f.files.png)),f.png_sha256);}for(const sheet of m.sheets)assert.equal(fileHash(join(result.directory,sheet.file)),sheet.sha256);fileEvidence.push({operation:ops.readOperation(op.id),request:delivery.readDeliveryRequest(op.id),delivery:result,manifest:saved});}
 for(const f of identity.manifest.frames)assert.equal(fileHash(c.candidateFilePath(identity.candidateId,f.files.png)),original[f.frame_id].sha256);
 assert.equal(fileEvidence.filter(x=>x.delivery.approval_status==='withdrawn').length,1);assert.equal(fileEvidence.filter(x=>x.delivery.approval_status==='approved').length,1);
 writeFileSync(join(workspace,'all-file-evidence.json'),JSON.stringify({original,fileEvidence,all_fixed_bytes_equal:true,all_delivery_bytes_timing_grid_equal:true,synthetic_reviewer:true,artistic_acceptance:false},null,2));
 }
 bodyCompleted=true;
}finally{
 if(child&&exit===null){child.kill();exit=await child.exited;}
 const cleanupErrors=[];let listenerStopped=false,queueIdle=false,dbClosed=false,captureError=null;
 try{await server.stop(true);listenerStopped=true;}catch(e){cleanupErrors.push(String(e));}
 try{await queue.waitForQueueIdle();queueIdle=true;}catch(e){cleanupErrors.push(String(e));}
 try{writeFileSync(join(workspace,'api-final-evidence.json'),JSON.stringify(evidence(),null,2));}catch(e){captureError=String(e);}
 try{db.close();dbClosed=true;}catch(e){cleanupErrors.push(String(e));}
 writeFileSync(join(workspace,'fixture-lifecycle.json'),JSON.stringify({makerRuns,electron_pid:child?.pid??null,electron_exit:exit,electron_awaited:!child||exit!==null,listener_stop_awaited:listenerStopped,queue_idle_awaited:queueIdle,pending_requests:server.pendingRequests,db_closed:dbClosed,service_only:SERVICE_ONLY,capture_error:captureError,cleanup_errors:cleanupErrors,completed:bodyCompleted&&(SERVICE_ONLY||exit===0)&&!captureError&&!cleanupErrors.length},null,2));
 if(captureError||cleanupErrors.length)throw Error(JSON.stringify({captureError,cleanupErrors}));
}
`).replace('SEED',JSON.stringify(seed)).replace('BUNDLE',JSON.stringify(build.outputs[0]!.path)).replaceAll('SERVICE_ONLY',String(process.argv.includes('--service-only')));
new Bun.Transpiler({loader:'ts'}).transformSync(fixture);
if(process.argv.includes('--prepare-only')){writeFileSync(join(bundle,'prepared-fixture.ts'),fixture);console.log('Serialized fixture parsed; no service or Electron started');process.exit(0);}
const result=await runCollaborationScript(fixture,'t12');
writeFileSync(join(bundle,'fixture-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=result.exit_code;
