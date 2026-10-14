import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {candidateSetup} from './candidateFixture';
test('fixed candidate survives draft edits, rejects missing selfcheck, preserves operation identity',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {task,request}=await seedCandidate();const req=request();
 const candidate=await c.buildPrivateCandidate(req);const manifest=c.readCandidateManifest(candidate.id);
 const report=await checkCandidate(candidate.id);assert.equal(report.checked_frame_count,2);assert.deepEqual(report.blocking_errors,[]);
 assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/SELF_CHECK_REQUIRED/);
 const saved=readFileSync(candidate.manifest_path);const finalHash=fileHash(join(c.candidateDirectory(candidate.id),manifest.frames[0].files.png));
 db.query('UPDATE frames SET offset_x=offset_x+1 WHERE id=?').run(manifest.frames[0].frame_id);
 assert.notEqual(d.readDraftContent(context).token.hash,req.base_content.hash);
 assert.deepEqual(readFileSync(candidate.manifest_path),saved);assert.equal(fileHash(join(c.candidateDirectory(candidate.id),manifest.frames[0].files.png)),finalHash);
 assert.equal((await c.buildPrivateCandidate(req)).id,candidate.id);
 const next=await c.buildPrivateCandidate(request());assert.notEqual(next.id,candidate.id);assert.notEqual(c.readCandidateManifest(next.id).frames[0].content_hash,manifest.frames[0].content_hash);
 assert.throws(()=>c.prepareCandidate({...req,parent_candidate_id:next.id},actor),/REQUEST_CONFLICT/);
 const {readOperation}=await import('./apps/server/src/pipeline/collaboration/operations');const op=db.query('SELECT id FROM collab_operations WHERE request_key=?').get(req.request_key);assert.equal(readOperation(op.id).checkpoint.phase,'committed');
 console.log('immutable private candidate and replay verified');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);

test('overlapping candidates retain current history and only newest operation owns task lifecycle',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {task,request}=await seedCandidate();
 const taskRow=()=>db.query('SELECT state,operation_ids_json,selected_candidate_id,acceptance_epoch,recovery_json FROM collab_tasks WHERE id=?').get(task.id);
 const operation=req=>db.query('SELECT id,state FROM collab_operations WHERE request_key=?').get(req.request_key);
 function barrier(){let release,arrive;const gate=new Promise(r=>release=r),reached=new Promise(r=>arrive=r);return {release,reached,hook:async(p)=>{if(p==='copied'){arrive();await gate;}}};}
 const errors=[];
 function verifyHistory(a,b){const ids=JSON.parse(taskRow().operation_ids_json);for(const req of [a,b])if(!ids.includes(operation(req).id))errors.push('lost operation '+operation(req).id);}
 function verifyStage(expected){if(taskRow().state!==expected)errors.push('expected '+expected+', got '+taskRow().state);}
 // B completes or cancels before the older A reaches its commit.
 for(const outcome of ['complete','cancel']){
  const a=request(),b=request(),hold=barrier();const pendingA=c.buildPrivateCandidate(a,undefined,undefined,{onPhase:hold.hook});await hold.reached;
  if(outcome==='complete')await c.buildPrivateCandidate(b);else {const ac=new AbortController();await assert.rejects(c.buildPrivateCandidate(b,ac.signal,undefined,{onPhase:p=>{if(p==='copied')ac.abort();}}));}
  hold.release();await pendingA;verifyHistory(a,b);verifyStage(outcome==='complete'?'checking':'needs_input');
 }
 // A finishing/failing/cancelling while newer B is still working cannot change B's stage.
 for(const outcome of ['complete','error','cancel']){
  const a=request(),b=request(),ha=barrier(),hb=barrier(),ac=new AbortController();
  const pendingA=c.buildPrivateCandidate(a,ac.signal,undefined,{onPhase:async(p)=>{await ha.hook(p);if(p==='copied'&&outcome==='error')throw new Error('controlled older failure');}}).then(value=>({value}),error=>({error}));await ha.reached;
  const pendingB=c.buildPrivateCandidate(b,undefined,undefined,{onPhase:hb.hook});await hb.reached;
  // 再次进入已关联旧操作不能夺回新请求的归属（排队后开始运行的同一路径）。
  c.markCandidateProducing(task.id,operation(a).id);assert.equal(JSON.parse(taskRow().recovery_json).candidate_operation.operation_id,operation(b).id);
  if(outcome==='cancel')ac.abort();ha.release();const finishedA=await pendingA;
  assert.equal(Boolean(finishedA.error),outcome!=='complete');verifyHistory(a,b);verifyStage('producing');hb.release();await pendingB;verifyStage('checking');
 }
 // Isolated boundary fixture models a later selected/review state, not a selfcheck or human approval.
 const a=request(),b=request(),hold=barrier();const pendingA=c.buildPrivateCandidate(a,undefined,undefined,{onPhase:hold.hook});await hold.reached;const newer=await c.buildPrivateCandidate(b);
 db.query("UPDATE collab_tasks SET state='awaiting_review',selected_candidate_id=?,acceptance_epoch=acceptance_epoch+1 WHERE id=?").run(newer.id,task.id);
 hold.release();await pendingA;verifyHistory(a,b);verifyStage('awaiting_review');assert.equal(taskRow().selected_candidate_id,newer.id);
 assert.deepEqual(errors,[]);console.log('overlap history and ownership barriers verified');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},180000);

