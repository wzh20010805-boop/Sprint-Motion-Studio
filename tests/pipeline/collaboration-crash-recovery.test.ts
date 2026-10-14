import {test,expect} from 'bun:test';
import {candidateSetup} from './candidateFixture';
import {child,recoveryImports,recoveryWorkspace} from './recoveryFixture';
for(const phase of ['prepared','moved','committed'])test('OS exit candidate '+phase+' recovers original commit without rendering',async()=>{
 const ws=recoveryWorkspace();
 const crash=await child(ws,'crash',candidateSetup+String.raw`
 const ops=await import('./apps/server/src/pipeline/collaboration/operations');const {request}=await seedCandidate(2),req=request(),op=c.prepareCandidate(req,actor);
 await c.buildPrivateCandidate(req,undefined,undefined,{onPhase(phase,cp){if(phase===`+JSON.stringify(phase)+String.raw`){writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:op.id,hash:op.payload_hash,cp}));process.exit(79);}}});throw Error('failpoint not reached');
 `);expect(crash.code,crash.stderr+' '+ws).toBe(79);
 for(let i=1;i<=2;i++){
  const resumed=await child(ws,'resume-'+i,recoveryImports+String.raw`
 assert.equal(typeof ops.resumeCollaborationOperation,'function','strict operation recovery is required');
 const spawn=Bun.spawn;Bun.spawn=(argv,options)=>{if(String(argv[1]).includes('worker.py')&&JSON.parse(readFileSync(argv[2],'utf8')).action==='export')throw Error('recovery must not rerender candidate');return spawn(argv,options);};
 const q=await import('./apps/server/src/queue');
 const result=await ops.resumeCollaborationOperation(saved.id,actor);await q.waitForQueueIdle();
 const done=ops.readOperation(saved.id);assert.equal(done.id,saved.id);assert.equal(done.payload_hash,saved.hash);assert.equal(done.state,'succeeded',JSON.stringify(done));assert.equal(done.result.candidate_id,saved.cp.candidate_id);
 const c=await import('./apps/server/src/pipeline/collaboration/candidates');c.verifyCandidateFiles(saved.cp.candidate_id);assert.equal(db.query('SELECT COUNT(*) n FROM candidates').get().n,1);
 assert.equal(done.checkpoint.attempt_id,saved.cp.attempt_id);assert.deepEqual(done.checkpoint.files,saved.cp.files);
 assert.ok(db.query("SELECT COUNT(*) n FROM jobs WHERE operation_id=? AND status IN ('queued','running')").get(saved.id).n<=1);
 `);expect(resumed.code,resumed.stderr+' '+ws).toBe(0);
 }
},120000);
import {reviewSetup} from './reviewFixture';
for(const boundary of ['acceptance','packaging','packaging-preview','prepared','moved','moved-revoked','committed','committed-withdrawn'])test('OS exit delivery '+boundary+' reconciles fixed epoch and original bytes',async()=>{
 const ws=recoveryWorkspace();
 const crash=await child(ws,'crash',(boundary==='packaging-preview'?reviewSetup.replace("formats:['png_sequence','spritesheet']","formats:['png_sequence','preview_mp4']"):reviewSetup)+String.raw`
 const q=await import('./apps/server/src/queue');q.pauseQueue();
 const delivery=await import('./apps/server/src/pipeline/collaboration/delivery');
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);
 const boundary=`+JSON.stringify(boundary)+String.raw`;
 if(boundary==='acceptance')r.setDeliveryScheduler(req=>{writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:req.operation_id,hash:ops.readOperation(req.operation_id).payload_hash,candidate:candidate.id,cp:null}));process.exit(79);});
 const accepted=playback(candidate.id),id=accepted.pending_delivery_operation_id;
 await delivery.packageAcceptedCandidate(delivery.readDeliveryRequest(id),undefined,undefined,{onPhase(phase,cp){if(phase===boundary.split('-')[0]){writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id,hash:ops.readOperation(id).payload_hash,candidate:candidate.id,cp}));process.exit(79);}}});throw Error('failpoint missing');
 `);expect(crash.code,crash.stderr+' '+ws).toBe(79);
 for(let i=1;i<=2;i++){
  const resumed=await child(ws,'resume-'+i,recoveryImports+String.raw`
 const q=await import('./apps/server/src/queue');q.pauseQueue();
 const delivery=await import('./apps/server/src/pipeline/collaboration/delivery');
 const boundary=`+JSON.stringify(boundary)+String.raw`;
 if(`+i+String.raw`===1&&['moved-revoked','committed-withdrawn'].includes(boundary)){
  const r=await import('./apps/server/src/pipeline/collaboration/reviews'),c=await import('./apps/server/src/pipeline/collaboration/candidates');
  const secret=auth.issueReviewerSession('recovery-test'),reviewer=auth.authenticateLocalRequest(new Request('http://localhost:3000/test',{headers:{cookie:'sfs_reviewer='+secret}}),'localhost:3000');
  r.applyPlaybackReview({task_id:c.readCandidate(saved.candidate).task_id,candidate_id:saved.candidate,base_review_revision:c.readCandidate(saved.candidate).review_revision,request_key:crypto.randomUUID()},{playback_hash:c.readCandidateManifest(saved.candidate).playback_hash,confirmed:false},reviewer);
 }
 await ops.reconcileCollaborationOperations();q.startQueue();await q.waitForQueueIdle();
 const done=ops.readOperation(saved.id);assert.equal(done.payload_hash,saved.hash);
 if(boundary==='moved-revoked'){assert.notEqual(done.state,'succeeded');assert.ok(done.checkpoint.revocation);assert.throws(()=>delivery.readDelivery(done.id));assert.ok(existsSync(saved.cp.final_directory));}
 else{assert.equal(done.state,'succeeded',JSON.stringify(done));const result=delivery.readDelivery(done.id);assert.equal(result.operation_id,saved.id);assert.equal(result.approval_status,boundary==='committed-withdrawn'?'withdrawn':'approved');if(saved.cp){if(saved.cp.phase==='packaging')for(const file of saved.cp.files)assert.ok(done.checkpoint.delivery.files.some(x=>x.file===file.file&&x.sha256===file.sha256));else assert.deepEqual(done.checkpoint.delivery.files,saved.cp.files);}delivery.deliveryFilePath(done.id,'assets.zip');}
 assert.equal(db.query("SELECT COUNT(*) n FROM collab_operations WHERE kind='deliver_candidate'").get().n,1);
 const state={id:done.id,result:done.result,checkpoint:done.checkpoint,attempts:done.attempt_job_ids};
 if(`+i+String.raw`===1)writeFileSync(join(STORAGE_ROOT,'recovered.json'),JSON.stringify(state));else assert.deepEqual(state,JSON.parse(readFileSync(join(STORAGE_ROOT,'recovered.json'),'utf8')));
 `);expect(resumed.code,resumed.stderr+' '+ws).toBe(0);
 }
},120000);
for(const phase of ['prepared','raw_renamed','timing_renamed','gui_copy','main_track_before','main_track_committed','result','job_result','gui_copy_bad_id','gui_copy_source_changed'])test('OS exit extraction '+phase+' reuses verified source and one original main track',async()=>{
 const ws=recoveryWorkspace();
 const crash=await child(ws,'crash',String.raw`
 import assert from 'node:assert/strict';import {join} from 'node:path';import {writeFileSync} from 'node:fs';
 const {db,STORAGE_ROOT}=await import('./apps/server/src/db');const s=await import('./apps/server/src/pipeline/service');
 const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('extract-fixture','maker');const actor=auth.authenticateLocalRequest(new Request('http://localhost:3000/test',{headers:{authorization:'Bearer maker'}}),'localhost:3000');
 const source=join(STORAGE_ROOT,'input.mp4'),p=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=12','-frames:v','3','-c:v','libx264','-pix_fmt','yuv420p',source],{windowsHide:true,stdout:'pipe',stderr:'pipe'});const error=await new Response(p.stderr).text();assert.equal(await p.exited,0,error);
 const project=s.createProject('crash'),original=await s.importVideo(project.id,source),clip=s.createClip(project.id,original.id,'run');
 const e=await import('./apps/server/src/pipeline/collaboration/extraction'),ops=await import('./apps/server/src/pipeline/collaboration/operations'),q=await import('./apps/server/src/queue');q.pauseQueue();
 const op=e.prepareExtractionOperation(s.prepareSourceExtraction(project.id,clip.id),{request_key:'extraction-fixed'},actor);await ops.resumeCollaborationOperation(op.id,actor);
 const boundary=`+JSON.stringify(phase)+String.raw`;
 if(boundary==='job_result'){q.setQueueCheckpointObserver((phase,id)=>{if(phase==='job_result'){const cp=ops.readOperation(op.id).checkpoint;writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:op.id,hash:op.payload_hash,project:project.id,clip:clip.id,source:original.id,cp}));process.exit(79);}});q.startQueue();await q.waitForQueueIdle();}
 else await e.executeExtractionOperation(op.id,undefined,undefined,{onCheckpoint(phase,cp,index){if(phase===(boundary.startsWith('gui_copy_')?'gui_copy':boundary)){writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:op.id,hash:op.payload_hash,project:project.id,clip:clip.id,source:original.id,cp}));process.exit(79);}}});throw Error('missing failpoint');
 `);expect(crash.code,crash.stderr+' '+ws).toBe(79);
 for(let i=1;i<=2;i++){
  const resumed=await child(ws,'resume-'+i,recoveryImports+String.raw`
 const q=await import('./apps/server/src/queue');const spawn=Bun.spawn;Bun.spawn=(argv,options)=>{if(String(argv[0]).includes('ffmpeg'))throw Error('recovery must not rerun FFmpeg');return spawn(argv,options);};
 const boundary=`+JSON.stringify(phase)+String.raw`;
 if(boundary==='gui_copy_bad_id'){const bad=structuredClone(saved.cp);delete bad.cells[0].frameId;db.query('UPDATE collab_operations SET checkpoint_json=? WHERE id=?').run(JSON.stringify(bad),saved.id);}
 if(boundary==='gui_copy_source_changed'&&`+i+String.raw`===1){const original=db.query('SELECT original_path FROM sources WHERE id=?').get(saved.source).original_path;writeFileSync(original+'.retained',readFileSync(original));writeFileSync(original,'changed source bytes');}
 await ops.resumeCollaborationOperation(saved.id,actor);await q.waitForQueueIdle();const op=ops.readOperation(saved.id);
 if(boundary.startsWith('gui_copy_')){assert.equal(op.state,'needs_input');assert.equal(op.result.error_code,boundary==='gui_copy_bad_id'?'RECOVERY_IDENTITY_CONFLICT':'INPUT_IDENTITY_CONFLICT');assert.equal(db.query('SELECT COUNT(*) n FROM frames WHERE project_id=?').get(saved.project).n,0);process.exit(0);}
 assert.equal(op.state,'succeeded',JSON.stringify(op));assert.equal(op.payload_hash,saved.hash);assert.equal(op.checkpoint.attempt_id,saved.cp.attempt_id);assert.deepEqual(op.checkpoint.files,saved.cp.files);assert.equal(op.result.frame_count,3);
 const cells=db.query('SELECT f.id,f.step_id,f.metadata,s.idx FROM frames f JOIN animation_steps s ON s.id=f.step_id WHERE f.project_id=? ORDER BY s.idx').all(saved.project);assert.equal(cells.length,3);assert.deepEqual(cells.map(x=>x.idx),[0,1,2]);assert.deepEqual(cells.map(x=>JSON.parse(x.metadata).timing.display_duration),[{num:1,den:12},{num:1,den:12},{num:1,den:12}]);
 const state={result:op.result,cp:op.checkpoint,cells,attempts:op.attempt_job_ids};if(`+i+String.raw`===1)writeFileSync(join(STORAGE_ROOT,'recovered.json'),JSON.stringify(state));else assert.deepEqual(state,JSON.parse(readFileSync(join(STORAGE_ROOT,'recovered.json'),'utf8')));
 `);expect(resumed.code,resumed.stderr+' '+ws).toBe(0);
 }
},120000);
for(const kind of ['candidate','delivery'])test('OS exit '+kind+' after job result repairs same original attempt',async()=>{
 const ws=recoveryWorkspace();const setup=kind==='candidate'?candidateSetup:reviewSetup;
 const crash=await child(ws,'crash',setup+String.raw`
 const q=await import('./apps/server/src/queue');
 const operationStore=await import('./apps/server/src/pipeline/collaboration/operations');
 q.setQueueCheckpointObserver((phase,id)=>{if(phase==='job_result'){const job=q.getPersistedJob(id),op=operationStore.readOperation(job.operation_id);writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:op.id,hash:op.payload_hash,cp:op.checkpoint,result:op.result,jobs:op.attempt_job_ids,jobResult:job.result}));process.exit(79);}});
 const {request}=await seedCandidate(2);
 `+(kind==='candidate'?String.raw`c.createPrivateCandidate(request(),actor);`:String.raw`const candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);playback(candidate.id);`)+String.raw`
 await q.waitForQueueIdle();throw Error('missing result failpoint');
 `);expect(crash.code,crash.stderr+' '+ws).toBe(79);
 for(let i=1;i<=2;i++){
  const result=await child(ws,'resume-'+i,recoveryImports+String.raw`
 const q=await import('./apps/server/src/queue');await ops.resumeCollaborationOperation(saved.id,actor);await q.waitForQueueIdle();const op=ops.readOperation(saved.id);
 assert.equal(op.state,'succeeded');assert.deepEqual(op.attempt_job_ids,saved.jobs);assert.deepEqual(op.result,saved.result);assert.deepEqual(op.checkpoint,saved.cp);const job=q.getPersistedJob(saved.jobs.at(-1));assert.equal(job.status,'done');assert.deepEqual(job.result,saved.jobResult);
 `);expect(result.code,result.stderr+' '+ws).toBe(0);
 }
},120000);
for(const damage of ['tampered','missing','wrong-owner','changed-base'])test('candidate crash evidence '+damage+' remains unpublished and retained',async()=>{
 const ws=recoveryWorkspace();
 const crash=await child(ws,'crash',candidateSetup+String.raw`
 const {request}=await seedCandidate(2),req=request(),op=c.prepareCandidate(req,actor);
 await c.buildPrivateCandidate(req,undefined,undefined,{onPhase(phase,cp){if(phase==='prepared'){writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:op.id,hash:op.payload_hash,cp,project:project.id}));process.exit(79);}}});
 `);expect(crash.code,crash.stderr).toBe(79);
 const result=await child(ws,'resume-1',recoveryImports+String.raw`
 const {renameSync}=await import('node:fs'),damage=`+JSON.stringify(damage)+String.raw`;
 const file=join(saved.cp.staging_directory,saved.cp.files[0].file);
 if(damage==='tampered'){writeFileSync(file+'.retained',readFileSync(file));writeFileSync(file,'corrupt');}
 if(damage==='missing')renameSync(file,file+'.retained');
 if(damage==='wrong-owner')db.query('UPDATE collab_operations SET checkpoint_json=? WHERE id=?').run(JSON.stringify({...saved.cp,operation_id:'other'}),saved.id);
 if(damage==='changed-base')db.query('UPDATE frames SET offset_x=offset_x+1 WHERE project_id=?').run(saved.project);
 const q=await import('./apps/server/src/queue');await ops.resumeCollaborationOperation(saved.id,actor);await q.waitForQueueIdle();const op=ops.readOperation(saved.id);assert.equal(op.state,'needs_input');assert.equal(op.payload_hash,saved.hash);assert.equal(db.query('SELECT COUNT(*) n FROM candidates').get().n,0);assert.ok(existsSync(saved.cp.staging_directory));
 assert.equal(op.result.error_code,damage==='changed-base'?'INPUT_IDENTITY_CONFLICT':damage==='wrong-owner'?'RECOVERY_IDENTITY_CONFLICT':'ARTIFACT_INTEGRITY_CONFLICT');
 `);expect(result.code,result.stderr+' '+ws).toBe(0);
},120000);
test('packaging crash cannot trust forged ZIP when exact loose files are restored',async()=>{
 const ws=recoveryWorkspace();
 const crash=await child(ws,'crash',reviewSetup+String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const a=playback(candidate.id);
 const delivery=await import('./apps/server/src/pipeline/collaboration/delivery');
 await delivery.packageAcceptedCandidate(delivery.readDeliveryRequest(a.pending_delivery_operation_id),undefined,undefined,{onPhase(phase,cp){if(phase==='packaging'){writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:cp.operation_id,hash:ops.readOperation(cp.operation_id).payload_hash,cp}));process.exit(79);}}});
 `);expect(crash.code,crash.stderr).toBe(79);
 const result=await child(ws,'resume-1',recoveryImports+String.raw`
 const {imagePython}=await import('./apps/server/src/pipeline/masks');
 const p=Bun.spawn([imagePython(),'-c',"import json,zipfile,pathlib,sys;p=pathlib.Path(sys.argv[1]);files=json.loads(sys.argv[2]);z=zipfile.ZipFile(p/'assets.zip','w');[(z.writestr(f,(b'forged-document' if f=='manifest.json' else (p/f).read_bytes()))) for f in files];z.close()",saved.cp.staging_directory,JSON.stringify(saved.cp.files.map(x=>x.file))],{windowsHide:true,stdout:'pipe',stderr:'pipe'});const error=await new Response(p.stderr).text();assert.equal(await p.exited,0,error);
 const q=await import('./apps/server/src/queue');await ops.resumeCollaborationOperation(saved.id,actor);await q.waitForQueueIdle();const op=ops.readOperation(saved.id);assert.equal(op.state,'needs_input');assert.equal(op.checkpoint.revocation,null);assert.ok(existsSync(join(saved.cp.staging_directory,'assets.zip')));assert.ok(!existsSync(saved.cp.final_directory));
 `);expect(result.code,result.stderr+' '+ws).toBe(0);
},120000);
