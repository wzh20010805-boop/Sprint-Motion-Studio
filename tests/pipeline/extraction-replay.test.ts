import {test,expect} from 'bun:test';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {child,repo,recoveryImports} from './recoveryFixture';

const setup=String.raw`
import assert from 'node:assert/strict';import {join} from 'node:path';import {writeFileSync} from 'node:fs';
const {db,STORAGE_ROOT}=await import('./apps/server/src/db'),s=await import('./apps/server/src/pipeline/service');
const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('fix01','maker');const actor=auth.authenticateLocalRequest(new Request('http://localhost:3000/test',{headers:{authorization:'Bearer maker'}}),'localhost:3000');
const source=join(STORAGE_ROOT,'input.mp4'),p=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=12','-frames:v','3','-c:v','libx264','-pix_fmt','yuv420p',source],{windowsHide:true,stdout:'pipe',stderr:'pipe'});const error=await new Response(p.stderr).text();assert.equal(await p.exited,0,error);
const project=s.createProject('historical extraction'),original=await s.importVideo(project.id,source),clip=s.createClip(project.id,original.id,'run');
const e=await import('./apps/server/src/pipeline/collaboration/extraction'),ops=await import('./apps/server/src/pipeline/collaboration/operations'),q=await import('./apps/server/src/queue');q.pauseQueue();
const op=e.prepareExtractionOperation(s.prepareSourceExtraction(project.id,clip.id),{request_key:'original-extraction'},actor);await ops.resumeCollaborationOperation(op.id,actor);
const save=()=>writeFileSync(join(STORAGE_ROOT,'crash.json'),JSON.stringify({id:op.id,project:project.id,source:original.id,clip,op:ops.readOperation(op.id)}));
`;
const resume=recoveryImports+String.raw`
const e=await import('./apps/server/src/pipeline/collaboration/extraction'),q=await import('./apps/server/src/queue');q.pauseQueue();
Bun.spawn=()=>{throw Error('historical recovery must not start FFmpeg or any worker');};
`;
function workspace(){const path=join(repo,'fixtures/generated/human-ai','t9f-'+crypto.randomUUID().replaceAll('-','').slice(0,10));mkdirSync(path,{recursive:true});return path;}

for(const edit of ['swap','remove','late-job-repair'])test('committed extraction preserves later '+edit,async()=>{
 const ws=workspace();
 const created=await child(ws,'original',setup+(edit==='late-job-repair'?String.raw`
 await e.executeExtractionOperation(op.id,undefined,undefined,{onCheckpoint(phase){if(phase==='main_track_committed'){save();process.exit(79);}}});throw Error('commit failpoint missing');
 `:String.raw`q.startQueue();await q.waitForQueueIdle();assert.equal(ops.readOperation(op.id).state,'succeeded');save();`));
 expect(created.code,created.stderr+' '+ws).toBe(edit==='late-job-repair'?79:0);
 for(let recovery=1;recovery<=2;recovery++){
  const result=await child(ws,'replay-'+recovery,resume+String.raw`
 const edit=`+JSON.stringify(edit)+String.raw`,iteration=`+recovery+String.raw`;
 const before=ops.readOperation(saved.id),cells=before.checkpoint.cells;assert.deepEqual(before,saved.op);assert.equal(before.result.frame_count,3);
 const jobId=before.attempt_job_ids[0];assert.equal(before.attempt_job_ids.length,1);
 if(iteration===1){
  if(edit==='late-job-repair'){const job=db.query('SELECT status,result FROM jobs WHERE id=?').get(jobId);assert.notEqual(job.status,'done');assert.equal(job.result,null);}
  const timeline=await import('./apps/server/src/timeline');
  if(edit!=='remove')timeline.placeFrame(cells[0].frameId,saved.clip.track_id,cells[1].stepId,true,false);
  if(edit!=='swap')timeline.deleteFrameCell(cells[2].frameId);
 }
 const projection=()=>({frames:db.query('SELECT * FROM frames WHERE project_id=? ORDER BY id').all(saved.project),steps:db.query('SELECT * FROM animation_steps WHERE axis_id=? ORDER BY id').all(saved.clip.axis_id)});
 const edited=projection();assert.equal(edited.frames.length,edit==='swap'?3:2);
 if(edit!=='remove')assert.equal(edited.frames.find(x=>x.id===cells[0].frameId).step_id,cells[1].stepId);
 if(iteration===1)writeFileSync(join(STORAGE_ROOT,'edited-projection.json'),JSON.stringify(edited));else assert.deepEqual(edited,JSON.parse(readFileSync(join(STORAGE_ROOT,'edited-projection.json'),'utf8')));
 if(edit==='late-job-repair'){await ops.reconcileCollaborationOperations();const repaired=db.query('SELECT status,result FROM jobs WHERE id=?').get(jobId);assert.equal(repaired.status,'done');assert.deepEqual(JSON.parse(repaired.result),before.result);}
 assert.deepEqual(await e.executeExtractionOperation(saved.id),before.result);
 const replayed=await ops.resumeCollaborationOperation(saved.id,actor);assert.deepEqual(replayed.result,before.result);
 await ops.reconcileCollaborationOperations();await q.waitForQueueIdle();
 assert.deepEqual(ops.readOperation(saved.id),before);assert.deepEqual(projection(),edited);
 const job=db.query('SELECT status,result FROM jobs WHERE id=?').get(jobId);assert.equal(job.status,'done');assert.deepEqual(JSON.parse(job.result),before.result);
 assert.equal(db.query('SELECT COUNT(*) n FROM jobs WHERE operation_id=?').get(saved.id).n,1);
 assert.equal(db.query("SELECT COUNT(*) n FROM collab_operations WHERE kind='extract_source' AND state='succeeded'").get().n,1);
 writeFileSync(join(STORAGE_ROOT,'verified-'+iteration+'.json'),JSON.stringify({operation:ops.readOperation(saved.id),job,edited},null,2));
 `);expect(result.code,result.stderr+' '+ws).toBe(0);
 }
},60000);

