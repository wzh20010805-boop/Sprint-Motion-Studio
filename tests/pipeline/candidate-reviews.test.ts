import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
const run=async(s:string)=>{const x=await runCollaborationScript(reviewSetup+'{'+s+'}','t7');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);};
test('review authority, exact 300-frame coverage, playback, durable wake and immutable evidence',()=>run(String.raw`
 const {request}=await seedCandidate(300),candidate=await c.buildPrivateCandidate(request());await submit(candidate);const id=candidate.id,m=c.readCandidateManifest(id),original=readFileSync(candidate.manifest_path),revision=d.readDraftContent(context).token;
 const ctx=rc(id),patch={frame_id:m.frames[0].frame_id,verdict:'approved'};
 for(const bad of [actor,{role:'reviewer',session_id:human.session_id}])assert.throws(()=>r.applyFrameReview(ctx,patch,bad),e=>e.code==='ROLE_FORBIDDEN');
 const first=r.applyFrameReview(ctx,patch,human);human=reviewer();assert.deepEqual(r.applyFrameReview(ctx,patch,human),first);
 assert.throws(()=>r.applyFrameReview(ctx,patch,actor),e=>e.code==='ROLE_FORBIDDEN');assert.throws(()=>r.applyFrameReview({...ctx,request_key:uid()},patch,human),e=>e.code==='REVIEW_REVISION_CONFLICT');
 assert.throws(()=>r.applyFrameReview(ctx,{...patch,verdict:'pending'},human),e=>e.code==='REQUEST_CONFLICT');
 frames(id,[m.frames[0].frame_id,m.frames[155].frame_id]);assert.equal(playback(id).accepted,false);assert.equal(r.readReviewState(id).frame_reviews.length,300);
 let wakes=0;r.setDeliveryScheduler(req=>{wakes++;assert.equal(db.inTransaction,false);assert.equal(ops.readOperation(req.operation_id).state,'claimed');throw Error('synthetic scheduler interruption');});
 const accepted=r.applyFrameReview(rc(id),{frame_id:m.frames[155].frame_id,verdict:'approved'},human);assert.equal(accepted.accepted,true);assert.equal(wakes,1);assert.ok(accepted.acceptance_epoch>0);
 const op=ops.readOperation(accepted.pending_delivery_operation_id);assert.equal(op.state,'claimed');assert.equal(op.attempt_job_ids.length,0);assert.equal(ops.readOperationInput(op.id,'deliver_candidate').snapshot.frame_approvals.length,300);
 const note=r.applyIssue(rc(id),{frame_ids:[m.frames[0].frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'advisory fixture',severity:'advisory'},human);assert.equal(note.acceptance_epoch,accepted.acceptance_epoch);assert.equal(wakes,1);
 assert.deepEqual(readFileSync(candidate.manifest_path),original);assert.deepEqual(d.readDraftContent(context).token,revision);assert.equal(r.readReviewState(id).accepted,true);
 const revoke=r.applyFrameReview(rc(id),{frame_id:m.frames[0].frame_id,verdict:'pending'},human);assert.equal(revoke.acceptance_epoch,null);assert.ok(ops.readOperation(op.id).checkpoint.revocation);assert.equal(readTaskRecord(candidate.task_id).acceptance_epoch,accepted.acceptance_epoch);
 const next=r.applyFrameReview(rc(id),patch,human);assert.ok(next.acceptance_epoch>accepted.acceptance_epoch);assert.notEqual(next.pending_delivery_operation_id,op.id);
 console.log(JSON.stringify({candidate:id,first_epoch:accepted.acceptance_epoch,next_epoch:next.acceptance_epoch,frames:300,wakes}));
`),180000);
test('repair needs complete lineage and fresh explicit child confirmations; original parent remains defective',()=>run(String.raw`
 const {request}=await seedCandidate(4);const parent=await c.buildPrivateCandidate(request());await submit(parent);frames(parent.id);playback(parent.id);
 const ids=c.readCandidateManifest(parent.id).frames.map(f=>f.frame_id);r.applyIssue(rc(parent.id),{frame_ids:ids.slice(0,2),rect:[0,0,3,3],coordinate_system:'final_canvas_pixels',text:'synthetic defect',severity:'blocking'},human);
 const issue=r.readReviewState(parent.id).issues[0];const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await submit(child);frames(child.id);playback(child.id);
 assert.throws(()=>r.recordIssueRepair(rc(parent.id),{issue_id:issue.id,repair_candidate_id:child.id,frame_ids:[ids[0]],note:'partial'},actor),e=>e.code==='REPAIR_SCOPE_MISMATCH');
 r.recordIssueRepair(rc(parent.id),{issue_id:issue.id,repair_candidate_id:child.id,frame_ids:ids.slice(0,2),note:'complete'},actor);assert.equal(r.readReviewState(child.id).issues[0].status,'repair_linked');assert.equal(r.readReviewState(child.id).accepted,false);
 r.applyFrameInheritance(rc(child.id),parent.id,human);assert.equal(r.readReviewState(child.id).issues[0].status,'repair_linked');
 for(const frame_id of ids.slice(0,2))r.applyFrameReview(rc(child.id),{frame_id,verdict:'approved'},human);assert.equal(r.readReviewState(child.id).accepted,false);const accepted=playback(child.id);assert.equal(accepted.accepted,true);assert.equal(r.readReviewState(child.id).issues[0].status,'resolved');
 selection(parent.id);assert.equal(r.readReviewState(parent.id).accepted,false);selection(child.id);assert.equal(r.readReviewState(child.id).accepted,true);
 r.applyFrameReview(rc(child.id),{frame_id:ids[0],verdict:'pending'},human);assert.equal(r.readReviewState(child.id).issues[0].status,'repair_linked');assert.equal(r.readReviewState(child.id).accepted,false);
`),120000);
test('explicit inheritance depends on current ancestral approval until child reaffirmation',()=>run(String.raw`
 const {request}=await seedCandidate(4);const p=await c.buildPrivateCandidate(request());await submit(p);frames(p.id);playback(p.id);
 d.startRework(p.task_id,p.id,d.readDraftContent(context).token,{request_key:uid()},actor);
 const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:p.id});await submit(child);r.applyFrameInheritance(rc(child.id),p.id,human);assert.equal(r.readReviewState(child.id).playback_confirmed,false);const accepted=playback(child.id);assert.equal(accepted.accepted,true);
 const f=c.readCandidateManifest(p.id).frames[0].frame_id;r.applyFrameReview(rc(p.id),{frame_id:f,verdict:'pending'},human);assert.equal(r.readReviewState(child.id).accepted,false);assert.equal(readTaskRecord(p.task_id).selected_candidate_id,child.id);
 assert.equal(r.readReviewState(child.id).frame_reviews.find(x=>x.frame_id===f).valid,false);
 r.applyFrameReview(rc(child.id),{frame_id:f,verdict:'approved'},human);assert.equal(r.readReviewState(child.id).accepted,true);assert.equal(r.readReviewState(child.id).frame_reviews.find(x=>x.frame_id===f).inheritance,null);
 const old=c.readCandidate(p.id);c.submitCandidate(old.id,old.content_hash,actor);assert.equal(readTaskRecord(p.task_id).selected_candidate_id,child.id);
`),120000);

