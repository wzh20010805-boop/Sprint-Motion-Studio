import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
test('controlled competing review/selection requests serialize CAS and reject obsolete delivery identity',async()=>{
 const x=await runCollaborationScript(reviewSetup+String.raw`{
 const {request}=await seedCandidate(2);const p=await c.buildPrivateCandidate(request());await submit(p);const before=rc(p.id),f=c.readCandidateManifest(p.id).frames[0].frame_id;
 let release;const barrier=new Promise(resolve=>release=resolve);const attempts=[0,1].map(i=>(async()=>{await barrier;try{return r.applyFrameReview({...before,request_key:uid()},{frame_id:f,verdict:'approved'},human);}catch(e){return e.code;}})());release();const results=await Promise.all(attempts);assert.equal(results.filter(x=>x==='REVIEW_REVISION_CONFLICT').length,1);frames(p.id);const a=playback(p.id);
 const delivery={task_id:p.task_id,candidate_id:p.id,acceptance_epoch:a.acceptance_epoch,operation_id:a.pending_delivery_operation_id};r.withAcceptedDelivery(delivery,()=>assert.equal(db.inTransaction,true));
 r.applyIssue(rc(p.id),{frame_ids:[f],rect:null,coordinate_system:'final_canvas_pixels',text:'block',severity:'blocking'},human);assert.throws(()=>r.withAcceptedDelivery(delivery,()=>assert.fail('obsolete publish')),e=>e.code==='ACCEPTANCE_INVALID');
 const issue=r.readReviewState(p.id).issues[0];assert.throws(()=>r.acceptSourceDefect(rc(p.id),{issue_id:issue.id,frame_ids:[f],reason:'fixture exception'},actor),e=>e.code==='ROLE_FORBIDDEN');r.acceptSourceDefect(rc(p.id),{issue_id:issue.id,frame_ids:[f],reason:'fixture exception'},human);assert.equal(r.readReviewState(p.id).accepted,true);
 auth.initializeLocalSessions('next-test-instance','next-maker');assert.throws(()=>r.applyFrameReview(before,{frame_id:f,verdict:'approved'},human),e=>e.code==='ROLE_FORBIDDEN');
 }`,'t7');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},120000);

test('publication before revocation retains succeeded result; advisory publication and same-key races preserve epoch',async()=>{
 const x=await runCollaborationScript(reviewSetup+String.raw`{
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const accepted=playback(candidate.id),delivery={task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:accepted.acceptance_epoch,operation_id:accepted.pending_delivery_operation_id};
 r.applyIssue(rc(candidate.id),{frame_ids:[c.readCandidateManifest(candidate.id).frames[0].frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'advisory after snapshot',severity:'advisory'},human);
 r.withAcceptedDelivery(delivery,snapshot=>{assert.ok(c.readCandidate(candidate.id).review_revision>snapshot.review_revision);db.query("UPDATE collab_operations SET state='succeeded',result_json=? WHERE id=?").run(JSON.stringify({delivery_id:'test-only-published',approval_status:'current',retained:'artifact fixture'}),delivery.operation_id);db.query("UPDATE collab_tasks SET state='delivered' WHERE id=?").run(candidate.task_id);});
 playback(candidate.id,false);const op=ops.readOperation(delivery.operation_id);assert.equal(op.state,'succeeded');assert.equal(op.result.delivery_id,'test-only-published');assert.equal(op.result.approval_status,'withdrawn');assert.equal(op.result.retained,'artifact fixture');assert.ok(op.checkpoint.revocation);
 const context=rc(candidate.id),patch={playback_hash:c.readCandidateManifest(candidate.id).playback_hash,confirmed:true};let release;const barrier=new Promise(resolve=>release=resolve);const promises=[0,1].map(i=>(async()=>{await barrier;return r.applyPlaybackReview(context,patch,human);})());release();const [a,b]=await Promise.all(promises);assert.deepEqual(a,b);assert.ok(a.acceptance_epoch>accepted.acceptance_epoch);
 assert.equal(db.query("SELECT COUNT(*) n FROM collab_operations WHERE kind='deliver_candidate'").get().n,2);
 }`,'t7');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},120000);
