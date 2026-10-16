import { expect, test } from "bun:test";
import { runCollaborationScript } from "./collaborationFixtures";
import { setup as collaborationFixture } from "./collaborationTask3Fixture";

// 数据库和真实 REST app 仅在隔离子进程载入；保留工作区作为回归证据。
const fixture = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const { db, STORAGE_ROOT } = await import('./apps/server/src/db');
assert.equal(resolve(STORAGE_ROOT), resolve(process.env.SFS_WORKSPACE));
const { app } = await import('./apps/server/src/app');
const project = 'frame-delete-project', axis = 'delete-axis';
const raw = join(STORAGE_ROOT, 'projects', project, 'raw', 'shared.png');
const processed = join(STORAGE_ROOT, 'projects', project, 'processed', 'shared.png');
const materialRaw = join(STORAGE_ROOT, 'materials', 'original.png');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a82kAAAAASUVORK5CYII=', 'base64');
mkdirSync(join(STORAGE_ROOT, 'projects', project, 'raw'), { recursive: true });
mkdirSync(join(STORAGE_ROOT, 'projects', project, 'processed'), { recursive: true });
for (const path of [raw, processed, materialRaw]) writeFileSync(path, png);
const fileHashes = () => Object.fromEntries([raw, processed, materialRaw].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const originalFiles = fileHashes();
const effect = JSON.stringify({strokes:[{color:'#ff8a18',size:24,brush:'dry',points:[{x:2,y:3,pressure:0.5}]}],offset_x:3,offset_y:-2,scale:1.2,rotation:0.25,opacity:0.7,style:'flame'});
db.query("INSERT INTO projects(id,name,created_at) VALUES(?, '逐帧删除回归',1)").run(project);
db.query("INSERT INTO animation_axes VALUES(?,?,'待检查动作',0,12,1)").run(axis, project);
db.query("INSERT INTO animation_axes VALUES('other-axis',?,'另一个动作',1,8,1)").run(project);
db.query("INSERT INTO animation_tracks VALUES('main',?,'Main',0,1,0,1)").run(axis);
db.query("INSERT INTO animation_tracks VALUES('background',?,'背景',1,1,0,0)").run(axis);
db.exec("INSERT INTO animation_tracks VALUES('other-track','other-axis','Main',0,1,0,1)");
for (const [id, idx, duration] of [['s0',0,2],['s1',1,3],['s2',2,4]]) {
  db.query('INSERT INTO animation_steps VALUES(?,?,?,?)').run(id,axis,idx,duration);
}
db.exec("INSERT INTO animation_steps VALUES('other-step','other-axis',0,1)");
db.query("INSERT INTO materials(id,name,raw_path,status,source,metadata,created_at) VALUES('original-material','原始素材',?,'ready','upload','{}',1)").run(materialRaw);
const insert = db.query('INSERT INTO frames(id,project_id,track_id,step_id,is_asset,idx,raw_path,processed_path,status,duration,is_keyframe,offset_x,offset_y,scale,rotation,opacity,tags,source,metadata,attack_effect) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for (const [id,track,step,isAsset,idx,duration] of [
  ['instance-first','main','s0',0,0,2],
  ['asset-second','main','s1',1,1,3],
  ['instance-third','main','s2',0,2,4],
  ['background-same-step','background','s0',0,0,2],
  ['other-action-frame','other-track','other-step',0,0,1],
  ['source-pool',null,null,1,3,1],
]) {
  insert.run(id,project,track,step,isAsset,idx,raw,processed,'ready',duration,1,12.5,-7.25,1.75,0.35,0.625,'["已人工检查","重复候选"]','upload',JSON.stringify({fromMaterial:'original-material',assetFrameId:'source-pool',review:{note:id}}),effect);
}
db.query("INSERT INTO attack_effects VALUES('retained-effect',?,'main','s0',?,1)").run(project,effect);
db.query("INSERT INTO attack_effects VALUES('other-track-effect',?,'background','s1',?,2)").run(project,effect);