test('real proposal invalidates acceptance, selection has separate CAS, repair retarget revokes prior resolution',()=>run(String.raw`
 const {request}=await seedCandidate(3);const parent=await c.buildPrivateCandidate(request());await submit(parent);
 const a=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id}),b=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});
 selection(parent.id);frames(parent.id);const accepted=playback(parent.id),before=readTaskRecord(parent.task_id);await submit(a);
 assert.ok(ops.readOperation(accepted.pending_delivery_operation_id).checkpoint.revocation);assert.ok(readTaskRecord(parent.task_id).acceptance_epoch>before.acceptance_epoch);assert.equal(r.readReviewState(parent.id).accepted,false);
 const stale={task_id:parent.task_id,candidate_id:parent.id,expected_selected_candidate_id:a.id,expected_acceptance_epoch:readTaskRecord(parent.task_id).acceptance_epoch,request_key:uid()};await submit(b);
 assert.throws(()=>r.selectCandidate(stale,human),e=>e.code==='TASK_SELECTION_CONFLICT');assert.equal(readTaskRecord(parent.task_id).selected_candidate_id,b.id);
 const id=c.readCandidateManifest(parent.id).frames[0].frame_id;r.applyIssue(rc(parent.id),{frame_ids:[id],rect:null,coordinate_system:'final_canvas_pixels',text:'retarget fixture',severity:'blocking'},human);const issue=r.readReviewState(parent.id).issues[0];
 r.recordIssueRepair(rc(parent.id),{issue_id:issue.id,repair_candidate_id:b.id,frame_ids:[id],note:'first'},actor);frames(b.id);assert.equal(playback(b.id).accepted,true);
 r.recordIssueRepair(rc(parent.id),{issue_id:issue.id,repair_candidate_id:a.id,frame_ids:[id],note:'retarget'},actor);assert.equal(r.readReviewState(b.id).accepted,false);assert.equal(r.readReviewState(b.id).issues[0].status,'repair_linked');
 frames(a.id);playback(a.id);selection(a.id);assert.equal(r.readReviewState(a.id).accepted,true);selection(b.id);assert.equal(r.readReviewState(b.id).accepted,false);
`),120000);

