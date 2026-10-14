import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
test('whole review HTTP requires desktop reviewer and exact route context',async()=>{
 const result=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);r.setDeliveryScheduler(()=>{});
 const m=c.readCandidateManifest(candidate.id),payload={context:rc(candidate.id),patch:{content_hash:m.content_hash,playback_hash:m.playback_hash,confirmed:true}};
 const {Elysia}=await import('./apps/server/node_modules/elysia'),{collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const app=new Elysia().use(collaborationApi);
 const reviewUrl='http://localhost/api/v1/collaboration/candidates/'+candidate.id+'/reviews/whole';
 const make=(url,headers)=>new Request(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(payload)});
 assert.equal((await app.handle(make(reviewUrl,{}))).status,401);
 const maker=make(reviewUrl,{Authorization:'Bearer test-maker'});auth.authenticateLocalRequest(maker,'localhost');assert.equal((await app.handle(maker)).status,403);
 const secret=auth.issueReviewerSession('synthetic-test-only'),cookie={cookie:'sfs_reviewer='+secret};
 const mismatch=make(reviewUrl.replace(candidate.id,'wrong-id'),cookie);auth.authenticateLocalRequest(mismatch,'localhost');assert.equal((await app.handle(mismatch)).status,409);
 const approved=make(reviewUrl,cookie);auth.authenticateLocalRequest(approved,'localhost');const response=await app.handle(approved);assert.equal(response.status,200);assert.equal((await response.json()).data.accepted,true);
 `,'whole-review-http');expect(result.exit_code,result.stderr).toBe(0);
},30000);
test('whole candidate review is reviewer-only, bound, atomic, replayable and revocable',async()=>{
 const result=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(3),candidate=await c.buildPrivateCandidate(request());await submit(candidate);r.setDeliveryScheduler(()=>{});
 const m=c.readCandidateManifest(candidate.id),patch={content_hash:m.content_hash,playback_hash:m.playback_hash,confirmed:true};
 const maker=auth.authenticateLocalRequest(new Request('http://localhost/test',{headers:{Authorization:'Bearer test-maker'}}),'localhost');
 assert.throws(()=>r.applyWholeCandidateReview(rc(candidate.id),patch,maker),e=>e.code==='ROLE_FORBIDDEN');
 assert.throws(()=>r.applyWholeCandidateReview(rc(candidate.id),{...patch,confirmed:false},human),e=>e.code==='INVALID_REVIEW_REQUEST');
 assert.throws(()=>r.applyWholeCandidateReview(rc(candidate.id),{...patch,content_hash:'0'.repeat(64)},human),e=>e.code==='CANDIDATE_CONTENT_HASH_MISMATCH');
 const stale=rc(candidate.id);r.applyFrameReview(rc(candidate.id),{frame_id:m.frames[0].frame_id,verdict:'approved'},human);
 assert.throws(()=>r.applyWholeCandidateReview(stale,patch,human),e=>e.code==='REVIEW_REVISION_CONFLICT');
 const contextAll=rc(candidate.id),done=r.applyWholeCandidateReview(contextAll,patch,human);assert.equal(done.accepted,true);
 const state=r.readReviewState(candidate.id);assert.equal(state.frame_reviews.filter(f=>f.valid).length,3);assert.equal(state.playback_confirmed,true);
 assert.deepEqual(r.applyWholeCandidateReview(contextAll,patch,human),done);assert.equal(db.query("SELECT COUNT(*) n FROM collab_operations WHERE kind='deliver_candidate'").get().n,1);
 const receipt=ops.readOperation(state.frame_reviews[1].approval.operation_id).checkpoint;assert.equal(receipt.actor.role,'reviewer');assert.equal(receipt.actor.session_id,human.session_id);assert.equal(receipt.frames.length,3);
 playback(candidate.id,false);assert.equal(r.readReviewState(candidate.id).accepted,false);
 `,'whole-review');expect(result.exit_code,result.stderr).toBe(0);
},30000);
test('whole candidate confirmation cannot overwrite unresolved repair verdicts or blocking issues',async()=>{
 const result=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);r.setDeliveryScheduler(()=>{});
 const m=c.readCandidateManifest(candidate.id),patch={content_hash:m.content_hash,playback_hash:m.playback_hash,confirmed:true};
 r.applyFrameReview(rc(candidate.id),{frame_id:m.frames[0].frame_id,verdict:'needs_repair'},human);
 assert.throws(()=>r.applyWholeCandidateReview(rc(candidate.id),patch,human),e=>e.code==='FRAME_REPAIR_REQUIRED');
 r.applyFrameReview(rc(candidate.id),{frame_id:m.frames[0].frame_id,verdict:'pending'},human);
 r.applyIssue(rc(candidate.id),{frame_ids:[m.frames[0].frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'blocking test issue',severity:'blocking'},human);
 assert.throws(()=>r.applyWholeCandidateReview(rc(candidate.id),patch,human),e=>e.code==='BLOCKING_ISSUE');
 const state=r.readReviewState(candidate.id);assert.equal(state.frame_reviews.filter(f=>f.valid).length,0);assert.equal(state.playback_confirmed,false);assert.equal(state.accepted,false);
 `,'whole-review-blocked');expect(result.exit_code,result.stderr).toBe(0);
},30000);
