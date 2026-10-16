import { expect, test } from "bun:test";
import { runCollaborationScript } from "./collaborationFixtures";
import { setup as collaborationFixture } from "./collaborationTask3Fixture";

const fixture = String.raw`
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const {db,STORAGE_ROOT}=await import('./apps/server/src/db');
assert.equal(resolve(STORAGE_ROOT),resolve(process.env.SFS_WORKSPACE));
const {app}=await import('./apps/server/src/app');
const project='insert-project',axis='insert-axis',track='main';
const image=join(STORAGE_ROOT,'projects',project,'raw','retained.png');
mkdirSync(join(STORAGE_ROOT,'projects',project,'raw'),{recursive:true});writeFileSync(image,'retained-original-frame-bytes');
const hash=()=>createHash('sha256').update(readFileSync(image)).digest('hex'),originalHash=hash();
db.query("INSERT INTO projects(id,name,created_at) VALUES(?,'单轨插入回归',1)").run(project);
db.query("INSERT INTO animation_axes VALUES(?,?,'待编排',0,12,1)").run(axis,project);
db.query("INSERT INTO animation_axes VALUES('other-axis',?,'其他动作',1,8,1)").run(project);
db.query("INSERT INTO animation_tracks VALUES('main',?,'Main',0,1,0,1)").run(axis);
db.query("INSERT INTO animation_tracks VALUES('background',?,'背景',1,1,1,0)").run(axis);
db.exec("INSERT INTO animation_tracks VALUES('other-track','other-axis','Main',0,1,0,1)");
for(let i=0;i<6;i++)db.query('INSERT INTO animation_steps VALUES(?,?,?,?)').run('s'+i,axis,i,i+1);
db.exec("INSERT INTO animation_steps VALUES('other-step','other-axis',0,1)");
const insertFrame=db.query('INSERT INTO frames(id,project_id,track_id,step_id,is_asset,idx,raw_path,processed_path,status,duration,is_keyframe,offset_x,offset_y,scale,rotation,opacity,tags,source,metadata,attack_effect) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const effect=JSON.stringify({strokes:[],offset_x:4,offset_y:-3,scale:1.5,rotation:0.25,opacity:0.7,style:'energy'});
for(const [id,trackId,stepId,idx,duration,isAsset] of [
  ['a','main','s0',0,1,0],['b','main','s1',1,2,0],['c','main','s3',3,4,1],['d','main','s4',4,5,0],
  ['bg2','background','s2',2,3,0],['bg4','background','s4',4,5,0],['other-frame','other-track','other-step',0,1,0],['pool',null,null,6,1,1],
])insertFrame.run(id,project,trackId,stepId,isAsset,idx,image,image,'ready',duration,1,12.5,-9.25,1.75,0.375,0.625,'["人工检查"]','extract',JSON.stringify({source_id:'original-source',source_frame_id:'original:'+id,assetFrameId:'pool',note:id}),effect);
for(const [id,trackId,stepId] of [['e0','main','s0'],['e1','main','s1'],['effect-only','main','s2'],['e4','main','s4'],['background-effect','background','s1']]) {
  db.query('INSERT INTO attack_effects VALUES(?,?,?,?,?,?)').run(id,project,trackId,stepId,effect,123);
}
const snapshot=()=>({axes:db.query('SELECT * FROM animation_axes ORDER BY id').all(),tracks:db.query('SELECT * FROM animation_tracks ORDER BY id').all(),steps:db.query('SELECT * FROM animation_steps ORDER BY id').all(),frames:db.query('SELECT * FROM frames ORDER BY id').all(),effects:db.query('SELECT * FROM attack_effects ORDER BY id').all()});
const initial=snapshot(),history=()=>db.query('SELECT COUNT(*) n FROM project_undo WHERE project_id=?').get(project).n;
const request=async(path,method,body)=>{const response=await app.handle(new Request('http://localhost/api/'+path,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined}));const text=await response.text();return{status:response.status,text};};
const move=async(frameId,beforeStepId)=>{const result=await request('tracks/'+track+'/cells/reorder','POST',{frameId,...(beforeStepId===undefined?{}:{beforeStepId})});assert.equal(result.status,200,result.text);assert.equal(hash(),originalHash);return JSON.parse(result.text);};
const undo=async()=>{const result=await request('projects/'+project+'/undo','POST');assert.equal(result.status,200,result.text);assert.equal(hash(),originalHash);};
const expected=order=>{
 const destination=new Map(order.map((old,index)=>[old,'s'+index]));
 return {...initial,frames:initial.frames.map(frame=>frame.track_id==='main'?{...frame,step_id:destination.get(frame.step_id),idx:Number(destination.get(frame.step_id).slice(1)),duration:Number(destination.get(frame.step_id).slice(1))+1}:frame),effects:initial.effects.map(cell=>cell.track_id==='main'?{...cell,step_id:destination.get(cell.step_id)}:cell)};
};
`;