test('technical blockers and frozen corruption cannot be exempted or revive a withdrawn epoch',()=>run(String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const first=playback(candidate.id),m=c.readCandidateManifest(candidate.id),f=m.frames[0],path=c.candidateFilePath(candidate.id,f.files.png),bytes=readFileSync(path);
 writeFileSync(join(STORAGE_ROOT,'retained-original-final.png'),bytes);writeFileSync(path,'corrupt synthetic fixture');const report=await checkCandidate(candidate.id);assert.ok(report.blocking_errors.length);writeFileSync(join(STORAGE_ROOT,'retained-corrupt-final.png'),readFileSync(path));writeFileSync(path,bytes);
 sampling.recordSampleObservations(candidate.id,sampling.getCandidateSamplingPlan(candidate.id,actor).plan_hash,[],actor);
 r.applyIssue(rc(candidate.id),{frame_ids:[f.frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'source flaw',severity:'blocking'},human);const issue=r.readReviewState(candidate.id).issues[0];r.acceptSourceDefect(rc(candidate.id),{issue_id:issue.id,frame_ids:[f.frame_id],reason:'explicit synthetic source exception'},human);
 assert.equal(r.readReviewState(candidate.id).accepted,false);assert.ok(ops.readOperation(first.pending_delivery_operation_id).checkpoint.revocation);
 await checkCandidate(candidate.id);sampling.recordSampleObservations(candidate.id,sampling.getCandidateSamplingPlan(candidate.id,actor).plan_hash,[],actor);const second=playback(candidate.id);assert.equal(second.accepted,true);assert.ok(second.acceptance_epoch>first.acceptance_epoch);
 writeFileSync(path,'corrupt-again');assert.equal(r.readReviewState(candidate.id).acceptance_epoch,null);writeFileSync(path,bytes);assert.equal(r.readReviewState(candidate.id).accepted,false);
 assert.throws(()=>r.withAcceptedDelivery({task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:second.acceptance_epoch,operation_id:second.pending_delivery_operation_id},()=>assert.fail()),e=>e.code==='ACCEPTANCE_INVALID');
`),120000);

test('HTTP maker body spoofing and private/cross-scope mistakes have no review side effects; shared schema matches',()=>run(String.raw`
 const {Elysia}=await import('./apps/server/node_modules/elysia');const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const {Ajv}=await import('ajv');const schemas=await import('./packages/shared/src/pipeline/collaborationSchemas');
 const api=new Elysia().onRequest(({request})=>{auth.authenticateLocalRequest(request,'localhost:3000');}).use(collaborationApi);
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request()),m=c.readCandidateManifest(candidate.id),patch={frame_id:m.frames[0].frame_id,verdict:'approved'};
 assert.throws(()=>r.applyFrameReview(rc(candidate.id),patch,human),e=>e.code==='CANDIDATE_NOT_SUBMITTED');await submit(candidate);
 const count=()=>db.query('SELECT COUNT(*) n FROM collab_operations').get().n,old=count();
 const protectedCalls=[()=>r.applyPlaybackReview(rc(candidate.id),{playback_hash:m.playback_hash,confirmed:true},actor),()=>r.applyIssue(rc(candidate.id),{frame_ids:[patch.frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'blocked',severity:'blocking'},actor),()=>r.applyFrameInheritance(rc(candidate.id),candidate.id,actor),()=>r.acceptSourceDefect(rc(candidate.id),{issue_id:'unknown',frame_ids:[patch.frame_id],reason:'blocked'},actor),()=>r.selectCandidate({task_id:candidate.task_id,candidate_id:candidate.id,expected_selected_candidate_id:candidate.id,expected_acceptance_epoch:readTaskRecord(candidate.task_id).acceptance_epoch,request_key:uid()},actor)];
 for(const call of protectedCalls)assert.throws(call,e=>e.code==='ROLE_FORBIDDEN');assert.equal(count(),old);

 for(const headers of [{authorization:'Bearer test-maker'},{cookie:'sfs_token=test-maker'}]){
 const response=await api.handle(new Request('http://localhost:3000/api/v1/collaboration/reviews/frame',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({context:rc(candidate.id),patch:{...patch,actor:{role:'reviewer',session_id:human.session_id}}})}));assert.notEqual(response.status,200);
 }
 assert.equal(count(),old);assert.equal(c.readCandidate(candidate.id).review_revision,0);
 assert.throws(()=>r.applyPlaybackReview(rc(candidate.id),{playback_hash:'a'.repeat(64),confirmed:true},human),e=>e.code==='PLAYBACK_HASH_MISMATCH');
 assert.throws(()=>r.applyIssue(rc(candidate.id),{frame_ids:[patch.frame_id],rect:[95,95,2,2],coordinate_system:'final_canvas_pixels',text:'bad rectangle',severity:'blocking'},human),e=>e.code==='ISSUE_RECT_INVALID');
 assert.throws(()=>r.applyFrameReview({...rc(candidate.id),task_id:'unrelated'},patch,human),e=>e.code==='CANDIDATE_TASK_MISMATCH');assert.equal(count(),old);
 assert.throws(()=>r.applyFrameReview({...rc(candidate.id),request_key:'server:delivery:guess'},patch,human),e=>e.code==='RESERVED_REQUEST_KEY');
 const secret=auth.issueReviewerSession('synthetic-test-only');const response=await api.handle(new Request('http://localhost:3000/api/v1/collaboration/reviews/frame',{method:'POST',headers:{cookie:'sfs_reviewer='+secret,'content-type':'application/json'},body:JSON.stringify({context:rc(candidate.id),patch})}));assert.equal(response.status,200);
 const ajv=new Ajv({strict:true}),state=r.readReviewState(candidate.id);assert.equal(ajv.compile(schemas.reviewStateSchema)(state),true);assert.equal(ajv.compile(schemas.actorContextSchema)(human),true);assert.equal(ajv.compile(schemas.workContextSchema)({project_id:'bad:entity',axis_id:'a'}),false);assert.equal(ajv.compile(schemas.deliveryRequestSchema)({task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:0,operation_id:'op'}),false);
`),120000);

test('multi-generation inheritance follows current chain; independent child confirmation severs only its frame dependency',()=>run(String.raw`
 const {request}=await seedCandidate(4),p=await c.buildPrivateCandidate(request());await submit(p);frames(p.id);playback(p.id);
 d.startRework(p.task_id,p.id,d.readDraftContent(context).token,{request_key:uid()},actor);const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:p.id});await submit(child);r.applyFrameInheritance(rc(child.id),p.id,human);const ids=c.readCandidateManifest(child.id).frames.map(f=>f.frame_id);r.applyFrameReview(rc(child.id),{frame_id:ids[0],verdict:'approved'},human);playback(child.id);
 d.startRework(p.task_id,child.id,d.readDraftContent(context).token,{request_key:uid()},actor);const grandchild=await c.buildPrivateCandidate({...request(),parent_candidate_id:child.id});await submit(grandchild);r.applyFrameInheritance(rc(grandchild.id),child.id,human);assert.equal(playback(grandchild.id).accepted,true);
 r.applyFrameReview(rc(p.id),{frame_id:ids[0],verdict:'pending'},human);assert.equal(r.readReviewState(grandchild.id).accepted,true);
 r.applyFrameReview(rc(p.id),{frame_id:ids[1],verdict:'pending'},human);const state=r.readReviewState(grandchild.id);assert.equal(state.accepted,false);assert.equal(state.frame_reviews.find(f=>f.frame_id===ids[1]).valid,false);assert.equal(state.frame_reviews.find(f=>f.frame_id===ids[0]).valid,true);
 r.applyFrameReview(rc(grandchild.id),{frame_id:ids[1],verdict:'approved'},human);assert.equal(r.readReviewState(grandchild.id).accepted,true);
`),120000);

test('same-pixel neighbor review cannot be inherited after actual structural impact',()=>run(String.raw`
 const {request}=await seedCandidate(5),p=await c.buildPrivateCandidate(request());await submit(p);frames(p.id);playback(p.id);const pm=c.readCandidateManifest(p.id);
 d.startRework(p.task_id,p.id,d.readDraftContent(context).token,{request_key:uid()},actor);db.query('UPDATE frames SET offset_x=1 WHERE id=?').run(pm.frames[2].frame_id);const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:p.id});await submit(child);r.applyFrameInheritance(rc(child.id),p.id,human);
 const state=r.readReviewState(child.id),cm=c.readCandidateManifest(child.id);assert.equal(pm.frames[1].png_sha256,cm.frames[1].png_sha256);assert.deepEqual(state.frame_reviews.filter(f=>f.valid).map(f=>f.frame_id),[pm.frames[0].frame_id,pm.frames[4].frame_id]);assert.equal(playback(child.id).accepted,false);
`),120000);