const state = () => ({
  axes: db.query('SELECT * FROM animation_axes ORDER BY id').all(),
  tracks: db.query('SELECT * FROM animation_tracks ORDER BY id').all(),
  steps: db.query('SELECT * FROM animation_steps ORDER BY id').all(),
  frames: db.query('SELECT * FROM frames ORDER BY id').all(),
  effects: db.query('SELECT * FROM attack_effects ORDER BY id').all(),
  materials: db.query("SELECT * FROM materials WHERE id='original-material'").all(),
});
const initial = state();
const historyCount = () => db.query('SELECT COUNT(*) n FROM project_undo WHERE project_id=?').get(project).n;
const request = async (path, method) => {
  const response = await app.handle(new Request('http://localhost/api/' + path, {method}));
  const body = await response.text();
  return {status:response.status,body};
};
const clear = async id => {
  const result = await request('frames/' + id + '/placement','DELETE');
  assert.equal(result.status,200,result.body);
  assert.deepEqual(fileHashes(),originalFiles);
};
const undo = async () => {
  const result = await request('projects/' + project + '/undo','POST');
  assert.equal(result.status,200,result.body);
  assert.deepEqual(fileHashes(),originalFiles);
};
`;

test("删除指定轨道单帧保留其他轨道、步骤、素材文件及独立特效", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
await clear('instance-first');
assert.deepEqual(state(), {...initial,frames:initial.frames.filter(frame => frame.id !== 'instance-first')});
assert.equal(historyCount(),1);
const history = db.query('SELECT files_path FROM project_undo WHERE project_id=?').get(project);
assert.equal(history.files_path,'');
const response = await app.handle(new Request('http://localhost/api/projects/' + project + '/timeline?axisId=' + axis));
assert.equal(response.status,200);
const timeline = await response.json();
assert.deepEqual(timeline.tracks.map(track => track.id),['main','background']);
assert.deepEqual(timeline.steps.map(step => [step.id,step.duration]),[['s0',2],['s1',3],['s2',4]]);
assert.ok(!timeline.frames.some(frame => frame.id === 'instance-first'));
assert.ok(timeline.frames.some(frame => frame.id === 'background-same-step'));
assert.ok(timeline.effects.some(cell => cell.track_id === 'main' && cell.step_id === 's0'));
assert.ok(timeline.assetFrames.some(frame => frame.id === 'source-pool'));
await undo();
assert.deepEqual(state(),initial);
assert.equal(historyCount(),0);
console.log('single-cell removal preserves timeline, sources and effects; exact undo restored');
db.close();
`, "editor-frame-delete");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("exact undo restored");
}, 120000);

test("删除并收紧仅移除刚清空的共享步骤，旧空列保留且可整体撤销", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
db.query("INSERT INTO animation_steps VALUES('existing-hole',?,3,6)").run(axis);
const before = state();
const result = await request('frames/instance-third/placement?removeEmptyStep=true','DELETE');
assert.equal(result.status,200,result.body);
assert.equal(db.query("SELECT id FROM animation_steps WHERE id='s2'").get(),null);
assert.deepEqual(db.query('SELECT id,idx,duration FROM animation_steps WHERE axis_id=? ORDER BY idx').all(axis),[
  {id:'s0',idx:0,duration:2},{id:'s1',idx:1,duration:3},{id:'existing-hole',idx:2,duration:6},
]);
assert.deepEqual(state().frames,before.frames.filter(frame=>frame.id!=='instance-third'));
assert.deepEqual(state().effects,before.effects);
assert.deepEqual(state().tracks,before.tracks);
assert.equal(historyCount(),1);
assert.deepEqual(fileHashes(),originalFiles);
await undo();
assert.deepEqual(state(),before);
console.log('only newly empty step removed and exact undo restored');
db.close();
`, "editor-close-gap");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("only newly empty step removed");
}, 120000);

test("删除并收紧保留其他轨道图片与仅有特效的列，拒绝编辑锁定轨道", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
for (const id of ['instance-first','asset-second']) {
  const result=await request('frames/'+id+'/placement?removeEmptyStep=true','DELETE');
  assert.equal(result.status,200,result.body);
}
assert.deepEqual(state().steps,initial.steps);
assert.deepEqual(state().effects,initial.effects);
assert.ok(state().frames.some(frame=>frame.id==='background-same-step'));
assert.ok(state().frames.some(frame=>frame.id==='asset-second'&&frame.track_id===null&&frame.is_asset===1));
assert.equal(historyCount(),2);
await undo();await undo();assert.deepEqual(state(),initial);
db.exec("UPDATE animation_tracks SET locked=1 WHERE id='main'");
const locked=state();
const rejected=await request('frames/instance-third/placement?removeEmptyStep=true','DELETE');
assert.equal(rejected.status,409,rejected.body);
assert.deepEqual(state(),locked);
assert.equal(historyCount(),0);
// 默认清空沿用旧 API 行为，不额外改变现有调用方的锁定语义。
await clear('instance-third');
assert.ok(db.query("SELECT id FROM animation_steps WHERE id='s2'").get());
await undo();assert.deepEqual(state(),locked);
console.log('other-track image, effect-only column and locked track protected');
db.close();
`, "editor-gap-guards");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("effect-only column and locked track protected");
}, 120000);

