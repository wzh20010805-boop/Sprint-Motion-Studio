import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';

test('editor discovery preserves legacy, explicit tasks, timing and sticky cancelled context',async()=>{
 const result=await runCollaborationScript(reviewSetup+String.raw`
 const {readActionCollaboration}=await import('./apps/server/src/pipeline/collaboration/editor');
 const {request}=await seedCandidate(4);let state=readActionCollaboration(context);
 assert.equal(state.mode,'collaboration');assert.equal(state.tasks.length,1);assert.equal(state.timing.value.mode,'confirmed_fps');
 const candidate=await c.buildPrivateCandidate(request());await submit(candidate);const old=c.readCandidateManifest(candidate.id);
 const before=old.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png)));
 const started=d.startRework(candidate.task_id,candidate.id,d.readDraftContent(context).token,{request_key:uid()},actor);
 db.query('UPDATE frames SET offset_x=offset_x+1 WHERE id=?').run(old.frames[0].frame_id);
 assert.deepEqual(old.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png))),before);
 const {retimeAxisFps,draftState}=await import('./apps/server/src/pipeline/collaboration/timing');
 d.setOutputTiming(context,{value:{mode:'explicit_durations',durations:old.frames.map(f=>f.duration)},origin:'user'},d.readDraftContent(context).token,{request_key:uid()});
 const times=JSON.stringify(draftState(context).durations);retimeAxisFps(context.axis_id,24);assert.equal(JSON.stringify(draftState(context).durations),times);
 db.query("UPDATE collab_tasks SET state='cancelled' WHERE id=?").run(candidate.task_id);
 state=readActionCollaboration(context);assert.equal(state.mode,'collaboration');assert.equal(state.tasks[0].state,'cancelled');assert.equal(state.timing.value.mode,'explicit_durations');
 const legacy=createProject('unrelated legacy');const {createAnimationAction}=await import('./apps/server/src/timeline');const legacyAxis=createAnimationAction(legacy.id,'legacy',8);
 assert.deepEqual(readActionCollaboration({project_id:legacy.id,axis_id:legacyAxis.axis.id}),{mode:'legacy',tasks:[],timing:null});
 const {resolveActionExport}=await import('./apps/server/src/pipeline/collaboration/delivery');await assert.rejects(resolveActionExport({project_id:legacy.id,axis_id:legacyAxis.axis.id,task_id:candidate.task_id},'sequence'),e=>e.code==='TASK_CONTEXT_MISMATCH');
 db.close();
 `,'t12');expect(result.exit_code,result.stderr+' '+result.workspace).toBe(0);
},120000);

test('typed rework handoff binds successful known task and parent without another operation',async()=>{
 const {draftEditContext}=await import('../../apps/web/src/collaborationEditor');
 const task={id:'task',context:{project_id:'p',axis_id:'a'},state:'reworking'} as any;
 const token={revision:3,hash:'a'.repeat(64)};
 expect(draftEditContext('task','parent',{task,content_token:token})).toEqual({...task.context,task_id:'task',parent_candidate_id:'parent',content_token:token});
 expect(()=>draftEditContext('other','parent',{task,content_token:token})).toThrow();
});

test('Alignment formal routing preserves token-free legacy export and never falls back after resolver failure',async()=>{
 const {routeAlignmentExport}=await import('../../apps/web/src/collaborationEditor');
 const original=globalThis.fetch;const calls:string[]=[];let legacy=0,fixed=0;
 try{
  globalThis.fetch=async(input)=>{calls.push(String(input));expect(String(input)).toContain('/api/v1/export/resolve?');return Response.json({ok:true,data:{mode:'legacy'}});};
  await routeAlignmentExport({project_id:'p',axis_id:'a'},undefined,async()=>{legacy++;},async()=>{fixed++;});
  expect([legacy,fixed]).toEqual([1,0]);
  globalThis.fetch=async()=>Response.json({ok:true,data:{mode:'candidate',candidate_id:'c',delivery_id:'d',files:[{file:'assets.zip',url:'/fixed'}]}});
  await routeAlignmentExport({project_id:'p',axis_id:'a'},'known',async()=>{legacy++;},async()=>{fixed++;});expect([legacy,fixed]).toEqual([1,1]);
  for(const code of [401,409,503]){globalThis.fetch=async()=>Response.json({ok:false,error:{message:'resolver rejected'}},{status:code});await expect(routeAlignmentExport({project_id:'p',axis_id:'a'},'known',async()=>{legacy++;},async()=>{fixed++;})).rejects.toThrow('resolver rejected');}
  globalThis.fetch=async()=>Response.json({ok:true,data:{mode:'ambiguous',task_ids:['one','two']}});await expect(routeAlignmentExport({project_id:'p',axis_id:'a'},undefined,async()=>{legacy++;},async()=>{fixed++;})).rejects.toThrow();expect([legacy,fixed]).toEqual([1,1]);
 }finally{globalThis.fetch=original;}
});

test('known task export disambiguates only its own action and still requires acceptance',async()=>{
 const result=await runCollaborationScript(reviewSetup+String.raw`
 const {task,brief}=await seedCandidate(2);d.createCollaborationTask(brief,{request_key:uid()},actor);
 const {resolveActionExport}=await import('./apps/server/src/pipeline/collaboration/delivery');
 assert.equal((await resolveActionExport(context,'sequence')).mode,'ambiguous');
 await assert.rejects(resolveActionExport({...context,task_id:task.id},'sequence'),e=>e.code==='ACCEPTED_CANDIDATE_REQUIRED');
 await assert.rejects(resolveActionExport({...context,task_id:uid()},'sequence'),e=>e.code==='TASK_CONTEXT_MISMATCH');
 db.close();
 `,'t12');expect(result.exit_code,result.stderr+' '+result.workspace).toBe(0);
},120000);

test('context HTTP and maker adapter require authenticated actor and matching project axis',async()=>{
 const result=await runCollaborationScript(reviewSetup+String.raw`
 const {task}=await seedCandidate(2);const {Elysia}=await import('./apps/server/node_modules/elysia'),{collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');
 const app=new Elysia().use(collaborationApi),url='http://localhost/api/v1/collaboration/action?project_id='+context.project_id+'&axis_id='+context.axis_id;
 assert.equal((await app.handle(new Request(url))).status,401);
 const request=new Request(url,{headers:{Authorization:'Bearer test-maker'}});auth.authenticateLocalRequest(request,'localhost');const response=await app.handle(request);assert.equal(response.status,200);const value=(await response.json()).data;assert.equal(value.tasks[0].id,task.id);assert.equal(value.mode,'collaboration');
 const other=createProject('other');const bad=new Request('http://localhost/api/v1/collaboration/action?project_id='+other.id+'&axis_id='+context.axis_id,{headers:{Authorization:'Bearer test-maker'}});auth.authenticateLocalRequest(bad,'localhost');assert.equal((await app.handle(bad)).status,404);
 const {runMakerTool}=await import('./apps/server/src/mcp/makerTools');await assert.rejects(()=>runMakerTool('inspect_action_collaboration',context,{role:'maker',session_id:'invented'}),e=>e.code==='ROLE_FORBIDDEN');
 const actual=auth.authenticateLocalRequest(new Request('http://localhost/',{headers:{Authorization:'Bearer test-maker'}}),'localhost');assert.deepEqual(await runMakerTool('inspect_action_collaboration',context,actual),value);
 await (await import('./apps/server/src/queue')).waitForQueueIdle();db.close();
 `,'t12');expect(result.exit_code,result.stderr+' '+result.workspace).toBe(0);
},120000);