test('three identities exclude packing and version labels but retain actual bytes and effective parameters',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {brief,task,request}=await seedCandidate();const first=await c.buildPrivateCandidate(request()),before=c.readCandidateManifest(first.id);
 const old=maskState(before.frames[0].frame_id).current,nextMask=uid();
 db.query('INSERT INTO mask_versions(id,frame_id,parent_id,kind,mask_path,rgba_path,preview_path,raw_path,raw_sha256,info,created_at) SELECT ?,frame_id,id,kind,mask_path,rgba_path,preview_path,raw_path,raw_sha256,info,? FROM mask_versions WHERE id=?').run(nextMask,Date.now(),old.id);
 db.query('UPDATE mask_heads SET version_id=? WHERE frame_id=?').run(nextMask,before.frames[0].frame_id);
 const second=await c.buildPrivateCandidate(request()),after=c.readCandidateManifest(second.id);assert.equal(before.frames[0].content_hash,after.frames[0].content_hash);assert.equal(before.playback_hash,after.playback_hash);assert.notEqual(before.content_hash,after.content_hash);assert.equal(second.technical_check_id,null);
 const otherTask=d.createCollaborationTask({...brief,output:{...brief.output,value:{...brief.output.value,max_texture:128}}},{request_key:uid()},actor);
 const third=await c.buildPrivateCandidate({...request(),task_id:otherTask.id}),packed=c.readCandidateManifest(third.id);
 assert.deepEqual(packed.frames.map(f=>f.content_hash),after.frames.map(f=>f.content_hash));assert.equal(packed.playback_hash,after.playback_hash);assert.notEqual(packed.content_hash,after.content_hash);assert.notDeepEqual(packed.grid,after.grid);assert.deepEqual((await checkCandidate(third.id)).blocking_errors,[]);
 const {candidateFrameHash,candidatePlaybackHash}=await import('./apps/server/src/pipeline/collaboration/candidateIdentity');const changed=structuredClone(packed);changed.frames[0].duration={num:1,den:24};assert.equal(candidateFrameHash(changed.frames[0],changed),packed.frames[0].content_hash);assert.notEqual(candidatePlaybackHash(changed),packed.playback_hash);
 console.log('three independent identity projections verified');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);

