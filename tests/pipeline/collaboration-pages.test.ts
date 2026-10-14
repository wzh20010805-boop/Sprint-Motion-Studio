import {test,expect} from 'bun:test';
import {candidateSetup} from './candidateFixture';
import {runCollaborationScript} from './collaborationFixtures';
test('300 real candidate frames survive complete HTTP and CLI pages; draft and issue cursors bind their own revisions',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const seeded=await seedCandidate(300);const built=await c.buildPrivateCandidate(seeded.request());const check=await checkCandidate(built.id);assert.equal(check.checked_frame_count,300);assert.deepEqual(check.blocking_errors,[]);
 const {listFrames,listCandidateFrames,listReviewIssues,immutableCandidateFile}=await import('./apps/server/src/pipeline/collaboration/pages');
 const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('t10','a'.repeat(64));
 const {Elysia}=await import('./apps/server/node_modules/elysia');const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const app=new Elysia().use(collaborationApi);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const u=new URL(req.url);if(u.pathname==='/api/health')return Response.json({instance_id:'t10',pid:process.pid});auth.authenticateLocalRequest(req,u.host);if(u.pathname==='/api/config')return Response.json({sfs:{production_api_version:'1.2'}});return app.handle(req);}});
 const headers={Authorization:'Bearer '+'a'.repeat(64)};
 const call=async(path,body)=>{const response=await fetch(server.url.origin+'/api/v1/collaboration'+path,{headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 try{
 const draft=await call('/frames?project_id='+project.id+'&axis_id='+axis.id);assert.equal(draft.body.data.items.length,32);assert.equal(draft.body.data.total,300);
 const ids=[];let cursor;do{const result=await call('/candidates/'+built.id+'/frames'+(cursor?'?cursor='+encodeURIComponent(cursor):''));assert.equal(result.status,200);assert.ok(Array.isArray(result.body.data.items));ids.push(...result.body.data.items.map(f=>f.frame_id));cursor=result.body.data.next_cursor;if(!cursor)assert.equal(result.body.data.complete,true);}while(cursor);
 assert.equal(ids.length,300);assert.equal(new Set(ids).size,300);assert.deepEqual(ids,c.readCandidateManifest(built.id).frames.map(f=>f.frame_id));
 const frozen=listCandidateFrames(built.id).next_cursor;db.query('UPDATE frames SET offset_x=1 WHERE id=?').run(ids[0]);assert.throws(()=>listFrames(context,draft.body.data.next_cursor),e=>e.code==='PAGE_CONFLICT');assert.equal(listCandidateFrames(built.id,frozen).items.length,32);
 writeFileSync(join(c.candidateDirectory(built.id),'loose.txt'),'not in manifest');assert.throws(()=>immutableCandidateFile(built.id,'loose.txt'),e=>e.code==='CANDIDATE_FILE_NOT_FOUND');assert.throws(()=>immutableCandidateFile(built.id,'../input.png'));
 const {mkdirSync}=await import('node:fs');mkdirSync(join(process.env.SFS_WORKSPACE,'.sfs'),{recursive:true});writeFileSync(join(process.env.SFS_WORKSPACE,'.sfs/service.json'),JSON.stringify({schema_version:'1.0',instance_id:'t10',pid:process.pid,workspace:process.env.SFS_WORKSPACE,url:server.url.origin,token:'a'.repeat(64)}));
 const cli=Bun.spawn([process.execPath,'apps/cli/src/index.ts','candidate','inspect','--candidate',built.id,'--limit','300','--workspace',process.env.SFS_WORKSPACE],{windowsHide:true,stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([cli.exited,new Response(cli.stdout).text(),new Response(cli.stderr).text()]);writeFileSync(join(process.env.SFS_WORKSPACE,'cli-300.json'),JSON.stringify({code,out,err}));assert.equal(code,0,err);assert.equal(JSON.parse(out).data.items.length,300);
 const inspector=await call('/candidates/'+built.id);assert.equal(inspector.body.data.manifest.frames.length,300);
 const {getCandidateSamplingPlan,recordSampleObservations}=await import('./apps/server/src/pipeline/collaboration/samplingStore');const makerReq=new Request(server.url.origin,{headers});const makerActor=auth.authenticateLocalRequest(makerReq,new URL(makerReq.url).host);const plan=getCandidateSamplingPlan(built.id,makerActor,1);recordSampleObservations(built.id,plan.plan_hash,plan.samples.map(s=>({candidate_id:built.id,content_hash:built.content_hash,plan_hash:plan.plan_hash,frame_id:s.frame_id,frame_content_hash:s.frame_content_hash,viewed:false,result:'uncertain',explanation:'未查看；此测试只验证分页',evidence_source:'none',evidence_candidate_id:built.id})),makerActor);
 // review state can change while the frozen pixel page remains valid.
 const before=listReviewIssues(built.id);assert.equal(before.review_revision,0);assert.equal(before.complete,true);c.submitCandidate(built.id,built.content_hash,makerActor);
 const reviewerSecret=auth.issueReviewerSession('t10');const reviewRequest=new Request(server.url.origin,{headers:{cookie:'sfs_reviewer='+reviewerSecret}}),reviewActor=auth.authenticateLocalRequest(reviewRequest,new URL(reviewRequest.url).host);const reviews=await import('./apps/server/src/pipeline/collaboration/reviews');
 for(let i=0;i<35;i++)reviews.applyIssue({task_id:seeded.task.id,candidate_id:built.id,base_review_revision:reviews.readReviewState(built.id).review_revision,request_key:uid()},{frame_ids:[ids[i]],rect:null,coordinate_system:'final_canvas_pixels',text:'分页测试问题 '+i,severity:'advisory'},reviewActor);
 const issuePage=listReviewIssues(built.id);assert.equal(issuePage.items.length,32);assert.equal(issuePage.total,35);assert.equal(listReviewIssues(built.id,issuePage.next_cursor).items.length,3);
 reviews.applyIssue({task_id:seeded.task.id,candidate_id:built.id,base_review_revision:35,request_key:uid()},{frame_ids:[ids[0]],rect:null,coordinate_system:'final_canvas_pixels',text:'追加问题',severity:'advisory'},reviewActor);
 assert.throws(()=>listReviewIssues(built.id,issuePage.next_cursor),e=>e.code==='PAGE_CONFLICT');assert.equal(listCandidateFrames(built.id,frozen).items.length,32);
 const denied=await call('/candidates/'+built.id+'/reviews/frame',{context:{task_id:seeded.task.id,candidate_id:built.id,base_review_revision:36,request_key:uid()},patch:{frame_id:ids[0],verdict:'approved'}});assert.equal(denied.status,403);assert.equal(denied.body.error.code,'ROLE_FORBIDDEN');
 
 writeFileSync(join(process.env.SFS_WORKSPACE,'300-evidence.json'),JSON.stringify({candidate_id:built.id,task_id:seeded.task.id,frame_ids:ids,check,stdio_limit:1048576},null,2));
 }finally{server.stop(true);}
 `,'t10');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},180000);
