import {test,expect} from 'bun:test';
import {candidateSetup} from './candidateFixture';
import {runCollaborationScript} from './collaborationFixtures';
test('core refuses missing literal goal and freezes verified original PNG byte identities',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const seeded=await seedCandidate();
 const missing={...seeded.brief};delete missing.goal;assert.throws(()=>d.createCollaborationTask(missing,{request_key:uid()},actor),e=>e.code==='TASK_GOAL_REQUIRED');
 const goal='保留全部帧，制作连续跑步动作。';const task=d.createCollaborationTask({...seeded.brief,goal:{value:goal,origin:'user'}},{request_key:uid()},actor);
 const saved=JSON.parse(db.query('SELECT brief_json FROM task_briefs WHERE task_id=?').get(task.id).brief_json);
 assert.equal(saved.goal.value,goal);assert.equal(saved.goal.origin,'user');assert.equal(saved.source_identity.kind,'png_sequence');assert.equal(saved.source_identity.original_sha256,fileHash(getSource(project.id,seeded.imp.source_id).original_path));assert.equal(saved.source_identity.frames.length,2);
 assert.throws(()=>d.createCollaborationTask({...seeded.brief,goal:{value:goal,origin:'user'},source_identity:{...saved.source_identity,original_sha256:'b'.repeat(64)}},{request_key:uid()},actor),e=>e.code==='SOURCE_IDENTITY_CONFLICT');
 const {createTaskFromInput}=await import('./apps/server/src/pipeline/collaboration/creation');const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('provenance','maker');const maker=auth.authenticateLocalRequest(new Request('http://localhost/test',{headers:{Authorization:'Bearer maker'}}),'localhost');const partial={context,source_id:seeded.imp.source_id};const requestKey=uid(),needed=createTaskFromInput(partial,requestKey,maker);assert.equal(needed.status,'needs_input');assert.equal(needed.resume.request_key,requestKey);assert.deepEqual(needed.resume.brief,partial);assert.ok(needed.missing.some(x=>x.field==='goal'&&x.reason&&x.recommendation));assert.throws(()=>createTaskFromInput(null,uid(),maker),e=>e.code==='INVALID_INPUT');
 `,'t10');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},60000);
