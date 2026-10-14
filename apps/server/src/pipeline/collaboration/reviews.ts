import {Ajv} from 'ajv';
import {wholeCandidateReviewPatchSchema,type WholeCandidateReviewPatch} from '@framebaker/shared';
import {reviewContextSchema,frameReviewPatchSchema,playbackReviewPatchSchema,issuePatchSchema,issueRepairPatchSchema,sourceDefectPatchSchema,candidateSelectionRequestSchema,deliveryOperationInputSchema,deliveryRequestSchema} from '@framebaker/shared';
import type {ActorContext,ReviewContext,FrameReviewPatch,PlaybackReviewPatch,IssuePatch,IssueRepairPatch,SourceDefectPatch,CandidateSelectionRequest,ReviewResult,ReviewState,ReviewIssueState,ReviewError,ReviewApprovalReference,FrameInheritanceBasis,FrameReviewState,PlaybackReviewState,IssueResolutionBasis,SourceDefectBasis,AcceptanceSnapshot,AcceptanceCheckpoint,DeliveryRequest,DeliveryOperationInput,CandidateManifest} from '@framebaker/shared';
import {db,uid} from '../../db';
import {requireRole,requireCurrentReviewer} from '../../localSessions';
import {PipelineError} from '../service';
import {readCandidate,readCandidateManifest,verifyCandidateFiles} from './candidates';
import {requireCandidateSelfCheck} from './samplingStore';
import {readTaskRecord} from './store';
import {claimOperation,claimDeliveryOperation,collaborationHash,operationJson,readOperation,readOperationInput} from './operations';
import {compareCandidates} from './impact';
import {activeAcceptance,invalidateAcceptance,reviewTransaction} from './reviewBoundary';

