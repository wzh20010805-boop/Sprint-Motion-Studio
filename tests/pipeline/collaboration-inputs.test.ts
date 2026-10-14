import {test,expect} from 'bun:test';
import {runCollaborationScript as isolated} from './collaborationFixtures';
import {setup} from './collaborationTask3Fixture';
const runCollaborationScript=(script:string)=>isolated(script,'t3');
test('Task3 inputs', async () => {
  const r = await runCollaborationScript(setup + String.raw`
const before=d.readDraftContent(context).token;
await assert.rejects(()=>importSeq([{name:'a/frame.png',bytes},{name:'b/frame.png',bytes}]));
await assert.rejects(()=>importSeq(files,{ordered_names:['frame2.png']}));
await assert.rejects(()=>importSeq(files,{ordered_names:['frame2.png','unknown.png']}));
await assert.rejects(()=>importSeq(files,{timing:{value:{mode:'source_pts'},origin:'inferred'}}));
assert.deepEqual(d.readDraftContent(context).token,before);
const key=uid(), options={request_key:key,ordered_names:['frame10.png','frame2.png'],timing,base_content:before};
const imported=await importImageSequence(context,files,options);assert.deepEqual(files.map(f=>f.name),['frame10.png','frame2.png']);
assert.deepEqual(await importImageSequence(context,files,options),imported);
const source=getSource(project.id,imported.source_id);assert.equal(source.probe.kind,'png_sequence');assert.deepEqual(source.probe.frames.map(f=>f.original_name),['frame10.png','frame2.png']);assert.ok(source.probe.frames.every(f=>!('pts' in f)));
assert.equal(db.query('SELECT COUNT(*) n FROM source_frames WHERE source_id=?').get(source.id).n,0);
assert.throws(()=>createClip(project.id,source.id,'wrong video'));
await assert.rejects(()=>importSeq(files));assert.equal(d.readDraftContent(context).frames.length,2);
const other=uid();db.query('INSERT INTO animation_axes VALUES(?,?,?,1,8,1)').run(other,project.id,'other');const ot=uid();db.query("INSERT INTO animation_tracks VALUES(?,?,'Main',0,1,0,1)").run(ot,other);const c={project_id:project.id,axis_id:other};
const natural=await importImageSequence(c,files,{request_key:uid(),timing,base_content:d.readDraftContent(c).token});assert.deepEqual(getSource(project.id,natural.source_id).probe.frames.map(f=>f.original_name),['frame2.png','frame10.png']);
console.log('inputs ok');
`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);

test('Task3 scoped matting completion and resume', async () => {
  const r = await runCollaborationScript(setup + String.raw`

const imp=await importSeq(files);const brief={goal:{value:'保留全部帧的测试动作',origin:'user'},context,source_id:imp.source_id,ordered_source_frame_ids:getSource(project.id,imp.source_id).probe.frames.map(f=>f.source_frame_id),subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'preset'},timing,loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence']},origin:'preset'}};const task=d.createCollaborationTask(brief,{request_key:uid()},actor);
const {createSceneMattingJob,getPersistedJob,cancelJob,resumeJob}=await import('./apps/server/src/queue');const {prepareMatte}=await import('./apps/server/src/pipeline/masks');
const wait=async id=>{for(let i=0;i<1500;i++){const j=getPersistedJob(id);if(!['queued','running'].includes(j.status))return j;await Bun.sleep(20);}throw Error('timeout');};
const collab={project_id:project.id,frame_ids:imp.frame_ids,collaboration:{task_id:task.id,axis_id:axis.id}};
const id=createSceneMattingJob(collab);const j=await wait(id);assert.equal(j.status,'done',JSON.stringify(j));assert.equal(j.requires_user_action,0);assert.equal(j.payload.sceneMatting.completion_policy,'collaboration');assert.ok(imp.frame_ids.every(id=>!maskState(id).reviewed));
const other=uid(),ot=uid(),step=uid(),frame=uid();db.query('INSERT INTO animation_axes VALUES(?,?,?,1,8,1)').run(other,project.id,'legacy');db.query("INSERT INTO animation_tracks VALUES(?,?,'Main',0,1,0,1)").run(ot,other);db.query('INSERT INTO animation_steps VALUES(?,?,0,1)').run(step,other);db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,status) VALUES(?,?,?,?,0,?,'ready')").run(frame,project.id,ot,step,path);
assert.throws(()=>prepareMatte({...collab,frame_ids:[frame]}));assert.throws(()=>prepareMatte({...collab,collaboration:{task_id:task.id,axis_id:other}}));assert.equal(prepareMatte({project_id:project.id,frame_ids:[frame],completion_policy:'collaboration'}).completion_policy,'legacy');
const old=await wait(createSceneMattingJob({project_id:project.id,frame_ids:[frame]}));assert.equal(old.status,'waiting_user');assert.equal(old.requires_user_action,1);assert.equal(maskState(frame).reviewed,false);
const interrupted=createSceneMattingJob(collab);cancelJob(interrupted);await wait(interrupted);await assert.rejects(resumeJob(interrupted),e=>e.code==='RECOVERY_UNSUPPORTED');assert.ok(imp.frame_ids.every(id=>!maskState(id).reviewed));console.log('verified collab context and legacy waiting_user/resume ok');

`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);


test('Task3 PNG import invalidates old/pending snapshots only after successful commit', async () => {
 const r=await runCollaborationScript(setup+String.raw`
 const {beginProjectUndo,finishProjectUndo,undoProject}=await import('./apps/server/src/undo');
 const edit=async()=>{const r=new Request('http://localhost/api/axes/'+axis.id,{method:'PATCH'});await beginProjectUndo(r,{name:'renamed'});db.query('UPDATE animation_axes SET name=? WHERE id=?').run('renamed',axis.id);finishProjectUndo(r,true);};
 await edit();const opts={request_key:uid(),timing,base_content:d.readDraftContent(context).token};const imported=await importImageSequence(context,files,opts);assert.equal(await undoProject(project.id),false);assert.equal(d.readDraftContent(context).frames.length,2);
 await edit();assert.deepEqual(await importImageSequence(context,files,opts),imported);assert.equal(await undoProject(project.id),true);assert.equal(d.readDraftContent(context).frames.length,2);
 await edit();await assert.rejects(()=>importSeq(files));assert.equal(await undoProject(project.id),true);
 const other=uid(),ot=uid();db.query('INSERT INTO animation_axes VALUES(?,?,?,1,8,1)').run(other,project.id,'target');db.query("INSERT INTO animation_tracks VALUES(?,?,'Main',0,1,0,1)").run(ot,other);const nc={project_id:project.id,axis_id:other};
 const pending=new Request('http://localhost/api/axes/'+axis.id,{method:'PATCH'});await beginProjectUndo(pending,{name:'pending'});await importImageSequence(nc,files,{request_key:uid(),timing,base_content:d.readDraftContent(nc).token});finishProjectUndo(pending,true);assert.equal(await undoProject(project.id),false);assert.equal(d.readDraftContent(context).frames.length,2);assert.equal(d.readDraftContent(nc).frames.length,2);
 console.log('PNG import postcommit generation and failed/retried preservation verified');
 `);expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
