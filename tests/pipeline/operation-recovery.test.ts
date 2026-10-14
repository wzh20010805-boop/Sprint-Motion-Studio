import {test,expect} from 'bun:test';
import {runCollaborationScript,seedScript} from './collaborationFixtures';
test('original operation payload/base projection must agree before recovery',async()=>{
 const r=await runCollaborationScript(seedScript+String.raw`
 const ops=await import('./apps/server/src/pipeline/collaboration/operations');
 const base={revision:1,hash:'b'.repeat(64)},op=ops.claimOperation('build_candidate',{request_key:'immutable-key'},{base_content:base,value:1});
 db.query('UPDATE collab_operations SET base_content_json=? WHERE id=?').run(JSON.stringify({...base,revision:2}),op.id);
 assert.throws(()=>ops.readOperationInput(op.id,'build_candidate'),e=>e.code==='RECOVERY_IDENTITY_CONFLICT');
 `,'t9');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
});
import {candidateSetup} from './candidateFixture';
const authSetup=String.raw`
const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('current','maker');const currentActor=auth.authenticateLocalRequest(new Request('http://localhost:3000/test',{headers:{authorization:'Bearer maker'}}),'localhost:3000');
const ops=await import('./apps/server/src/pipeline/collaboration/operations'),q=await import('./apps/server/src/queue');q.pauseQueue();
`;
const check=async(script:string)=>{const r=await runCollaborationScript(candidateSetup+authSetup+script,'t9');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);};
test('current authority, concurrent resume and durable cancellation preserve one attempt',()=>check(String.raw`
const {request}=await seedCandidate(2),req=request(),op=c.prepareCandidate(req,actor);
await assert.rejects(ops.resumeCollaborationOperation(op.id,{role:'maker',session_id:'current:maker'}),e=>e.code==='ROLE_FORBIDDEN');
const [a,b]=await Promise.all([ops.resumeCollaborationOperation(op.id,currentActor),ops.resumeCollaborationOperation(op.id,currentActor)]);assert.equal(a.attempt_job_ids.length,1);assert.deepEqual(a.attempt_job_ids,b.attempt_job_ids);
const id=a.attempt_job_ids[0];assert.equal(q.cancelJob(id),true);assert.equal(q.cancelJob(id),true);assert.equal(ops.readOperation(op.id).state,'cancelled');await ops.reconcileCollaborationOperations();q.startQueue();await q.waitForQueueIdle();assert.equal(ops.readOperation(op.id).state,'cancelled');assert.equal(db.query('SELECT count(*) n FROM candidates').get().n,0);
await assert.rejects(q.resumeJob(id),e=>e.code==='UNAUTHORIZED');assert.equal(q.getPersistedJob(id).operation_id,op.id);
auth.initializeLocalSessions('next','new');await assert.rejects(ops.resumeCollaborationOperation(op.id,currentActor),e=>e.code==='ROLE_FORBIDDEN');
`),120000);
test('changed draft and corrupt checkpoint fail closed without replacing original identity',()=>check(String.raw`
const {request}=await seedCandidate(2),req=request(),op=c.prepareCandidate(req,actor);db.query('UPDATE frames SET offset_x=offset_x+1 WHERE project_id=?').run(project.id);
const result=await ops.resumeCollaborationOperation(op.id,currentActor);assert.equal(result.state,'needs_input');assert.equal(result.result.error_code,'INPUT_IDENTITY_CONFLICT');assert.equal(result.payload_hash,op.payload_hash);assert.equal(result.attempt_job_ids.length,0);
const next=c.prepareCandidate(request(),actor);ops.writeOperationCheckpoint(next.id,{version:999,operation_id:next.id});await ops.resumeCollaborationOperation(next.id,currentActor);assert.equal(ops.readOperation(next.id).result.error_code,'RECOVERY_IDENTITY_CONFLICT');assert.equal(ops.readOperation(next.id).attempt_job_ids.length,0);
`),120000);
test('late checkpoint cannot overwrite a committed candidate and commit wins cancellation',()=>check(String.raw`
const {request}=await seedCandidate(2),req=request(),candidate=await c.buildPrivateCandidate(req),op=c.prepareCandidate(req,actor);const cp=op.checkpoint;
assert.throws(()=>ops.writeOperationCheckpoint(op.id,{...cp,phase:'prepared'}),e=>e.code==='OPERATION_ALREADY_COMMITTED');
db.query('UPDATE frames SET offset_y=offset_y+1 WHERE project_id=?').run(project.id);const done=await ops.resumeCollaborationOperation(op.id,currentActor);assert.equal(done.state,'succeeded');assert.equal(done.result.candidate_id,candidate.id);assert.equal(done.attempt_job_ids.length,0);
`),120000);
test('a bad startup operation is isolated while valid pending work remains queued behind gate',()=>check(String.raw`
const {request}=await seedCandidate(2),good=c.prepareCandidate(request(),actor),bad=ops.claimOperation('future_kind',{request_key:'unknown'},{value:1});
await ops.reconcileCollaborationOperations();assert.equal(ops.readOperation(bad.id).state,'needs_input');assert.equal(ops.readOperation(good.id).state,'queued');assert.equal(db.query('SELECT count(*) n FROM candidates').get().n,0);
q.startQueue();await q.waitForQueueIdle();assert.equal(ops.readOperation(good.id).state,'succeeded');assert.equal(ops.readOperation(bad.id).attempt_job_ids.length,0);
`),120000);
test('explicit Task continuation can resume cancelled original input while startup cannot',()=>check(String.raw`
const {request,task}=await seedCandidate(2),parent=await c.buildPrivateCandidate(request()),req=request(),op=c.prepareCandidate(req,actor);
await ops.resumeCollaborationOperation(op.id,currentActor);const stopped=ops.readOperation(op.id).attempt_job_ids[0];q.cancelJob(stopped);await ops.reconcileCollaborationOperations();assert.equal(ops.readOperation(op.id).state,'cancelled');
d.startRework(task.id,parent.id,d.readDraftContent(context).token,{request_key:uid()},actor);
await ops.resumeCollaborationOperation(op.id,currentActor);q.startQueue();await q.waitForQueueIdle();assert.equal(ops.readOperation(op.id).state,'succeeded');assert.equal(ops.readOperation(op.id).payload_hash,op.payload_hash);assert.equal(q.getPersistedJob(stopped).status,'cancelled');assert.equal(ops.readOperation(op.id).attempt_job_ids.length,2);
`),120000);
test('workspace lock failure prevents bootstrap DB creation',async()=>{
const r=await runCollaborationScript(String.raw`
import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {join} from 'node:path';
const {acquireServiceLock}=await import('./apps/server/src/runtime');const lock=acquireServiceLock(process.env.SFS_WORKSPACE);
const child=Bun.spawn([process.execPath,'apps/server/src/runtimeBootstrap.ts'],{env:process.env,windowsHide:true,stdout:'pipe',stderr:'pipe'});const error=await new Response(child.stderr).text();assert.notEqual(await child.exited,0);assert.match(error,/WORKSPACE_LOCKED/);assert.equal(existsSync(join(process.env.SFS_WORKSPACE,'framebaker.db')),false);lock.release();
`,'t9');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
});
test('malformed persisted JSON is isolated as needs_input while startup continues',()=>check(String.raw`
const {request}=await seedCandidate(2),good=c.prepareCandidate(request(),actor),bad=c.prepareCandidate(request(),actor);
db.query('UPDATE collab_operations SET checkpoint_json=? WHERE id=?').run('{broken-json',bad.id);
await ops.reconcileCollaborationOperations();assert.equal(db.query('SELECT state FROM collab_operations WHERE id=?').get(bad.id).state,'needs_input');assert.equal(db.query('SELECT checkpoint_json FROM collab_operations WHERE id=?').get(bad.id).checkpoint_json,'{broken-json');
q.startQueue();await q.waitForQueueIdle();assert.equal(ops.readOperation(good.id).state,'succeeded');
`),120000);