for(const damage of ['valid-unfinished','missing-frame-id','missing-step-id','changed-source','bad-raw-hash','committed-bad-raw-hash'])test('extraction keeps identity guard '+damage,async()=>{
 const ws=workspace(),committed=damage.startsWith('committed');
 const created=await child(ws,'original',setup+String.raw`
 await e.executeExtractionOperation(op.id,undefined,undefined,{onCheckpoint(phase){if(phase===`+JSON.stringify(committed?'main_track_committed':'gui_copy')+String.raw`){save();process.exit(79);}}});throw Error('failpoint missing');
 `);expect(created.code,created.stderr+' '+ws).toBe(79);
 const result=await child(ws,'guard',resume+String.raw`
 const damage=`+JSON.stringify(damage)+String.raw`,cp=saved.op.checkpoint;
 if(damage.startsWith('missing')){delete cp.cells[0][damage==='missing-frame-id'?'frameId':'stepId'];db.query('UPDATE collab_operations SET checkpoint_json=? WHERE id=?').run(JSON.stringify(cp),saved.id);}
 else if(damage!=='valid-unfinished'){const path=damage==='changed-source'?db.query('SELECT original_path FROM sources WHERE id=?').get(saved.source).original_path:join(STORAGE_ROOT,'sources',saved.source,cp.files[0].file);writeFileSync(path+'.retained',readFileSync(path));writeFileSync(path,'changed bytes');}
 const expected=damage.startsWith('missing')?'RECOVERY_IDENTITY_CONFLICT':damage==='changed-source'?'INPUT_IDENTITY_CONFLICT':'ARTIFACT_INTEGRITY_CONFLICT';
 if(damage.startsWith('committed')){await assert.rejects(()=>ops.resumeCollaborationOperation(saved.id,actor),x=>x.code===expected);assert.deepEqual(ops.readOperation(saved.id),saved.op);}
 else {await ops.resumeCollaborationOperation(saved.id,actor);q.startQueue();await q.waitForQueueIdle();const after=ops.readOperation(saved.id);
  if(damage==='valid-unfinished'){assert.equal(after.state,'succeeded');assert.equal(after.result.frame_count,3);assert.deepEqual(after.checkpoint.cells,cp.cells);assert.deepEqual(after.checkpoint.files,cp.files);assert.equal(after.checkpoint.attempt_id,cp.attempt_id);assert.deepEqual(after.attempt_job_ids.slice(0,-1),saved.op.attempt_job_ids);assert.equal(after.attempt_job_ids.length,2);assert.equal(db.query('SELECT COUNT(*) n FROM frames WHERE project_id=?').get(saved.project).n,3);}
  else {assert.equal(after.state,'needs_input');assert.equal(after.result.error_code,expected);assert.equal(db.query('SELECT COUNT(*) n FROM frames WHERE project_id=?').get(saved.project).n,0);}
 }
 writeFileSync(join(STORAGE_ROOT,'guard-observation.json'),JSON.stringify({expected,operation:ops.readOperation(saved.id)},null,2));
 `);expect(result.code,result.stderr+' '+ws).toBe(0);
},60000);
