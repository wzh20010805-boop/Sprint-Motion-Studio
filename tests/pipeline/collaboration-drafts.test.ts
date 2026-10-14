import {test,expect} from 'bun:test';
import {runCollaborationScript as isolated} from './collaborationFixtures';
import {setup} from './collaborationTask3Fixture';
const runCollaborationScript=(script:string)=>isolated(script,'t3');
test('Task3 drafts', async () => {
  const r = await runCollaborationScript(setup + String.raw`
const imp=await importSeq(files);
const brief={goal:{value:'保留全部帧的测试动作',origin:'user'},context,source_id:imp.source_id,ordered_source_frame_ids:getSource(project.id,imp.source_id).probe.frames.map(f=>f.source_frame_id),subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'preset'},timing,loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence']},origin:'preset'}};
const req={request_key:uid()},task=d.createCollaborationTask(brief,req,actor);assert.deepEqual(d.createCollaborationTask(brief,req,actor),task);
assert.throws(()=>d.createCollaborationTask({...brief,ordered_source_frame_ids:[brief.ordered_source_frame_ids[0],brief.ordered_source_frame_ids[0]]},{request_key:uid()},actor));
assert.throws(()=>d.createCollaborationTask({...brief,ordered_source_frame_ids:['unknown']},{request_key:uid()},actor));
const snapshot=d.readDraftContent(context);assert.equal(snapshot.frames[0].duration_origin,'confirmed_fps');
const newTiming={value:{mode:'explicit_durations',durations:[{num:1,den:12},{num:1,den:24}]},origin:'user'};
d.setOutputTiming(context,newTiming,snapshot.token,{request_key:uid()});let content=d.readDraftContent(context);assert.deepEqual(content.frames.map(f=>f.duration),newTiming.value.durations);
const steps=db.query('SELECT id FROM animation_steps WHERE axis_id=? ORDER BY idx').all(axis.id);reorderSteps(axis.id,steps.map(s=>s.id).reverse());assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),newTiming.value.durations.slice().reverse());
d.setAxisFps(axis.id,24);assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),newTiming.value.durations.slice().reverse());
setStepDuration(steps[0].id,3);assert.deepEqual(d.readDraftContent(context).frames.find(f=>f.frame_id===content.frames[0].frame_id).duration,{num:1,den:8});
d.setOutputTiming(context,timing,d.readDraftContent(context).token,{request_key:uid()});d.setAxisFps(axis.id,24);assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),[{num:1,den:24},{num:1,den:24}]);
const expected=d.readDraftContent(context).expected_source_frame_ids;db.query('DELETE FROM frames WHERE id=?').run(imp.frame_ids[0]);assert.deepEqual(d.readDraftContent(context).expected_source_frame_ids,expected);assert.equal(d.readDraftContent(context).frames.length,1);assert.throws(()=>d.setOutputTiming(context,{value:{mode:'explicit_durations',durations:[{num:1,den:12}]},origin:'user'},d.readDraftContent(context).token,{request_key:uid()}));console.log('drafts ok');
`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);

test('Task3 video source timing and frame PATCH', async () => {
  const r = await runCollaborationScript(setup + String.raw`

const {importVideo,extractSource,prepareSourceExtraction}=await import('./apps/server/src/pipeline/service');
const video=createProject('video rational');const src=await importVideo(video.id,'docs/media/sfs/source-run.mp4');const clip=createClip(video.id,src.id,'run');await extractSource(prepareSourceExtraction(video.id,clip.id));const vc={project_id:video.id,axis_id:clip.axis_id};
const before=d.readDraftContent(vc),sourceBefore=db.query('SELECT timing_json FROM source_frames WHERE source_id=? ORDER BY source_index').all(src.id);assert.ok(before.frames.length>2);
const b={goal:{value:'保留源视频全部帧及原始时长',origin:'user'},context:vc,source_id:src.id,ordered_source_frame_ids:before.expected_source_frame_ids,subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'inferred'},timing:{value:{mode:'source_pts'},origin:'inferred'},loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence']},origin:'preset'}};
d.createCollaborationTask(b,{request_key:uid()},actor);
const original=d.readDraftContent(vc);d.setAxisFps(clip.axis_id,48);assert.deepEqual(d.readDraftContent(vc).frames.map(f=>f.duration),original.frames.map(f=>f.duration));
const durations=original.frames.map((f,i)=>i===0?{num:1,den:12}:i===1?{num:1,den:24}:f.duration);
d.setOutputTiming(vc,{value:{mode:'explicit_durations',durations},origin:'user'},d.readDraftContent(vc).token,{request_key:uid()});assert.deepEqual(d.readDraftContent(vc).frames.slice(0,2).map(f=>f.duration),[{num:1,den:12},{num:1,den:24}]);assert.deepEqual(db.query('SELECT timing_json FROM source_frames WHERE source_id=? ORDER BY source_index').all(src.id),sourceBefore);
const {app}=await import('./apps/server/src/app');const f=original.frames[0];const r=await app.handle(new Request('http://localhost/api/frames/'+f.frame_id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({duration:3})}));assert.equal(r.status,200);assert.deepEqual(d.readDraftContent(vc).frames[0].duration,{num:1,den:16});
const state=d.readDraftContent(vc);d.setOutputTiming(vc,{value:{mode:'source_pts'},origin:'inferred'},state.token,{request_key:uid()});assert.deepEqual(d.readDraftContent(vc).frames.map(f=>f.duration),original.frames.map(f=>f.duration));
assert.throws(()=>d.setOutputTiming(vc,{value:{mode:'confirmed_fps',fps:{num:NaN,den:1}},origin:'user'},state.token,{request_key:uid()}));
console.log(JSON.stringify({source_frame_count:original.frames.length,explicit_first_two:durations.slice(0,2),source_timing_preserved:true}));

`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);

test('Task3 rational FPS manual ticks remain exact', async () => {
  const r = await runCollaborationScript(setup + String.raw`

const rt={value:{mode:'confirmed_fps',fps:{num:30000,den:1001}},origin:'user'};await importSeq(files,{timing:rt});assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1001,den:30000});const step=db.query('SELECT id FROM animation_steps WHERE axis_id=? ORDER BY idx').get(axis.id);setStepDuration(step.id,2);assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1001,den:15000});setStepDuration(step.id,3);assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1001,den:10000});d.setAxisFps(axis.id,29.5);setStepDuration(step.id,2);assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:4,den:59});console.log('fractional fps exact');

`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);

test('Task3 rework binds immutable task parent and base', async () => {
  const r = await runCollaborationScript(setup + String.raw`

const imp=await importSeq(files);const brief={goal:{value:'保留全部帧的测试动作',origin:'user'},context,source_id:imp.source_id,ordered_source_frame_ids:getSource(project.id,imp.source_id).probe.frames.map(f=>f.source_frame_id),subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'preset'},timing,loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence']},origin:'preset'}};const task=d.createCollaborationTask(brief,{request_key:uid()},actor);
const parent=uid(),hash='a'.repeat(64),manifest='{\"fixed\":true}';db.query('INSERT INTO candidates(id,task_id,brief_version,content_revision,content_token_hash,content_hash,playback_hash,compositor_hash,manifest_path,manifest_sha256,manifest_json,created_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,1)').run(parent,task.id,task.content_token.revision,hash,hash,hash,hash,'retained-parent.json',hash,manifest);
const base=d.readDraftContent(context).token,request={request_key:uid()};const result=d.startRework(task.id,parent,base,request,actor);assert.equal(result.task.state,'reworking');assert.equal(result.task.acceptance_epoch,task.acceptance_epoch+1);assert.deepEqual(d.startRework(task.id,parent,base,request,actor),result);assert.equal(db.query('SELECT manifest_json FROM candidates WHERE id=?').get(parent).manifest_json,manifest);assert.equal(db.query('SELECT COUNT(*) n FROM task_briefs WHERE task_id=?').get(task.id).n,1);assert.throws(()=>d.startRework(task.id,'missing',base,{request_key:uid()},actor));assert.throws(()=>d.startRework(task.id,parent,{revision:999,hash},{request_key:uid()},actor));console.log('rework parent immutable and idempotent');

`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);


test('Task3 undo restores exact draft timing with editor rows', async () => {
 const r=await runCollaborationScript(setup+String.raw`
 const rt={value:{mode:'confirmed_fps',fps:{num:30000,den:1001}},origin:'user'};
 const imp=await importSeq(files,{timing:rt});const {app}=await import('./apps/server/src/app');const {undoProject}=await import('./apps/server/src/undo');
 const patch=async(path,body)=>{const r=await app.handle(new Request('http://localhost/api/'+path,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));assert.equal(r.status,200,await r.text());};
 const initial=d.readDraftContent(context),first=imp.frame_ids[0];
 await patch('frames/'+first,{duration:2});assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1001,den:15000});assert.equal(await undoProject(project.id),true);assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),initial.frames.map(f=>f.duration));
 // 重新应用同一编辑仍使用当前精确FPS，没有新增redo入口。
 await patch('frames/'+first,{duration:2});assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1001,den:15000});assert.equal(await undoProject(project.id),true);
 await patch('axes/'+axis.id,{fps:24});assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),[{num:1,den:24},{num:1,den:24}]);assert.equal(await undoProject(project.id),true);assert.deepEqual(d.readDraftContent(context).frames.map(f=>f.duration),initial.frames.map(f=>f.duration));
 const state=d.readDraftContent(context);assert.ok(state.token.revision>initial.token.revision);
 // 旧快照没有新字段时不能清空后来的协作源选择。
 const item=uid(),tables={animation_axes:db.query('SELECT * FROM animation_axes WHERE project_id=?').all(project.id),animation_tracks:db.query('SELECT * FROM animation_tracks WHERE axis_id=?').all(axis.id),animation_steps:db.query('SELECT * FROM animation_steps WHERE axis_id=?').all(axis.id),frames:db.query('SELECT * FROM frames WHERE project_id=?').all(project.id),attack_effects:[]};
 db.query('INSERT INTO project_undo(id,project_id,snapshot,files_path,created_at) VALUES(?,?,?,?,?)').run(item,project.id,JSON.stringify(tables),'',Date.now()+1000);assert.equal(await undoProject(project.id),true);assert.deepEqual(d.readDraftContent(context).expected_source_frame_ids,state.expected_source_frame_ids);
 console.log('undo exact timing and old snapshot compatibility');
 `);expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);


test('Task3 committed production timing/task mutations invalidate older editor generations', async () => {
 const r=await runCollaborationScript(setup+String.raw`
 const imp=await importSeq(files);const brief={goal:{value:'保留全部帧的测试动作',origin:'user'},context,source_id:imp.source_id,ordered_source_frame_ids:getSource(project.id,imp.source_id).probe.frames.map(f=>f.source_frame_id),subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'user'},timing,loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence']},origin:'preset'}};
 const {beginProjectUndo,finishProjectUndo,undoProject}=await import('./apps/server/src/undo');
 const edit=async()=>{const r=new Request('http://localhost/api/frames/'+imp.frame_ids[0],{method:'PATCH'});await beginProjectUndo(r,{offset_x:4});db.query('UPDATE frames SET offset_x=offset_x+1 WHERE id=?').run(imp.frame_ids[0]);finishProjectUndo(r,true);};
 await edit();assert.equal(db.query('SELECT COUNT(*) n FROM project_undo WHERE project_id=?').get(project.id).n,1);
 const b=d.readDraftContent(context).token,request={request_key:uid()},next={value:{mode:'explicit_durations',durations:[{num:1,den:24},{num:1,den:24}]},origin:'user'};const updated=d.setOutputTiming(context,next,b,request);
 assert.equal(await undoProject(project.id),false);assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1,den:24});
 await edit();d.setOutputTiming(context,next,b,request);assert.equal(await undoProject(project.id),true);assert.deepEqual(d.readDraftContent(context).frames[0].duration,{num:1,den:24});
 await edit();assert.throws(()=>d.setOutputTiming(context,next,{revision:999,hash:'a'.repeat(64)},{request_key:uid()}));assert.equal(await undoProject(project.id),true);
 const pending=new Request('http://localhost/api/frames/'+imp.frame_ids[0],{method:'PATCH'});await beginProjectUndo(pending,{offset_x:4});
 d.setOutputTiming(context,timing,d.readDraftContent(context).token,{request_key:uid()});finishProjectUndo(pending,true);assert.equal(await undoProject(project.id),false);
 await edit();const taskRequest={request_key:uid()};d.createCollaborationTask(brief,taskRequest,actor);assert.equal(await undoProject(project.id),false);
 await edit();d.createCollaborationTask(brief,taskRequest,actor);assert.equal(await undoProject(project.id),true);
 await edit();assert.throws(()=>d.createCollaborationTask({...brief,alignment:{value:{...config,scale:2},origin:'user'}},{request_key:uid()},actor));assert.equal(await undoProject(project.id),true);
 const taskPending=new Request('http://localhost/api/frames/'+imp.frame_ids[0],{method:'PATCH'});await beginProjectUndo(taskPending,{offset_x:9});d.createCollaborationTask(brief,{request_key:uid()},actor);finishProjectUndo(taskPending,true);assert.equal(await undoProject(project.id),false);
 console.log('production timing/task postcommit generation, retry/failure history verified');
 `);expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