const ajv=new Ajv({strict:true,allErrors:true});
const wholeCandidateValid=ajv.compile<WholeCandidateReviewPatch>(wholeCandidateReviewPatchSchema);
const contextValid=ajv.compile<ReviewContext>(reviewContextSchema),frameValid=ajv.compile<FrameReviewPatch>(frameReviewPatchSchema),playbackValid=ajv.compile<PlaybackReviewPatch>(playbackReviewPatchSchema),issueValid=ajv.compile<IssuePatch>(issuePatchSchema),repairValid=ajv.compile<IssueRepairPatch>(issueRepairPatchSchema),exceptionValid=ajv.compile<SourceDefectPatch>(sourceDefectPatchSchema),selectionValid=ajv.compile<CandidateSelectionRequest>(candidateSelectionRequestSchema),deliveryValid=ajv.compile<DeliveryOperationInput>(deliveryOperationInputSchema),requestValid=ajv.compile<DeliveryRequest>(deliveryRequestSchema);
function fail(code:string):never{throw new PipelineError(code,code,409);}
const equal=(a:unknown,b:unknown)=>operationJson(a)===operationJson(b);
const sameSet=(a:string[],b:string[])=>a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));
interface FrameRow {candidate_id:string;frame_id:string;frame_content_hash:string;verdict:FrameReviewPatch['verdict'];review_revision:number;actor_session_id:string;actor_role:'reviewer';request_key:string;inheritance_basis_json:string|null}
interface PlaybackRow {candidate_id:string;playback_hash:string;confirmed:number;review_revision:number;actor_session_id:string;actor_role:'reviewer';request_key:string}
interface IssueRow {id:string;candidate_id:string;frame_ids_json:string;rect_json:string|null;text:string;severity:'blocking'|'advisory';status:ReviewIssueState['status'];repair_candidate_id:string|null;repair_frame_ids_json:string|null;repair_note:string|null;request_key:string}
interface ReviewReceipt {
 version:1;actor:ActorContext;at:number;review_revision:number;candidate_id:string;
 frames:Array<{frame_id:string;hash:string;verdict:FrameReviewPatch['verdict'];inheritance:FrameInheritanceBasis|null}>;
 playback:PlaybackReviewPatch|null;
 repair?:{issue_id:string;repair_candidate_id:string;after_review_revision:number};
 exception?:SourceDefectBasis;resolution?:IssueResolutionBasis|null;
}
function operationEvidence(key:string):{id:string;receipt:ReviewReceipt}|null {
 const row=db.query("SELECT id FROM collab_operations WHERE request_key=? AND state='succeeded' AND kind LIKE 'review_%'").get(key) as {id:string}|null;
 if(!row)return null;
 const op=readOperation(row.id),input=readOperationInput(row.id,op.kind) as {context?:ReviewContext};
 const receipt=op.checkpoint as unknown as ReviewReceipt;
 if(receipt?.version!==1||!receipt.actor||!['maker','reviewer'].includes(receipt.actor.role)||!Number.isSafeInteger(receipt.review_revision)||!Array.isArray(receipt.frames)||input.context?.candidate_id!==receipt.candidate_id||input.context.base_review_revision+1!==receipt.review_revision)return null;
 return {id:row.id,receipt};
}
function frameState(m:CandidateManifest,frameId:string,seen=new Set<string>()):FrameReviewState {
 const f=m.frames.find(f=>f.frame_id===frameId)!;
 const empty:FrameReviewState={frame_id:frameId,frame_content_hash:f.content_hash,verdict:'pending',valid:false,approval:null,inheritance:null};
 const key=m.candidate_id+':'+frameId;if(seen.has(key))return empty;seen=new Set(seen).add(key);
 const row=db.query('SELECT * FROM frame_reviews WHERE candidate_id=? AND frame_id=?').get(m.candidate_id,frameId) as FrameRow|null;
 if(!row)return empty;
 const result={...empty,verdict:row.verdict};
 try {
  const evidence=operationEvidence(row.request_key);if(!evidence||evidence.receipt.actor.role!=='reviewer'||row.actor_role!=='reviewer'||row.actor_session_id!==evidence.receipt.actor.session_id||row.review_revision!==evidence.receipt.review_revision||row.frame_content_hash!==f.content_hash)return result;
  const fact=evidence.receipt.frames.find(x=>x.frame_id===frameId);if(!fact||fact.hash!==f.content_hash||fact.verdict!==row.verdict)return result;
  const inheritance:FrameInheritanceBasis|null=row.inheritance_basis_json?JSON.parse(row.inheritance_basis_json):null;if(!equal(inheritance,fact.inheritance))return result;
  const approval:ReviewApprovalReference={candidate_id:m.candidate_id,frame_id:frameId,frame_content_hash:f.content_hash,review_revision:row.review_revision,operation_id:evidence.id,request_key:row.request_key,actor:evidence.receipt.actor,at:evidence.receipt.at};
  Object.assign(result,{approval,inheritance});if(row.verdict!=='approved')return result;
  if(inheritance){
   if(m.parent_candidate_id!==inheritance.parent.candidate_id)return result;
   const parent=readCandidateManifest(inheritance.parent.candidate_id);verifyCandidateFiles(parent.candidate_id,parent);
   const state=frameState(parent,frameId,seen);
   if(!state.valid||!equal(state.approval,inheritance.parent)||!equal(state.inheritance?.original??state.approval,inheritance.original)||readCandidate(parent.candidate_id).manifest_sha256!==inheritance.parent_manifest_sha256||readCandidate(m.candidate_id).manifest_sha256!==inheritance.child_manifest_sha256)return result;
   const impact=compareCandidates(parent,m);if(collaborationHash(impact)!==inheritance.impact_hash||!impact.inheritable_frame_ids.includes(frameId))return result;
  }
  result.valid=true;return result;
 }catch{return result;}
}
function playbackState(m:CandidateManifest):PlaybackReviewState|null {
 const row=db.query('SELECT * FROM playback_reviews WHERE candidate_id=?').get(m.candidate_id) as PlaybackRow|null;if(!row)return null;
 try{const e=operationEvidence(row.request_key);if(!e||e.receipt.actor.role!=='reviewer'||row.actor_session_id!==e.receipt.actor.session_id||row.review_revision!==e.receipt.review_revision||row.playback_hash!==m.playback_hash||!equal(e.receipt.playback,{playback_hash:row.playback_hash,confirmed:!!row.confirmed}))return null;
 return {playback_hash:row.playback_hash,confirmed:!!row.confirmed,review_revision:row.review_revision,operation_id:e.id,actor:e.receipt.actor};}catch{return null;}
}
function ancestry(id:string):string[] {
 const result:string[]=[],task=readCandidate(id).task_id;let next:string|null=id;
 while(next){if(result.includes(next))fail('CANDIDATE_LINEAGE_INVALID');const m=readCandidateManifest(next);if(m.task_id!==task)fail('CANDIDATE_LINEAGE_INVALID');result.push(next);next=m.parent_candidate_id;}
 return result;
}
function issueRows(taskId:string):IssueRow[]{return db.query('SELECT i.* FROM review_issues i JOIN candidates c ON c.id=i.candidate_id WHERE c.task_id=? ORDER BY i.created_at,i.id').all(taskId) as IssueRow[];}
function issueState(row:IssueRow,targetId:string,chain:string[]):ReviewIssueState {
 const frames:string[]=JSON.parse(row.frame_ids_json);
 const result:ReviewIssueState={id:row.id,candidate_id:row.candidate_id,frame_ids:frames,rect:row.rect_json?JSON.parse(row.rect_json):null,coordinate_system:'final_canvas_pixels',text:row.text,severity:row.severity,status:'open',blocks_candidate:row.severity==='blocking',repair_candidate_id:row.repair_candidate_id,repair_frame_ids:JSON.parse(row.repair_frame_ids_json??'[]'),repair_note:row.repair_note,resolution:null,source_exception:null};
 const e=operationEvidence(row.request_key);
 if(e?.receipt.exception&&e.receipt.actor.role==='reviewer'){
  const exception=e.receipt.exception;
  if(exception.candidate_id===row.candidate_id&&sameSet(exception.frame_ids,frames)&&exception.operation_id===e.id){
   result.status='accepted_exception';result.source_exception=exception;
   // 例外只涵盖明确接受的实际像素范围；改过这些帧的子候选仍须修复确认。
   const original=readCandidateManifest(row.candidate_id),target=readCandidateManifest(targetId);
   const unchanged=frames.every(id=>original.frames.find(f=>f.frame_id===id)?.content_hash===target.frames.find(f=>f.frame_id===id)?.content_hash);
   result.blocks_candidate=row.severity==='blocking'&&!unchanged;return result;
  }
 }
 if(!row.repair_candidate_id)return result;
 result.status='repair_linked';
 try{
  const association=e?.receipt.repair;if(!e||!association||association.issue_id!==row.id||association.repair_candidate_id!==row.repair_candidate_id)return result;
  const repair=readCandidateManifest(row.repair_candidate_id);if(!ancestry(repair.candidate_id).slice(1).includes(row.candidate_id)||!sameSet(frames,result.repair_frame_ids))return result;
  const approvals=frames.map(id=>frameState(repair,id)),playback=playbackState(repair);
  if(approvals.some(s=>!s.valid||s.inheritance!==null||!s.approval||s.approval.review_revision<=association.after_review_revision)||!playback?.confirmed||playback.review_revision<=association.after_review_revision)return result;
  verifyCandidateFiles(repair.candidate_id,repair);
  result.status='resolved';result.resolution={association_operation_id:e.id,repair_candidate_id:repair.candidate_id,after_review_revision:association.after_review_revision,approvals:approvals.map(s=>s.approval!),playback_operation_id:playback.operation_id};
  // 原缺陷像素及其旁支永远不能借修复分支得到豁免。
  result.blocks_candidate=row.severity==='blocking'&&!chain.includes(repair.candidate_id);
 }catch{/* 损坏或缺失的修复依据继续阻断。 */}
 return result;
}
function issuesFor(m:CandidateManifest):ReviewIssueState[]{const chain=ancestry(m.candidate_id);return issueRows(m.task_id).filter(x=>chain.includes(x.candidate_id)).map(x=>issueState(x,m.candidate_id,chain));}
function persistIssueDerivations(taskId:string):void {
 for(const row of issueRows(taskId)){
  const target=row.repair_candidate_id??row.candidate_id;let state:ReviewIssueState;
  try{state=issueState(row,target,ancestry(target));}catch{continue;}
  db.query('UPDATE review_issues SET status=? WHERE id=?').run(state.status,row.id);
  const e=operationEvidence(row.request_key);if(e?.receipt.repair)db.query('UPDATE collab_operations SET checkpoint_json=? WHERE id=?').run(operationJson({...e.receipt,resolution:state.resolution}),e.id);
 }
}
function candidateFacts(id:string):Omit<ReviewState,keyof ReviewResult>&{review_revision:number} {
 const record=readCandidate(id),task=readTaskRecord(record.task_id),errors:ReviewError[]=[];
 const result={task_id:task.id,candidate_id:id,review_revision:record.review_revision,selected:task.selected_candidate_id===id,task_acceptance_counter:task.acceptance_epoch,frame_reviews:[] as FrameReviewState[],issues:[] as ReviewIssueState[],playback_confirmed:false,playback:null as PlaybackReviewState|null,errors};
 try{
  const m=readCandidateManifest(id);
  if(record.visibility!=='submitted')errors.push({code:'CANDIDATE_NOT_SUBMITTED'});
  const rows=db.query('SELECT frame_id,content_hash FROM candidate_frames WHERE candidate_id=?').all(id) as Array<{frame_id:string;content_hash:string}>;
  if(!sameSet(m.frames.map(f=>f.frame_id),rows.map(f=>f.frame_id))||rows.some(f=>m.frames.find(x=>x.frame_id===f.frame_id)?.content_hash!==f.content_hash))errors.push({code:'FRAME_SET_MISMATCH'});
  result.frame_reviews=m.frames.map(f=>frameState(m,f.frame_id));
  for(const state of result.frame_reviews)if(!state.valid)errors.push({code:'FRAME_APPROVAL_REQUIRED',frame_id:state.frame_id});
  result.playback=playbackState(m);result.playback_confirmed=!!result.playback?.confirmed;
  if(!result.playback_confirmed)errors.push({code:'PLAYBACK_REQUIRED'});
  result.issues=issuesFor(m);for(const issue of result.issues)if(issue.blocks_candidate)errors.push({code:'BLOCKING_ISSUE',issue_id:issue.id});
  verifyCandidateFiles(id,m);requireCandidateSelfCheck(id);
 }catch(e){errors.push({code:e instanceof PipelineError?e.code:'CANDIDATE_EVIDENCE_INVALID'});}
 if(task.state==='cancelled')errors.push({code:'TASK_CANCELLED'});
 return result;
}
function activeMatches(request:DeliveryRequest,facts:ReturnType<typeof candidateFacts>):boolean {
 try{
  if(!requestValid(request)||!facts.selected||facts.errors.length||facts.task_acceptance_counter!==request.acceptance_epoch||facts.candidate_id!==request.candidate_id||facts.task_id!==request.task_id)return false;
  const op=readOperation(request.operation_id),input=readOperationInput(op.id,'deliver_candidate');if(op.state==='cancelled'||!deliveryValid(input)||!equal({task_id:input.task_id,candidate_id:input.candidate_id,acceptance_epoch:input.acceptance_epoch},{task_id:request.task_id,candidate_id:request.candidate_id,acceptance_epoch:request.acceptance_epoch}))return false;
  const checkpoint=op.checkpoint as unknown as AcceptanceCheckpoint;
  if(checkpoint?.version!==1||checkpoint.revocation||!equal(checkpoint.snapshot,input.snapshot))return false;
  const record=readCandidate(request.candidate_id),m=readCandidateManifest(request.candidate_id),s=input.snapshot;
  return s.task_id===request.task_id&&s.candidate_id===request.candidate_id&&s.acceptance_epoch===request.acceptance_epoch&&s.manifest_sha256===record.manifest_sha256&&s.content_hash===m.content_hash&&s.playback_hash===m.playback_hash;
 }catch{return false;}
}
export function readReviewState(id:string):ReviewState {
 return reviewTransaction(()=>{const facts=candidateFacts(id),active=activeAcceptance(facts.task_id),valid=!!active&&activeMatches(active,facts);
 if(active?.candidate_id===id&&!valid)invalidateAcceptance(facts.task_id,'review_read_validation_failed',facts.review_revision);
 return {...facts,accepted:valid,acceptance_epoch:valid?active!.acceptance_epoch:null,pending_delivery_operation_id:valid?active!.operation_id:null};});
}
let scheduler:((request:DeliveryRequest)=>void|Promise<void>)|undefined;
/** Task8 注入现有队列；异常保留 claimed 操作，Task9 可协调相同身份。 */
export function setDeliveryScheduler(callback:(request:DeliveryRequest)=>void|Promise<void>):void {scheduler=callback;}
function wake(request:DeliveryRequest|null):void {
 if(!request||!scheduler)return;
 try{const promise=scheduler(request);if(promise)void promise.catch(()=>{});}catch{/* 审核已经提交，调度失败不能回滚人工作业。 */}
}
function reconcile(taskId:string):DeliveryRequest|null {
 persistIssueDerivations(taskId);
 const task=readTaskRecord(taskId),active=activeAcceptance(taskId);
 if(!task.selected_candidate_id){if(active)invalidateAcceptance(taskId,'selection_missing');return null;}
 // 未齐全时只做廉价的必要条件检查；满足后仍核验完整 ID 集及所有实际依据。
 if(!active){
  const counts=db.query("SELECT (SELECT COUNT(*) FROM candidate_frames WHERE candidate_id=?) AS required,(SELECT COUNT(*) FROM frame_reviews WHERE candidate_id=? AND verdict='approved') AS approved,(SELECT confirmed FROM playback_reviews WHERE candidate_id=?) AS playback").get(task.selected_candidate_id,task.selected_candidate_id,task.selected_candidate_id) as {required:number;approved:number;playback:number|null};
  if(!counts.required||counts.required!==counts.approved||counts.playback!==1)return null;
 }
 const facts=candidateFacts(task.selected_candidate_id);
 if(active){if(activeMatches(active,facts))return null;invalidateAcceptance(taskId,'review_conditions_changed',facts.review_revision);}
 // 保留已有有效接受与创建新代次是两回事；返工/制作中的旧批准不能自动重新开启审核。
 if(readTaskRecord(taskId).state!=='awaiting_review')return null;
 if(facts.errors.length)return null;
 const id=task.selected_candidate_id,m=readCandidateManifest(id),record=readCandidate(id),epoch=task.acceptance_epoch+1;
 if(!Number.isSafeInteger(epoch))fail('ACCEPTANCE_EPOCH_EXHAUSTED');
 const snapshot:AcceptanceSnapshot={version:1,task_id:taskId,candidate_id:id,acceptance_epoch:epoch,review_revision:record.review_revision,manifest_sha256:record.manifest_sha256,content_hash:m.content_hash,playback_hash:m.playback_hash,technical_check_id:record.technical_check_id!,self_check_id:record.self_check_id!,frame_approvals:facts.frame_reviews.map(f=>({approval:f.approval!,inheritance:f.inheritance})),playback:facts.playback!,issues:facts.issues};
 const input:DeliveryOperationInput={task_id:taskId,candidate_id:id,acceptance_epoch:epoch,snapshot};if(!deliveryValid(input))fail('ACCEPTANCE_SNAPSHOT_INVALID');
 const op=claimDeliveryOperation(input),request={task_id:taskId,candidate_id:id,acceptance_epoch:epoch,operation_id:op.id};
 db.query('UPDATE collab_operations SET checkpoint_json=? WHERE id=?').run(operationJson({version:1,snapshot,revocation:null}),op.id);
 db.query("UPDATE collab_tasks SET acceptance_epoch=?,state='accepted',operation_ids_json=?,recovery_json=json_set(COALESCE(recovery_json,'{}'),'$.acceptance',json(?)),updated_at=? WHERE id=?").run(epoch,operationJson([...readTaskRecord(taskId).operation_ids,op.id]),operationJson(request),Date.now(),taskId);
 return request;
}
const resultOf=(id:string):ReviewResult=>{const record=readCandidate(id),a=activeAcceptance(record.task_id),valid=a?.candidate_id===id;return {review_revision:record.review_revision,accepted:!!valid,acceptance_epoch:valid?a.acceptance_epoch:null,pending_delivery_operation_id:valid?a.operation_id:null};};
function mutate<P>(kind:string,context:ReviewContext,patch:P,actor:ActorContext,valid:(value:unknown)=>boolean,apply:(m:CandidateManifest,receipt:ReviewReceipt,operationId:string)=>void,maker=false):ReviewResult {
 if(maker)requireRole(actor,'maker');else requireCurrentReviewer(actor);
 if(!contextValid(context)||!valid(patch))fail('INVALID_REVIEW_REQUEST');
 let pending:DeliveryRequest|null=null;
 const result=reviewTransaction(()=>{
  const op=claimOperation(kind,{request_key:context.request_key},{context,patch});
  if(op.state==='succeeded')return op.result as unknown as ReviewResult;
  const record=readCandidate(context.candidate_id);if(record.task_id!==context.task_id)fail('CANDIDATE_TASK_MISMATCH');if(record.visibility!=='submitted')fail('CANDIDATE_NOT_SUBMITTED');
  if(record.review_revision!==context.base_review_revision)fail('REVIEW_REVISION_CONFLICT');
  const m=readCandidateManifest(record.id),revision=record.review_revision+1;
  const receipt:ReviewReceipt={version:1,actor:{...actor},at:Date.now(),review_revision:revision,candidate_id:record.id,frames:[],playback:null};
  apply(m,receipt,op.id);
  db.query('UPDATE candidates SET review_revision=? WHERE id=?').run(revision,record.id);
  db.query("UPDATE collab_operations SET state='succeeded',checkpoint_json=?,updated_at=? WHERE id=?").run(operationJson(receipt),Date.now(),op.id);
  const task=readTaskRecord(context.task_id);db.query('UPDATE collab_tasks SET operation_ids_json=? WHERE id=?').run(operationJson([...task.operation_ids,op.id]),task.id);
  pending=reconcile(context.task_id);const result=resultOf(record.id);
  db.query('UPDATE collab_operations SET result_json=? WHERE id=?').run(operationJson(result),op.id);return result;
 });wake(pending);return result;
}
function writeFrame(m:CandidateManifest,patch:FrameReviewPatch,receipt:ReviewReceipt,key:string,inheritance:FrameInheritanceBasis|null=null):void {
 const f=m.frames.find(f=>f.frame_id===patch.frame_id);if(!f)fail('CANDIDATE_FRAME_NOT_FOUND');
 db.query(`INSERT INTO frame_reviews(candidate_id,frame_id,frame_content_hash,verdict,review_revision,actor_session_id,actor_role,request_key,inherited_candidate_id,inherited_review_revision,inheritance_basis_json,updated_at) VALUES(?,?,?,?,?,?,'reviewer',?,?,?,?,?) ON CONFLICT(candidate_id,frame_id) DO UPDATE SET frame_content_hash=excluded.frame_content_hash,verdict=excluded.verdict,review_revision=excluded.review_revision,actor_session_id=excluded.actor_session_id,actor_role=excluded.actor_role,request_key=excluded.request_key,inherited_candidate_id=excluded.inherited_candidate_id,inherited_review_revision=excluded.inherited_review_revision,inheritance_basis_json=excluded.inheritance_basis_json,updated_at=excluded.updated_at`).run(m.candidate_id,f.frame_id,f.content_hash,patch.verdict,receipt.review_revision,receipt.actor.session_id,key,inheritance?.parent.candidate_id??null,inheritance?.parent.review_revision??null,inheritance?operationJson(inheritance):null,receipt.at);
 receipt.frames.push({frame_id:f.frame_id,hash:f.content_hash,verdict:patch.verdict,inheritance});
}
export function applyFrameReview(context:ReviewContext,patch:FrameReviewPatch,actor:ActorContext):ReviewResult {return mutate('review_frame',context,patch,actor,frameValid,(m,e)=>writeFrame(m,patch,e,context.request_key));}
function writePlayback(m:CandidateManifest,patch:PlaybackReviewPatch,e:ReviewReceipt,key:string):void {
 if(patch.playback_hash!==m.playback_hash)fail('PLAYBACK_HASH_MISMATCH');e.playback=patch;
 db.query(`INSERT INTO playback_reviews(candidate_id,playback_hash,confirmed,review_revision,actor_session_id,actor_role,request_key,updated_at) VALUES(?,?,?,?,?,'reviewer',?,?) ON CONFLICT(candidate_id) DO UPDATE SET playback_hash=excluded.playback_hash,confirmed=excluded.confirmed,review_revision=excluded.review_revision,actor_session_id=excluded.actor_session_id,actor_role=excluded.actor_role,request_key=excluded.request_key,updated_at=excluded.updated_at`).run(m.candidate_id,patch.playback_hash,patch.confirmed?1:0,e.review_revision,e.actor.session_id,key,e.at);
}
export function applyPlaybackReview(context:ReviewContext,patch:PlaybackReviewPatch,actor:ActorContext):ReviewResult {return mutate('review_playback',context,patch,actor,playbackValid,(m,e)=>writePlayback(m,patch,e,context.request_key));}
/** 用户明确确认整段已检查；同一事务保留每帧真实审核依据和播放记录。 */
export function applyWholeCandidateReview(context:ReviewContext,patch:WholeCandidateReviewPatch,actor:ActorContext):ReviewResult {return mutate('review_candidate',context,patch,actor,wholeCandidateValid,(m,e)=>{
 const task=readTaskRecord(m.task_id);
 if(task.selected_candidate_id!==m.candidate_id)fail('CANDIDATE_SELECTION_CONFLICT');
 if(task.state!=='awaiting_review')fail('CANDIDATE_NOT_AWAITING_REVIEW');
 if(patch.content_hash!==m.content_hash)fail('CANDIDATE_CONTENT_HASH_MISMATCH');
 if(patch.playback_hash!==m.playback_hash)fail('PLAYBACK_HASH_MISMATCH');
 verifyCandidateFiles(m.candidate_id,m);requireCandidateSelfCheck(m.candidate_id);
 if(issuesFor(m).some(issue=>issue.blocks_candidate))fail('BLOCKING_ISSUE');
 if(m.frames.some(frame=>frameState(m,frame.frame_id).verdict==='needs_repair'))fail('FRAME_REPAIR_REQUIRED');
 for(const frame of m.frames)writeFrame(m,{frame_id:frame.frame_id,verdict:'approved'},e,context.request_key);
 writePlayback(m,{playback_hash:m.playback_hash,confirmed:true},e,context.request_key);
 });}
