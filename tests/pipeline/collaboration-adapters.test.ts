import {test,expect} from 'bun:test';
import {candidateSetup} from './candidateFixture';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
test('maker rework and timing adapters project request identity without payload fields',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {task,request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());
 const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('adapter','maker');
 const maker=auth.authenticateLocalRequest(new Request('http://localhost/test',{headers:{Authorization:'Bearer maker'}}),'localhost');
 const {runMakerTool}=await import('./apps/server/src/mcp/makerTools');
 const input={task_id:task.id,parent_candidate_id:candidate.id,base_content:d.readDraftContent(context).token,request_key:uid()};
 const result=await runMakerTool('start_rework',input,maker);assert.equal(result.task.state,'reworking');
 assert.deepEqual(await runMakerTool('start_rework',input,maker),result);
 const updatedTiming={value:{mode:'explicit_durations',durations:[{num:1,den:12},{num:1,den:24}]},origin:'user'};
 const changed=await runMakerTool('set_output_timing',{...context,timing:updatedTiming,base_content:result.content_token,request_key:uid()},maker);
 assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),updatedTiming.value.durations);
 assert.deepEqual(changed,d.readDraftContent(context).token);
 `,'maker-identity');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},30000);
test('operation cancellation preserves task; explicit task cancellation preserves sticky mode and succeeds idempotently',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {task,request}=await seedCandidate();const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('facade','maker');const req=new Request('http://localhost/test',{headers:{Authorization:'Bearer maker'}}),maker=auth.authenticateLocalRequest(req,'localhost');
 const queue=await import('./apps/server/src/queue');queue.pauseQueue();const {runMakerTool}=await import('./apps/server/src/mcp/makerTools');const created=await runMakerTool('create_candidate',request(),maker);const ops=await import('./apps/server/src/pipeline/collaboration/operations');
 const original=ops.readOperation(created.operation_id);const cancelled=await runMakerTool('cancel_operation',{operation_id:created.operation_id},maker);assert.equal(cancelled.state,'cancelled');const store=await import('./apps/server/src/pipeline/collaboration/store');assert.notEqual(store.readTaskRecord(task.id).state,'cancelled');
 const input={task_id:task.id,expected_acceptance_epoch:store.readTaskRecord(task.id).acceptance_epoch,request_key:uid()};const stopped=await runMakerTool('cancel_task',input,maker);assert.equal(stopped.state,'cancelled');assert.deepEqual(await runMakerTool('cancel_task',input,maker),stopped);assert.equal(store.axisWorkflowMode(context),'collaboration');assert.equal(ops.readOperation(created.operation_id).request_key,original.request_key);
 `,'t10');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},30000);
test('already committed direct candidate and delivery have no invented attempt; resume keeps original identity',async()=>{
 const x=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(2),input=request(),candidate=await c.buildPrivateCandidate(input);await submit(candidate);const queue=await import('./apps/server/src/queue');queue.pauseQueue();r.setDeliveryScheduler(()=>{});
 const maker=auth.authenticateLocalRequest(new Request('http://localhost/test',{headers:{Authorization:'Bearer test-maker'}}),'localhost'),{runMakerTool}=await import('./apps/server/src/mcp/makerTools');const replay=await runMakerTool('create_candidate',input,maker);assert.equal(replay.job_id,null);assert.deepEqual(ops.readOperation(replay.operation_id).attempt_job_ids,[]);
 frames(candidate.id);const accepted=playback(candidate.id),delivery=await import('./apps/server/src/pipeline/collaboration/delivery');const done=await delivery.packageAcceptedCandidate(delivery.readDeliveryRequest(accepted.pending_delivery_operation_id));assert.deepEqual(ops.readOperation(done.operation_id).attempt_job_ids,[]);
 const exported=await runMakerTool('export_assets',context,maker);assert.equal(exported.job_id,null);assert.deepEqual(exported.delivery,done);const resumed=await runMakerTool('resume_operation',{operation_id:done.operation_id},maker);assert.equal(resumed.id,done.operation_id);assert.equal(resumed.state,'succeeded');assert.deepEqual(resumed.attempt_job_ids,[]);
 `,'t10');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},60000);
