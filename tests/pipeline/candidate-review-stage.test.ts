import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
const run=async(script:string)=>{const result=await runCollaborationScript(reviewSetup+'{'+script+'}','t7');expect(result.exit_code,result.stderr+' '+result.workspace).toBe(0);};

test('explicit rework survives reads, advisory and success replay until same-ID reviewer selection opens review',()=>run(String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);
 const playbackContext=rc(candidate.id),patch={playback_hash:c.readCandidateManifest(candidate.id).playback_hash,confirmed:true};const accepted=r.applyPlaybackReview(playbackContext,patch,human),count=()=>db.query("SELECT COUNT(*) n FROM collab_operations WHERE kind='deliver_candidate'").get().n;
 d.startRework(candidate.task_id,candidate.id,d.readDraftContent(context).token,{request_key:uid()},actor);const rework=readTaskRecord(candidate.task_id),initial=count();
 const checkRework=()=>{assert.equal(readTaskRecord(candidate.task_id).state,'reworking');assert.equal(readTaskRecord(candidate.task_id).acceptance_epoch,rework.acceptance_epoch);assert.equal(r.readReviewState(candidate.id).accepted,false);assert.equal(count(),initial);};checkRework();
 const noteContext=rc(candidate.id),note={frame_ids:[c.readCandidateManifest(candidate.id).frames[0].frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'advisory while reworking',severity:'advisory'};const result=r.applyIssue(noteContext,note,human);checkRework();assert.equal(result.accepted,false);
 assert.deepEqual(r.applyIssue(noteContext,note,human),result);assert.deepEqual(r.applyPlaybackReview(playbackContext,patch,human),accepted);checkRework();
 const selectionRequest={task_id:candidate.task_id,candidate_id:candidate.id,expected_selected_candidate_id:candidate.id,expected_acceptance_epoch:rework.acceptance_epoch,request_key:uid()};assert.throws(()=>r.selectCandidate(selectionRequest,actor),e=>e.code==='ROLE_FORBIDDEN');checkRework();
 const reopened=r.selectCandidate(selectionRequest,human);assert.equal(reopened.accepted,true);assert.equal(reopened.acceptance_epoch,rework.acceptance_epoch+2);assert.equal(count(),initial+1);assert.equal(readTaskRecord(candidate.task_id).state,'accepted');assert.notEqual(reopened.pending_delivery_operation_id,accepted.pending_delivery_operation_id);
 assert.deepEqual(r.selectCandidate(selectionRequest,human),reopened);assert.equal(count(),initial+1);assert.throws(()=>r.selectCandidate({...selectionRequest,request_key:uid()},human),e=>e.code==='TASK_SELECTION_CONFLICT');assert.equal(count(),initial+1);
 assert.equal(ops.readOperation(accepted.pending_delivery_operation_id).checkpoint.revocation.reason,'rework_started');
`),120000);

test('new private proposal opens review, normal revoked-frame reapproval and accepted advisory keep expected epochs',()=>run(String.raw`
 const {request}=await seedCandidate(2),parent=await c.buildPrivateCandidate(request());await submit(parent);frames(parent.id);playback(parent.id);d.startRework(parent.task_id,parent.id,d.readDraftContent(context).token,{request_key:uid()},actor);
 const candidate=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await submit(candidate);assert.equal(readTaskRecord(parent.task_id).state,'awaiting_review');assert.equal(readTaskRecord(parent.task_id).selected_candidate_id,candidate.id);frames(candidate.id);const accepted=playback(candidate.id),frame=c.readCandidateManifest(candidate.id).frames[0].frame_id;
 const note=r.applyIssue(rc(candidate.id),{frame_ids:[frame],rect:null,coordinate_system:'final_canvas_pixels',text:'accepted advisory',severity:'advisory'},human);assert.equal(note.acceptance_epoch,accepted.acceptance_epoch);
 r.applyFrameReview(rc(candidate.id),{frame_id:frame,verdict:'pending'},human);assert.equal(readTaskRecord(candidate.task_id).state,'awaiting_review');const next=r.applyFrameReview(rc(candidate.id),{frame_id:frame,verdict:'approved'},human);assert.equal(next.accepted,true);assert.ok(next.acceptance_epoch>accepted.acceptance_epoch);
`),120000);

test('already-valid active acceptance survives a concurrently running private build',()=>run(String.raw`
 const {request}=await seedCandidate(2),parent=await c.buildPrivateCandidate(request());await submit(parent);
 let release,arrive;const gate=new Promise(resolve=>release=resolve),reached=new Promise(resolve=>arrive=resolve);const buildRequest={...request(),parent_candidate_id:parent.id};
 const pending=c.buildPrivateCandidate(buildRequest,undefined,undefined,{onPhase:async phase=>{if(phase==='copied'){arrive();await gate;}}});await reached;
 const pendingOperation=db.query('SELECT id FROM collab_operations WHERE request_key=?').get(buildRequest.request_key).id;
 // 显式选择正在审核的同一候选；私有构建仍在挂起且尚未提交。
 const explicit=selection(parent.id);assert.equal(explicit.accepted,false);frames(parent.id);const accepted=playback(parent.id);assert.equal(accepted.accepted,true);
 const state=()=>readTaskRecord(parent.task_id);assert.equal(state().operation_ids.includes(pendingOperation),true);
 assert.equal(r.readReviewState(parent.id).acceptance_epoch,accepted.acceptance_epoch);
 const note=r.applyIssue(rc(parent.id),{frame_ids:[c.readCandidateManifest(parent.id).frames[0].frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'private build in flight',severity:'advisory'},human);assert.equal(note.acceptance_epoch,accepted.acceptance_epoch);
 release();const child=await pending;assert.equal(c.readCandidate(child.id).visibility,'private');assert.equal(r.readReviewState(parent.id).acceptance_epoch,accepted.acceptance_epoch);assert.equal(ops.readOperation(accepted.pending_delivery_operation_id).checkpoint.revocation,null);assert.equal(state().operation_ids.includes(pendingOperation),true);
`),120000);