export function applyIssue(context:ReviewContext,patch:IssuePatch,actor:ActorContext):ReviewResult {return mutate('review_issue',context,patch,actor,issueValid,(m,e)=>{
 if(patch.frame_ids.some(id=>!m.frames.some(f=>f.frame_id===id)))fail('CANDIDATE_FRAME_NOT_FOUND');
 if(patch.rect){const [x,y,w,h]=patch.rect;if(![x,y,w,h].every(Number.isFinite)||x<0||y<0||w<=0||h<=0||x+w>m.alignment.canvas.width||y+h>m.alignment.canvas.height)fail('ISSUE_RECT_INVALID');}
 db.query(`INSERT INTO review_issues(id,candidate_id,frame_ids_json,rect_json,coordinate_system,text,severity,review_revision,actor_session_id,request_key,created_at,updated_at) VALUES(?,?,?,?,'final_canvas_pixels',?,?,?,?,?,?,?)`).run(uid(),m.candidate_id,operationJson(patch.frame_ids),patch.rect?operationJson(patch.rect):null,patch.text,patch.severity,e.review_revision,e.actor.session_id,context.request_key,e.at,e.at);
 });}
function ownIssue(m:CandidateManifest,id:string):IssueRow {const row=db.query('SELECT * FROM review_issues WHERE id=? AND candidate_id=?').get(id,m.candidate_id) as IssueRow|null;return row??fail('ISSUE_NOT_FOUND');}
export function recordIssueRepair(context:ReviewContext,patch:IssueRepairPatch,actor:ActorContext):ReviewResult {return mutate('review_repair',context,patch,actor,repairValid,(m,e)=>{
 const row=ownIssue(m,patch.issue_id),child=readCandidateManifest(patch.repair_candidate_id);
 if(child.task_id!==m.task_id||!ancestry(child.candidate_id).slice(1).includes(m.candidate_id))fail('REPAIR_LINEAGE_INVALID');
 if(readCandidate(child.candidate_id).visibility!=='submitted')fail('CANDIDATE_NOT_SUBMITTED');
 if(!sameSet(JSON.parse(row.frame_ids_json),patch.frame_ids)||patch.frame_ids.some(id=>!child.frames.some(f=>f.frame_id===id)))fail('REPAIR_SCOPE_MISMATCH');verifyCandidateFiles(child.candidate_id,child);
 e.repair={issue_id:row.id,repair_candidate_id:child.candidate_id,after_review_revision:readCandidate(child.candidate_id).review_revision};
 db.query("UPDATE review_issues SET status='repair_linked',repair_candidate_id=?,repair_frame_ids_json=?,repair_note=?,review_revision=?,actor_session_id=?,request_key=?,updated_at=? WHERE id=?").run(child.candidate_id,operationJson(patch.frame_ids),patch.note,e.review_revision,e.actor.session_id,context.request_key,e.at,row.id);
 },true);}