test("单轨前移、后移和追加以完整格插入，图片、特效与空格一起顺移且一次撤销", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
for(const [frameId,beforeStepId,order,affected] of [
 ['b','s5',['s0','s2','s3','s4','s1','s5'],['s1','s2','s3','s4']],
 ['d','s1',['s0','s4','s1','s2','s3','s5'],['s1','s2','s3','s4']],
 ['a',undefined,['s1','s2','s3','s4','s5','s0'],['s0','s1','s2','s3','s4','s5']],
]) {
 const moved=await move(frameId,beforeStepId);
 assert.equal(moved.ok,true);assert.equal(moved.frame.id,frameId);
 assert.deepEqual(moved.affectedStepIds,affected);
 assert.deepEqual(snapshot(),expected(order));
 assert.equal(moved.frame.step_id,snapshot().frames.find(frame=>frame.id===frameId).step_id);
 assert.equal(history(),1);
 assert.equal(db.query('SELECT files_path FROM project_undo WHERE project_id=?').get(project).files_path,'');
 await undo();assert.deepEqual(snapshot(),initial);assert.equal(history(),0);
}
console.log('insert rotation preserves every cell and source byte; shared timing unchanged; one undo restores');
db.close();
`, "editor-track-insert");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("one undo restores");
}, 120000);

test("同轨插入拒绝锁定、跨轨及跨轴位置，写入中途失败整体回滚且不消耗历史", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
assert.equal((await request('frames/a','PATCH',{offset_x:24})).status,200);
const before=snapshot();assert.equal(history(),1);
for(const [id,body,status] of [
 ['main',{frameId:'missing',beforeStepId:'s0'},404],['missing',{frameId:'b',beforeStepId:'s0'},404],
 ['main',{frameId:'bg2',beforeStepId:'s0'},400],['main',{frameId:'pool',beforeStepId:'s0'},400],
 ['main',{frameId:'b',beforeStepId:'other-step'},400],['main',{frameId:'b',beforeStepId:'missing'},400],
 ['background',{frameId:'bg2',beforeStepId:'s0'},409],
]) {
 const rejected=await request('tracks/'+id+'/cells/reorder','POST',body);
 assert.equal(rejected.status,status,rejected.text);assert.deepEqual(snapshot(),before);assert.equal(history(),1);
}
db.exec("CREATE TRIGGER stop_insert BEFORE UPDATE OF step_id ON frames WHEN NEW.id='c' BEGIN SELECT RAISE(ABORT,'INSERT_MOVE_ABORT'); END");
const failed=await request('tracks/main/cells/reorder','POST',{frameId:'b',beforeStepId:'s5'});
assert.ok(failed.status>=400,failed.text);assert.deepEqual(snapshot(),before);assert.equal(history(),1);assert.equal(hash(),originalHash);
db.exec('DROP TRIGGER stop_insert');
await undo();assert.deepEqual(snapshot(),initial);
console.log('all rejected and interrupted moves are atomic and retain prior undo');
db.close();
`, "editor-track-atomic");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("interrupted moves are atomic");
}, 120000);

test("自身与相邻插入边界不产生撤销空步骤，MCP 与 REST 插入规则一致", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
assert.equal((await request('frames/a','PATCH',{offset_x:24})).status,200);const before=snapshot();
for(const boundary of ['s1','s2']){const result=await move('b',boundary);assert.deepEqual(result.affectedStepIds,[]);assert.deepEqual(snapshot(),before);assert.equal(history(),1);}
const tools=new Map();(await import('./apps/server/src/mcp/tools/timeline')).register({registerTool:(name,definition,handler)=>tools.set(name,{definition,handler})});
const tool=tools.get('reorder_track_cells');assert.ok(tool);
const noChange=await tool.handler(tool.definition.inputSchema.parse({trackId:'main',frameId:'b',beforeStepId:'s2'}));assert.ok(!noChange.isError);assert.equal(history(),1);assert.deepEqual(snapshot(),before);
await undo();assert.deepEqual(snapshot(),initial);
const moved=await tool.handler(tool.definition.inputSchema.parse({trackId:'main',frameId:'b',beforeStepId:'s5'}));assert.ok(!moved.isError);assert.deepEqual(snapshot(),expected(['s0','s2','s3','s4','s1','s5']));
assert.equal(JSON.parse(moved.content[0].text).frame.step_id,'s4');
console.log('no-op preserves history; MCP uses identical safe insertion');
db.close();
`, "editor-track-noop");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("MCP uses identical safe insertion");
}, 120000);

test("同轨插入保留稳定帧身份、精确生产时长和期望源集，撤销恢复制作顺序", async () => {
  const result = await runCollaborationScript(collaborationFixture + String.raw`
const exact={value:{mode:'explicit_durations',durations:[{num:1001,den:30000},{num:1,den:17}]},origin:'user'};
await importSeq(files,{timing:exact});
const {app}=await import('./apps/server/src/app');
const {draftState}=await import('./apps/server/src/pipeline/collaboration/timing');
const before=d.readDraftContent(context),stateBefore=draftState(context),steps=()=>db.query('SELECT * FROM animation_steps WHERE axis_id=? ORDER BY idx').all(axis.id),stepsBefore=steps();
assert.notDeepEqual(before.frames[0].duration,before.frames[1].duration);
const moved=await app.handle(new Request('http://localhost/api/tracks/'+track.id+'/cells/reorder',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frameId:before.frames[0].frame_id})}));
assert.equal(moved.status,200,await moved.text());
const after=d.readDraftContent(context);assert.deepEqual(after.frames.map(frame=>frame.frame_id),before.frames.map(frame=>frame.frame_id).reverse());
assert.deepEqual(after.frames.map(frame=>frame.duration),before.frames.map(frame=>frame.duration).reverse());
assert.deepEqual(after.expected_source_frame_ids,before.expected_source_frame_ids);assert.deepEqual(draftState(context),stateBefore);assert.deepEqual(steps(),stepsBefore);
const undone=await app.handle(new Request('http://localhost/api/projects/'+project.id+'/undo',{method:'POST'}));assert.equal(undone.status,200,await undone.text());
assert.deepEqual(d.readDraftContent(context).frames,before.frames);assert.deepEqual(draftState(context),stateBefore);assert.deepEqual(steps(),stepsBefore);
console.log('stable frame rational timing and expected sources preserved through insert and undo');
db.close();
`, "t3");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("rational timing and expected sources preserved");
}, 120000);
