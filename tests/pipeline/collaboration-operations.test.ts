import { test, expect } from 'bun:test';
import { runCollaborationScript, seedScript } from './collaborationFixtures';

test('operation claims canonicalize JSON, retain checkpoints on restart, and reject changed payload or kind', async () => {
  const result = await runCollaborationScript(seedScript + `
    const {claimOperation,readOperation,writeOperationCheckpoint}=await import('./apps/server/src/pipeline/collaboration/operations.ts');
    const payload={context:brief.context,base_content:{revision:2,hash:'${'a'.repeat(64)}'},z:1,a:{y:2,x:1}};
    const first=claimOperation('candidate',{request_key:'same'},payload);
    const second=claimOperation('candidate',{request_key:'same'},{a:{x:1,y:2},z:1,base_content:payload.base_content,context:brief.context});assert.equal(second.id,first.id);
    assert.equal(first.state,'claimed');assert.deepEqual(first.base_content,payload.base_content);assert.deepEqual(first.attempt_job_ids,[]);
    assert.throws(()=>claimOperation('candidate',{request_key:'same'},{...payload,z:2}),e=>e.code==='REQUEST_CONFLICT');
    assert.throws(()=>claimOperation('delivery',{request_key:'same'},payload),e=>e.code==='REQUEST_CONFLICT');
    writeOperationCheckpoint(first.id,{stage:'files_ready',files:[{path:'retained.png',sha256:'${'b'.repeat(64)}'}]});assert.equal(readOperation(first.id).checkpoint.stage,'files_ready');
    const child=Bun.spawn([process.execPath,'-e',"const {readOperation}=await import('./apps/server/src/pipeline/collaboration/operations.ts');console.log(JSON.stringify(readOperation('"+first.id+"')))"],{cwd:process.cwd(),env:process.env,windowsHide:true,stdout:'pipe',stderr:'pipe'});
    const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(exit,0,err);assert.equal(JSON.parse(out).checkpoint.stage,'files_ready');
    assert.throws(()=>readOperation('missing'),e=>e.code==='OPERATION_NOT_FOUND');assert.throws(()=>writeOperationCheckpoint('missing',{}),e=>e.code==='OPERATION_NOT_FOUND');
    db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});

test('task creation persists immutable brief and axis collaboration mode without promoting approvals', async () => {
  const result = await runCollaborationScript(seedScript + `
    const {createTaskRecord,readTaskRecord,axisWorkflowMode,setAxisWorkflowMode}=await import('./apps/server/src/pipeline/collaboration/store.ts');
    assert.equal(axisWorkflowMode(brief.context),'legacy');const first=createTaskRecord(brief,{request_key:'create-task'});
    assert.deepEqual(readTaskRecord(first.id),first);assert.equal(first.brief_version,1);assert.equal(first.state,'preparing');assert.equal(first.acceptance_epoch,0);assert.equal(first.selected_candidate_id,null);assert.equal(first.operation_ids.length,1);assert.equal(first.content_token.hash.length,64);
    assert.equal(createTaskRecord(brief,{request_key:'create-task'}).id,first.id);assert.equal(axisWorkflowMode(brief.context),'collaboration');
    assert.throws(()=>createTaskRecord({...brief,loop:{value:false,origin:'user'}},{request_key:'create-task'}),e=>e.code==='REQUEST_CONFLICT');
    db.query('UPDATE collab_tasks SET state=? WHERE id=?').run('cancelled',first.id);assert.equal(axisWorkflowMode(brief.context),'collaboration');setAxisWorkflowMode(brief.context,'collaboration');
    assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);assert.equal(db.query('SELECT count(*) AS n FROM task_briefs').get().n,1);
    assert.deepEqual(JSON.parse(db.query('SELECT brief_json FROM task_briefs WHERE task_id=?').get(first.id).brief_json),{...brief,source_identity:{kind:'video',original_sha256:sourceHash,frames:[]}});db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});

test('invalid requests and foreign axes cannot create partial task or operation records', async () => {
  const result = await runCollaborationScript(seedScript + `
    const {claimOperation}=await import('./apps/server/src/pipeline/collaboration/operations.ts');const {createTaskRecord,axisWorkflowMode}=await import('./apps/server/src/pipeline/collaboration/store.ts');
    assert.throws(()=>claimOperation('candidate',{request_key:''},{}),e=>e.code==='INVALID_REQUEST');
    assert.throws(()=>claimOperation('candidate',{request_key:'undefined'},{value:undefined}),e=>e.code==='INVALID_PAYLOAD');
    assert.throws(()=>createTaskRecord({...brief,context:{project_id:'p',axis_id:'missing'}},{request_key:'foreign'}),e=>e.code==='AXIS_NOT_FOUND');
    assert.throws(()=>createTaskRecord({...brief,source_id:'missing'},{request_key:'source'}),e=>e.code==='SOURCE_NOT_FOUND');
    assert.throws(()=>createTaskRecord({...brief,loop:{value:true,origin:'ai'}},{request_key:'invalid'}),e=>e.code==='INVALID_TASK_BRIEF');
    assert.equal(db.query('SELECT count(*) AS n FROM collab_tasks').get().n,0);assert.equal(db.query('SELECT count(*) AS n FROM collab_operations').get().n,0);assert.equal(axisWorkflowMode(brief.context),'legacy');db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});