export function acceptSourceDefect(context:ReviewContext,patch:SourceDefectPatch,actor:ActorContext):ReviewResult {return mutate('review_source_exception',context,patch,actor,exceptionValid,(m,e,id)=>{
 const issue=ownIssue(m,patch.issue_id);if(!sameSet(JSON.parse(issue.frame_ids_json),patch.frame_ids))fail('SOURCE_EXCEPTION_SCOPE_MISMATCH');
 e.exception={operation_id:id,candidate_id:m.candidate_id,frame_ids:patch.frame_ids,reason:patch.reason,actor:e.actor};
 db.query("UPDATE review_issues SET status='accepted_exception',review_revision=?,actor_session_id=?,request_key=?,updated_at=? WHERE id=?").run(e.review_revision,e.actor.session_id,context.request_key,e.at,issue.id);
 });}
export function applyFrameInheritance(context:ReviewContext,parentCandidateId:string,actor:ActorContext):ReviewResult {return mutate('review_inheritance',context,{parent_candidate_id:parentCandidateId},actor,p=>typeof p==='object'&&p!==null&&typeof (p as {parent_candidate_id?:string}).parent_candidate_id==='string',(m,e)=>{
 if(m.parent_candidate_id!==parentCandidateId)fail('CANDIDATE_PARENT_MISMATCH');const parent=readCandidateManifest(parentCandidateId);verifyCandidateFiles(parentCandidateId,parent);verifyCandidateFiles(m.candidate_id,m);
 const impact=compareCandidates(parent,m),issues=issuesFor(m),excluded=new Set(issues.flatMap(i=>(i.blocks_candidate||i.repair_candidate_id===m.candidate_id)?i.frame_ids:[]));
 for(const id of impact.inheritable_frame_ids){if(excluded.has(id))continue;const old=frameState(parent,id),current=frameState(m,id);if(!old.valid||!old.approval||old.frame_content_hash!==m.frames.find(f=>f.frame_id===id)?.content_hash)continue;
  if(current.valid&&!current.inheritance)continue;
  const basis:FrameInheritanceBasis={parent:old.approval,original:old.inheritance?.original??old.approval,parent_manifest_sha256:readCandidate(parentCandidateId).manifest_sha256,child_manifest_sha256:readCandidate(m.candidate_id).manifest_sha256,impact_hash:collaborationHash(impact)};
  writeFrame(m,{frame_id:id,verdict:'approved'},e,context.request_key,basis);
 }
 });}