test("清理当前动画轴全部空列是一次可撤销操作，保留其他动作与精确时序设置", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
db.query("INSERT INTO animation_steps VALUES('hole-a',?,3,6)").run(axis);
db.query("INSERT INTO animation_steps VALUES('hole-b',?,4,7)").run(axis);
db.exec("INSERT INTO animation_steps VALUES('other-axis-hole','other-axis',1,9)");
db.exec("UPDATE animation_tracks SET locked=1 WHERE id='background'");
const draft={source_id:'retained-original',expected_source_frame_ids:['original:0','original:1','original:2'],timing:{value:{mode:'explicit_durations',durations:[{num:1001,den:30000},{num:1,den:17},{num:1,den:11}]},origin:'user'},durations:{'instance-first':{duration:{num:1001,den:30000},duration_origin:'explicit_durations'},'asset-second':{duration:{num:1,den:17},duration_origin:'explicit_durations'},'instance-third':{duration:{num:1,den:11},duration_origin:'explicit_durations'}}};
db.query('INSERT INTO settings(key,value,updated_at) VALUES(?,?,1)').run('sfs.draft.'+project+'.'+axis,JSON.stringify(draft));
const settings=()=>db.query("SELECT * FROM settings WHERE key LIKE 'sfs.draft.%' ORDER BY key").all();
const before=state(),beforeSettings=settings();
const result=await request('axes/'+axis+'/steps/prune-empty','POST');
assert.equal(result.status,200,result.body);
assert.deepEqual(JSON.parse(result.body),{ok:true,removedStepIds:['hole-a','hole-b']});
assert.deepEqual(state(),{...before,steps:before.steps.filter(step=>!['hole-a','hole-b'].includes(step.id))});
assert.deepEqual(settings(),beforeSettings);
assert.deepEqual(fileHashes(),originalFiles);
assert.equal(historyCount(),1);
assert.equal(db.query('SELECT files_path FROM project_undo WHERE project_id=?').get(project).files_path,'');
await undo();assert.deepEqual(state(),before);assert.deepEqual(settings(),beforeSettings);assert.equal(historyCount(),0);
assert.equal((await request('axes/missing/steps/prune-empty','POST')).status,404);
assert.equal(historyCount(),0);
console.log('axis-only empty-column cleanup restored by one undo; exact timing and originals retained');
db.close();
`, "editor-prune-empty");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("exact timing and originals retained");
}, 120000);

test("删除并收紧保留协作源选择和幸存帧精确时长，撤销恢复原顺序", async () => {
  const result = await runCollaborationScript(collaborationFixture + String.raw`
const exact={value:{mode:'confirmed_fps',fps:{num:30000,den:1001}},origin:'user'};
const imported=await importSeq(files,{timing:exact});
const {app}=await import('./apps/server/src/app');
const before=d.readDraftContent(context),stepRows=()=>db.query('SELECT * FROM animation_steps WHERE axis_id=? ORDER BY idx').all(axis.id),stepsBefore=stepRows();
const deleted=await app.handle(new Request('http://localhost/api/frames/'+imported.frame_ids[0]+'/placement?removeEmptyStep=true',{method:'DELETE'}));
assert.equal(deleted.status,200,await deleted.text());
const after=d.readDraftContent(context);
assert.deepEqual(after.expected_source_frame_ids,before.expected_source_frame_ids);
assert.equal(after.frames.length,1);
assert.equal(after.frames[0].sequence_index,0);
assert.deepEqual(after.frames[0].duration,before.frames[1].duration);
assert.deepEqual(after.frames[0].duration,{num:1001,den:30000});
assert.equal(stepRows().length,1);
const undo=await app.handle(new Request('http://localhost/api/projects/'+project.id+'/undo',{method:'POST'}));
assert.equal(undo.status,200,await undo.text());
assert.deepEqual(stepRows(),stepsBefore);
const restored=d.readDraftContent(context);
assert.deepEqual(restored.frames,before.frames);
assert.deepEqual(restored.expected_source_frame_ids,before.expected_source_frame_ids);
console.log('collaboration exact timing, source expectations and original ordering preserved');
db.close();
`, "t3");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("source expectations and original ordering preserved");
}, 120000);

test("收紧资产帧所在的空列时资产退回素材池，撤销同时恢复资产位置和步骤", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
db.exec("UPDATE frames SET is_asset=1 WHERE id='instance-third'");
const before=state(),asset=before.frames.find(frame=>frame.id==='instance-third');
const result=await request('frames/instance-third/placement?removeEmptyStep=true','DELETE');
assert.equal(result.status,200,result.body);
assert.deepEqual(db.query("SELECT * FROM frames WHERE id='instance-third'").get(),{...asset,track_id:null,step_id:null});
assert.equal(db.query("SELECT id FROM animation_steps WHERE id='s2'").get(),null);
assert.deepEqual(fileHashes(),originalFiles);
await undo();assert.deepEqual(state(),before);
console.log('asset retained in pool; placement and step restored together');
db.close();
`, "editor-prune-asset");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("placement and step restored together");
}, 120000);