test('freeze and commit windows retain evidence; cancellation before commit blocks and late abort retains private record',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {request}=await seedCandidate();const {readOperation}=await import('./apps/server/src/pipeline/collaboration/operations');const {existsSync}=await import('node:fs');
 for(const phase of ['copied','rendered','prepared','moved']){
  const req=request(),ac=new AbortController();let checkpoint;
  await assert.rejects(c.buildPrivateCandidate(req,ac.signal,undefined,{onPhase:(p,cp)=>{if(p===phase){checkpoint=structuredClone(cp);ac.abort();}}}));
  const op=readOperation(db.query('SELECT id FROM collab_operations WHERE request_key=?').get(req.request_key).id);assert.equal(op.state,'cancelled');assert.equal(db.query('SELECT id FROM candidates WHERE id=?').get(checkpoint.candidate_id),null);assert.ok(existsSync(phase==='moved'?checkpoint.final_directory:checkpoint.staging_directory));
 }
 const baseRequest=request();await assert.rejects(c.buildPrivateCandidate(baseRequest,undefined,undefined,{onPhase:(phase)=>{if(phase==='prepared')db.query('UPDATE frames SET offset_x=offset_x+1 WHERE project_id=?').run(project.id);}}),/CONTENT_CONFLICT/);
 const failed=readOperation(db.query('SELECT id FROM collab_operations WHERE request_key=?').get(baseRequest.request_key).id);assert.equal(failed.state,'needs_input');assert.equal(failed.checkpoint.phase,'prepared');
 const req=request(),ac=new AbortController();const late=await c.buildPrivateCandidate(req,ac.signal,undefined,{onPhase:(p)=>{if(p==='committed')ac.abort();}});assert.equal(late.visibility,'private');assert.equal((await c.buildPrivateCandidate(req)).id,late.id);
 const mutated=request();await assert.rejects(c.buildPrivateCandidate(mutated,undefined,undefined,{onPhase:(p,cp)=>{if(p==='copied')writeFileSync(join(cp.staging_directory,'inputs/0/raw.png'),'changed');}}));
 console.log('cancel and stale freeze evidence retained');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},180000);

test('queue atomically persists original operation association before execution and idempotent scheduling',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {request}=await seedCandidate();await import('./apps/server/src/queue');const req=request(),job=c.createPrivateCandidate(req,actor);const again=c.createPrivateCandidate(req,actor);assert.deepEqual(again,job);
 const persisted=db.query('SELECT operation_id,attempt_number,payload FROM jobs WHERE id=?').get(job.job_id);assert.equal(persisted.operation_id,job.operation_id);assert.equal(persisted.attempt_number,1);assert.deepEqual(JSON.parse(persisted.payload).candidateBuild.request,req);
 const {readOperation}=await import('./apps/server/src/pipeline/collaboration/operations');assert.deepEqual(readOperation(job.operation_id).attempt_job_ids,[job.job_id]);
 const producing=db.query('SELECT state,operation_ids_json FROM collab_tasks WHERE id=?').get(req.task_id);assert.equal(producing.state,'producing');assert.ok(JSON.parse(producing.operation_ids_json).includes(job.operation_id));
 for(let i=0;i<200&&['queued','running'].includes(db.query('SELECT status FROM jobs WHERE id=?').get(job.job_id).status);i++)await Bun.sleep(25);
 const done=db.query('SELECT status,result,error FROM jobs WHERE id=?').get(job.job_id);assert.equal(done.status,'done',done.error);assert.equal(readOperation(job.operation_id).state,'succeeded');assert.equal(readOperation(job.operation_id).checkpoint.job_id,job.job_id);console.log('atomic association verified');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
test('candidate coverage rejects missing primary cell and same-count wrong mapping',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {imp,request}=await seedCandidate();const original=db.query('SELECT step_id,metadata FROM frames WHERE id=?').get(imp.frame_ids[0]);
 db.query('UPDATE frames SET step_id=NULL WHERE id=?').run(imp.frame_ids[0]);
 await assert.rejects(c.buildPrivateCandidate(request()),/MISSING_PRIMARY_FRAME/);
 db.query('UPDATE frames SET step_id=? WHERE id=?').run(original.step_id,imp.frame_ids[0]);const other=db.query('SELECT metadata FROM frames WHERE id=?').get(imp.frame_ids[1]);
 db.query('UPDATE frames SET metadata=? WHERE id=?').run(other.metadata,imp.frame_ids[0]);await assert.rejects(c.buildPrivateCandidate(request()),/SOURCE_MAPPING_MISMATCH/);
 db.query('UPDATE frames SET metadata=? WHERE id=?').run(original.metadata,imp.frame_ids[0]);db.query('DELETE FROM settings WHERE key=?').run('sfs.alignment.'+project.id+'.'+axis.id);await assert.rejects(c.buildPrivateCandidate(request()),/ALIGNMENT_REQUIRED/);
 console.log('complete selection independently enforced');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