export function selectCandidate(request:CandidateSelectionRequest,actor:ActorContext):ReviewResult {
 requireCurrentReviewer(actor);if(!selectionValid(request))fail('INVALID_SELECTION_REQUEST');let pending:DeliveryRequest|null=null;
 const result=reviewTransaction(()=>{const op=claimOperation('select_candidate',{request_key:request.request_key},request);if(op.state==='succeeded')return op.result as unknown as ReviewResult;
  const task=readTaskRecord(request.task_id),target=readCandidate(request.candidate_id);
  if(task.selected_candidate_id!==request.expected_selected_candidate_id||task.acceptance_epoch!==request.expected_acceptance_epoch)fail('TASK_SELECTION_CONFLICT');
  if(task.state==='cancelled')fail('TASK_CANCELLED');if(target.task_id!==task.id||target.visibility!=='submitted')fail('CANDIDATE_NOT_SELECTABLE');
  const active=activeAcceptance(task.id),preservesActive=!!active&&activeMatches(active,candidateFacts(target.id));
  if(task.selected_candidate_id!==target.id||(task.state!=='awaiting_review'&&!preservesActive)){
   invalidateAcceptance(task.id,'selection_changed');
   db.query("UPDATE collab_tasks SET selected_candidate_id=?,acceptance_epoch=acceptance_epoch+1,state='awaiting_review',updated_at=? WHERE id=?").run(target.id,Date.now(),task.id);
  }
  db.query('UPDATE collab_tasks SET operation_ids_json=? WHERE id=?').run(operationJson([...task.operation_ids,op.id]),task.id);pending=reconcile(task.id);const result=resultOf(target.id);
  db.query("UPDATE collab_operations SET state='succeeded',checkpoint_json=?,result_json=?,updated_at=? WHERE id=?").run(operationJson({actor,at:Date.now()}),operationJson(result),Date.now(),op.id);return result;
 });wake(pending);return result;
}
/** Task8/9 最终同步提交入口：重新核对当前事实，允许 advisory 修订前进，不把旧快照修订当锁。 */
export function withAcceptedDelivery<T>(request:DeliveryRequest,commit:(snapshot:AcceptanceSnapshot)=>T):T {
 if(!requestValid(request))fail('ACCEPTANCE_INVALID');
 let invalid=false;
 const result=reviewTransaction(()=>{const facts=candidateFacts(request.candidate_id),active=activeAcceptance(request.task_id);
  if(!active||!equal(active,request)||!activeMatches(request,facts)){if(active&&equal(active,request))invalidateAcceptance(request.task_id,'publication_validation_failed',facts.review_revision);invalid=true;return undefined;}
  const input=readOperationInput(request.operation_id,'deliver_candidate') as DeliveryOperationInput;
  const result=commit(input.snapshot);if(result&&typeof (result as {then?:unknown}).then==='function')fail('ASYNC_REVIEW_TRANSACTION');return result;
 });if(invalid)fail('ACCEPTANCE_INVALID');return result as T;
}