test("MCP 收紧单帧与清理空列沿用 REST 语义，清理前部和中间空列后帧号连续", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
const tools=new Map(),server={registerTool:(name,definition,handler)=>tools.set(name,{definition,handler})};
(await import('./apps/server/src/mcp/tools/frames')).register(server);
(await import('./apps/server/src/mcp/tools/timeline')).register(server);
const call=async(name,input)=>{const tool=tools.get(name);assert.ok(tool,name);return tool.handler(tool.definition.inputSchema.parse(input));};
await clear('instance-first');assert.equal(historyCount(),1);
const removed=await call('clear_frame_cell',{frameId:'instance-third',removeEmptyStep:true});
assert.ok(!removed.isError);
assert.equal(db.query("SELECT id FROM animation_steps WHERE id='s2'").get(),null);
assert.equal(historyCount(),0);
assert.deepEqual(state().effects,initial.effects);
db.exec("UPDATE animation_tracks SET locked=1 WHERE id='main'");
const locked=state(),rejected=await call('clear_frame_cell',{frameId:'asset-second',removeEmptyStep:true});
assert.equal(rejected.isError,true);assert.deepEqual(state(),locked);
const compacted=state();
db.query("INSERT INTO animation_steps VALUES('hole-a',?,2,6)").run(axis);
db.query("INSERT INTO animation_steps VALUES('hole-b',?,3,7)").run(axis);
const {reorderSteps}=await import('./apps/server/src/timeline');
reorderSteps(axis,['hole-a','s0','hole-b','s1']);
assert.deepEqual(db.query('SELECT idx FROM frames WHERE track_id IS NOT NULL AND step_id IN(\'s0\',\'s1\') ORDER BY id').all(),[{idx:3},{idx:1}]);
const pruned=await call('prune_empty_steps',{axisId:axis});
assert.ok(!pruned.isError);
assert.deepEqual(JSON.parse(pruned.content[0].text),{ok:true,removedStepIds:['hole-a','hole-b']});
assert.deepEqual(state(),compacted);
assert.deepEqual(fileHashes(),originalFiles);
console.log('MCP removes only safe empty steps; remaining frame indices continuous');
db.close();
`, "editor-mcp-prune");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("remaining frame indices continuous");
}, 120000);

test("连续删除实例与资产后按逆序逐次撤销，完整恢复位置、变换、时长和元数据", async () => {
  const result = await runCollaborationScript(fixture + String.raw`
await clear('instance-first');
const afterFirst = state();
await clear('asset-second');
const afterSecond = state();
const returnedAsset = afterSecond.frames.find(frame => frame.id === 'asset-second');
assert.ok(returnedAsset);
assert.equal(returnedAsset.track_id,null);
assert.equal(returnedAsset.step_id,null);
assert.equal(returnedAsset.is_asset,1);
await clear('instance-third');
const afterThird = state();
assert.equal(afterThird.frames.filter(frame => frame.track_id === 'main').length,0);
assert.deepEqual(afterThird.steps,initial.steps);
assert.deepEqual(afterThird.tracks,initial.tracks);
assert.deepEqual(afterThird.effects,initial.effects);
assert.equal(historyCount(),3);
assert.equal((await request('frames/instance-first/placement','DELETE')).status,404);
assert.equal(historyCount(),3);
await undo();
assert.deepEqual(state(),afterSecond);
assert.equal(historyCount(),2);
await undo();
assert.deepEqual(state(),afterFirst);
assert.equal(historyCount(),1);
await undo();
assert.deepEqual(state(),initial);
assert.equal(historyCount(),0);
assert.equal((await request('projects/' + project + '/undo','POST')).status,404);
assert.deepEqual(state(),initial);
assert.deepEqual(fileHashes(),originalFiles);
console.log('three frame deletions undone in LIFO order; all row fields and source bytes restored');
db.close();
`, "editor-frame-undo");
  expect(result.exit_code, result.stderr + "\n" + result.stdout + "\n" + result.workspace).toBe(0);
  expect(result.stdout).toContain("all row fields and source bytes restored");
}, 120000);
