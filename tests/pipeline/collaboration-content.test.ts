import {test,expect} from 'bun:test';
import {runCollaborationScript as isolated} from './collaborationFixtures';
import {setup} from './collaborationTask3Fixture';
const runCollaborationScript=(script:string)=>isolated(script,'t3');
test('Task3 content', async () => {
  const r = await runCollaborationScript(setup + String.raw`
const imp=await importSeq(files);const {saveAlignment}=await import('./apps/server/src/pipeline/alignment');saveAlignment(project.id,axis.id,config,getProject(project.id).revision);
let before=d.readDraftContent(context);const s=maskState(imp.frame_ids[0]);reviewMask(imp.frame_ids[0],s.version_id,s.revision);assert.deepEqual(d.readDraftContent(context).token,before.token);
writeFileSync(before.frames[0].rgba_path,Buffer.concat([readFileSync(before.frames[0].rgba_path),Buffer.from('byte edit')]));let after=d.readDraftContent(context);assert.notEqual(after.token.hash,before.token.hash);assert.ok(after.token.revision>before.token.revision);
before=after;db.query('UPDATE frames SET offset_x=2 WHERE id=?').run(imp.frame_ids[0]);after=d.readDraftContent(context);assert.notEqual(after.token.hash,before.token.hash);
before=after;db.query('UPDATE projects SET revision=revision+1 WHERE id=?').run(project.id);assert.deepEqual(d.readDraftContent(context).token,before.token);
const canonical=getSource(project.id,imp.source_id).probe.frames[0].canonical_path;writeFileSync(canonical,Buffer.concat([readFileSync(canonical),Buffer.from('source edit')]));assert.notEqual(d.readDraftContent(context).token.hash,before.token.hash);
console.log('content ok');
`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);

test('Task3 empty draft shape, bound HTTP actor and shared preset', async () => {
  const r = await runCollaborationScript(setup + String.raw`

const {Ajv}=await import('ajv');const {draftContentSchema}=await import('./packages/shared/src/pipeline/collaborationSchemas');assert.equal(new Ajv({strict:true}).compile(draftContentSchema)(d.readDraftContent(context)),true);
const imp=await importSeq(files);const {initializeLocalSessions,authenticateLocalRequest}=await import('./apps/server/src/localSessions');initializeLocalSessions('fixture','maker-secret');const {app}=await import('./apps/server/src/app');
const req=new Request('http://localhost/api/v1/collaboration/draft?project_id='+project.id+'&axis_id='+axis.id);assert.equal((await app.handle(req)).status,401);
const authenticated=new Request(req,{headers:{Authorization:'Bearer maker-secret'}});authenticateLocalRequest(authenticated,'localhost');const response=await app.handle(authenticated);assert.equal(response.status,200);assert.deepEqual((await response.json()).data.context,context);
const {saveAlignment}=await import('./apps/server/src/pipeline/alignment');saveAlignment(project.id,axis.id,config,getProject(project.id).revision);const first=d.readDraftContent(context);
const other=uid(),otherTrack=uid(),otherStep=uid();db.query('INSERT INTO animation_axes VALUES(?,?,?,1,8,1)').run(other,project.id,'other');db.query("INSERT INTO animation_tracks VALUES(?,?,'Main',0,1,0,1)").run(otherTrack,other);db.query('INSERT INTO animation_steps VALUES(?,?,0,1)').run(otherStep,other);db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,status) VALUES(?,?,?,?,0,?,'ready')").run(uid(),project.id,otherTrack,otherStep,path);
saveAlignment(project.id,other,{...config,scale:1.5},getProject(project.id).revision);const after=d.readDraftContent(context);assert.equal(after.alignment.scale,1.5);assert.notEqual(after.token.hash,first.token.hash);assert.deepEqual(after.alignment.roots,config.roots);
console.log('schema/auth/shared-preset ok');

`);
  expect(r.exit_code, r.stderr + ' ' + r.workspace).toBe(0);
}, 120000);


test('Task3 brief public alignment follows the shared preset contract', async () => {
 const r=await runCollaborationScript(setup+String.raw`
 const imp=await importSeq(files);
 const brief={goal:{value:'保留全部帧的测试动作',origin:'user'},context,source_id:imp.source_id,ordered_source_frame_ids:getSource(project.id,imp.source_id).probe.frames.map(f=>f.source_frame_id),subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'user'},timing,loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence']},origin:'preset'}};
 const {saveAlignment,alignmentState}=await import('./apps/server/src/pipeline/alignment');
 saveAlignment(project.id,axis.id,config,getProject(project.id).revision);d.readDraftContent(context);
 const other=uid(),ot=uid(),os=uid();db.query('INSERT INTO animation_axes VALUES(?,?,?,1,8,1)').run(other,project.id,'other');db.query("INSERT INTO animation_tracks VALUES(?,?,'Main',0,1,0,1)").run(ot,other);db.query('INSERT INTO animation_steps VALUES(?,?,0,1)').run(os,other);db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,status) VALUES(?,?,?,?,0,?,'ready')").run(uid(),project.id,ot,os,path);
 saveAlignment(project.id,other,{...config,roots:[{index:0,x:22,y:44}],offsets:{0:[1,2]}},getProject(project.id).revision);d.readDraftContent(context);
 const before={settings:db.query('SELECT * FROM settings ORDER BY key').all(),tasks:db.query('SELECT * FROM collab_tasks').all(),modes:db.query('SELECT * FROM axis_workflow_modes').all(),ops:db.query('SELECT * FROM collab_operations ORDER BY id').all(),other:alignmentState(project.id,other).config,revision:getProject(project.id).revision};
 const key=uid();assert.throws(()=>d.createCollaborationTask({...brief,alignment:{value:{...config,scale:2},origin:'user'}},{request_key:key},actor),e=>e.code==='ALIGNMENT_PRESET_CONFLICT');
 for(const conflict of [{...config,canvas:{width:64,height:32}},{...config,anchor:[17,30]},{...config,resampling:'cartoon'}])assert.throws(()=>d.createCollaborationTask({...brief,alignment:{value:conflict,origin:'user'}},{request_key:uid()},actor),e=>e.code==='ALIGNMENT_PRESET_CONFLICT');
 assert.deepEqual(db.query('SELECT * FROM settings ORDER BY key').all(),before.settings);assert.deepEqual(db.query('SELECT * FROM collab_tasks').all(),before.tasks);assert.deepEqual(db.query('SELECT * FROM axis_workflow_modes').all(),before.modes);assert.deepEqual(db.query('SELECT * FROM collab_operations ORDER BY id').all(),before.ops);assert.deepEqual(alignmentState(project.id,other).config,before.other);assert.equal(getProject(project.id).revision,before.revision);
 const matching=d.createCollaborationTask({...brief,alignment:{value:{...config,roots:[{index:0,x:7,y:9}],offsets:{0:[2,3]}},origin:'user'}},{request_key:uid()},actor);assert.deepEqual(d.readDraftContent(context).alignment.roots,[{index:0,x:7,y:9}]);assert.deepEqual(alignmentState(project.id,other).config,before.other);
 const noPreset=createProject('new shared preset'),defaults=ensureDefaultTimeline(noPreset.id),nc={project_id:noPreset.id,axis_id:defaults.axis.id};
 const fresh=await importImageSequence(nc,files,{request_key:uid(),timing,base_content:d.readDraftContent(nc).token});const nb={...brief,context:nc,source_id:fresh.source_id,ordered_source_frame_ids:getSource(noPreset.id,fresh.source_id).probe.frames.map(f=>f.source_frame_id),alignment:{value:{...config,scale:2},origin:'user'}};const request={request_key:uid()};const task=d.createCollaborationTask(nb,request,actor);
 const preset=JSON.parse(db.query('SELECT value FROM settings WHERE key=?').get('sfs.preset.'+noPreset.id).value);assert.deepEqual(preset,{canvas:config.canvas,anchor:config.anchor,scale:2,resampling:config.resampling});assert.equal(d.readDraftContent(nc).alignment.scale,2);
 saveAlignment(noPreset.id,defaults.axis.id,{...config,scale:3},getProject(noPreset.id).revision);d.createCollaborationTask(nb,request,actor);assert.equal(d.readDraftContent(nc).alignment.scale,3);assert.equal(JSON.parse(db.query('SELECT brief_json FROM task_briefs WHERE task_id=?').get(task.id).brief_json).alignment.value.scale,2);
 console.log('shared preset rejection/init/local roots/idempotent retry verified');
 `);expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
