import {Ajv} from 'ajv';
import {candidateBuildRequestSchema,candidateManifestSchema,candidateCheckpointSchema} from '@framebaker/shared';
import type {ActorContext,CandidateBuildRequest,CandidateCheckpoint,CandidateFrame,CandidateManifest,CandidateRecord,OperationRecord,TaskBrief} from '@framebaker/shared';
import {copyFileSync,existsSync,mkdirSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {db,REPO_ROOT,STORAGE_ROOT,uid} from '../../db';
import {requireRole} from '../../localSessions';
import {JobCancelledError} from '../../jobs/run';
import {fileHash} from '../alignment';
import {maskState,runImageWorker} from '../masks';
import {PipelineError,validateId} from '../service';
import {readDraftContent} from './drafts';
import {readTaskRecord} from './store';
import {claimOperation,collaborationHash,operationJson,readOperation,readOperationInput,writeOperationCheckpoint} from './operations';
import {candidateContentHash,candidateFiles,candidateFrameHash,candidatePlaybackHash} from './candidateIdentity';
import {requireCandidateSelfCheck} from './samplingStore';
import {invalidateAcceptance,reviewTransaction} from './reviewBoundary';

const ajv=new Ajv({strict:true,allErrors:true});
const validRequest=ajv.compile<CandidateBuildRequest>(candidateBuildRequestSchema),validManifest=ajv.compile<CandidateManifest>(candidateManifestSchema);
const validRecoveryCheckpoint=ajv.compile<CandidateCheckpoint>(candidateCheckpointSchema);
const fail=(code:string):never=>{throw new PipelineError(code,code,409);};
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new JobCancelledError();};
type CandidateRow=CandidateRecord&{manifest_json:string;technical_check_json:string|null;self_check_json:string|null;sampling_plan_json:string|null};
export function candidateDirectory(id:string):string {validateId(id);return join(STORAGE_ROOT,'candidates',id);}
function row(id:string):CandidateRow {validateId(id);const value=db.query('SELECT * FROM candidates WHERE id=?').get(id) as CandidateRow|null;return value??fail('CANDIDATE_NOT_FOUND');}
export function readCandidate(id:string):CandidateRecord {
  const r=row(id);return {id:r.id,task_id:r.task_id,parent_candidate_id:r.parent_candidate_id,manifest_path:r.manifest_path,manifest_sha256:r.manifest_sha256,content_hash:r.content_hash,visibility:r.visibility,technical_check_id:r.technical_check_id,self_check_id:r.self_check_id,review_revision:r.review_revision};
}
export function candidateFilePath(id:string,file:string):string {
  if(isAbsolute(file)||file.includes('\\')||file.split('/').some(p=>!p||p==='.'||p==='..'))return fail('CANDIDATE_PATH_INVALID');
  const root=candidateDirectory(id),path=resolve(root,file),rel=relative(root,path);
  if(rel.startsWith('..')||isAbsolute(rel))return fail('CANDIDATE_PATH_INVALID');
  if(existsSync(path)){const actual=relative(realpathSync(root),realpathSync(path));if(actual.startsWith('..')||isAbsolute(actual))return fail('CANDIDATE_PATH_INVALID');}
  return path;
}
export function readCandidateManifest(id:string):CandidateManifest {
  const r=row(id),manifest=JSON.parse(r.manifest_json) as CandidateManifest;
  if(!validManifest(manifest)||manifest.candidate_id!==id||manifest.task_id!==r.task_id||manifest.content_hash!==r.content_hash||candidateContentHash(manifest)!==r.content_hash||candidatePlaybackHash(manifest)!==manifest.playback_hash||manifest.frames.some(f=>candidateFrameHash(f,manifest)!==f.content_hash))return fail('CANDIDATE_MANIFEST_INVALID');
  if(collaborationHash({version:'pillow-compositor-v1',...manifest.compositor})!==manifest.compositor_hash)return fail('CANDIDATE_MANIFEST_INVALID');
  if(r.manifest_path!==join(candidateDirectory(id),'manifest.json')||!existsSync(r.manifest_path)||fileHash(r.manifest_path)!==r.manifest_sha256||readFileSync(r.manifest_path,'utf8')!==operationJson(manifest))return fail('CANDIDATE_MANIFEST_CHANGED');
  return manifest;
}
export function verifyCandidateFiles(id:string,manifest=readCandidateManifest(id)):void {
  for(const item of candidateFiles(manifest)){const path=candidateFilePath(id,item.file);if(!existsSync(path)||fileHash(path)!==item.sha256)fail('CANDIDATE_FILE_CHANGED');}
}
export function prepareCandidate(request:CandidateBuildRequest,actor:ActorContext):OperationRecord {
  requireRole(actor,'maker');if(!validRequest(request))return fail('INVALID_CANDIDATE_REQUEST');
  return db.transaction(()=>{
    const operation=claimOperation('build_candidate',{request_key:request.request_key},request);
    if(operation.state==='succeeded'||operation.attempt_job_ids.length)return operation;
    const task=readTaskRecord(request.task_id);
    if(task.context.project_id!==request.project_id||task.context.axis_id!==request.axis_id)fail('TASK_CONTEXT_MISMATCH');
    if(['cancelled','delivered','packaging','accepted'].includes(task.state))fail('TASK_NOT_PRODUCIBLE');
    if(request.parent_candidate_id&&row(request.parent_candidate_id).task_id!==task.id)fail('CANDIDATE_PARENT_MISMATCH');
    return operation;
  }).immediate();
}
type Scheduler=(request:CandidateBuildRequest,operation:OperationRecord)=>string;
let schedule:Scheduler|undefined;
/** 由现有 queue 注入；图像/候选模块不反向加载调度器。 */
export function setCandidateScheduler(callback:Scheduler):void {schedule=callback;}
/** 排队关联与运行尝试都保留在任务历史；失败操作也不能从任务摘要消失。 */
export function markCandidateProducing(taskId:string,operationId:string):void {
  db.transaction(()=>{
    const task=readTaskRecord(taskId);
    if(['cancelled','delivered','packaging','accepted'].includes(task.state))fail('TASK_NOT_PRODUCIBLE');
    // 已排队操作开始运行不能抢回较新请求的归属；顺序由首次持久关联决定。
    if(task.operation_ids.includes(operationId))return;
    const owner:CandidateTaskOperationOwner={version:1,operation_id:operationId,selected_candidate_id:task.selected_candidate_id,acceptance_epoch:task.acceptance_epoch};
    db.query("UPDATE collab_tasks SET state='producing',operation_ids_json=?,recovery_json=json_set(COALESCE(recovery_json,'{}'),'$.candidate_operation',json(?)),updated_at=? WHERE id=?")
      .run(operationJson([...task.operation_ids,operationId]),operationJson(owner),Date.now(),taskId);
  }).immediate();
}
/** 复用任务恢复元数据中的窄归属标识，不替代操作自身的持久检查点。 */
interface CandidateTaskOperationOwner {version:1;operation_id:string;selected_candidate_id:string|null;acceptance_epoch:number}
export function finishCandidateTaskAttempt(taskId:string,operationId:string,state:'checking'|'needs_input'|'failed'):void {
  db.query(`UPDATE collab_tasks SET state=?,updated_at=? WHERE id=? AND state='producing'
    AND json_extract(recovery_json,'$.candidate_operation.version')=1
    AND json_extract(recovery_json,'$.candidate_operation.operation_id')=?
    AND selected_candidate_id IS json_extract(recovery_json,'$.candidate_operation.selected_candidate_id')
    AND acceptance_epoch=json_extract(recovery_json,'$.candidate_operation.acceptance_epoch')`).run(state,Date.now(),taskId,operationId);
}
export function createPrivateCandidate(request:CandidateBuildRequest,actor:ActorContext):{operation_id:string;job_id:string|null} {
  const operation=prepareCandidate(request,actor);
  const job=operation.attempt_job_ids.at(-1);
  if(job)return {operation_id:operation.id,job_id:job};
  if(operation.state==='succeeded')return {operation_id:operation.id,job_id:null};
  if(!schedule)return fail('CANDIDATE_QUEUE_UNAVAILABLE');
  return {operation_id:operation.id,job_id:schedule(request,operation)};
}
function coverage(request:CandidateBuildRequest,draft:ReturnType<typeof readDraftContent>) {
  const tracks=db.query('SELECT id FROM animation_tracks WHERE axis_id=? AND is_primary=1').all(request.axis_id) as {id:string}[];
  if(tracks.length!==1)fail('PRIMARY_TRACK_INVALID');
  const steps=db.query(`SELECT s.id step_id,s.idx,f.id frame_id,f.metadata FROM animation_steps s
    LEFT JOIN frames f ON f.step_id=s.id AND f.track_id=? AND f.project_id=? WHERE s.axis_id=? ORDER BY s.idx,s.id`).all(tracks[0]!.id,request.project_id,request.axis_id) as {step_id:string;idx:number;frame_id:string|null;metadata:string}[];
  if(steps.some(s=>!s.frame_id))fail('MISSING_PRIMARY_FRAME');
  if(!steps.length||steps.length!==draft.expected_source_frame_ids.length||steps.length!==draft.frames.length)fail('SOURCE_COVERAGE_MISMATCH');
  return steps.map((step,i)=>{
    const frame=draft.frames[i]!,metadata=JSON.parse(step.metadata);
    if(step.idx!==i||frame.sequence_index!==i)fail('SEQUENCE_ORDER_INVALID');
    if(frame.frame_id!==step.frame_id||frame.source_frame_id!==draft.expected_source_frame_ids[i]||metadata.source_frame_id!==draft.expected_source_frame_ids[i])fail('SOURCE_MAPPING_MISMATCH');
    return {step_id:step.step_id,frame_id:frame.frame_id,source_frame_id:frame.source_frame_id};
  });
}
/** 测试/恢复故障注入仅观察阶段，不更换合成器或提交逻辑。 */
export interface CandidateBuildHooks {job_id?:string;onPhase?:(phase:'copied'|'rendered'|'prepared'|'moved'|'committed',checkpoint:CandidateCheckpoint)=>void|Promise<void>}
export async function buildPrivateCandidate(request:CandidateBuildRequest,signal?:AbortSignal,progress?:(text:string)=>void,hooks:CandidateBuildHooks={}):Promise<CandidateRecord> {
  const operation=prepareCandidate(request,{role:'maker',session_id:'queue'});
  if(operation.state==='succeeded'){
    const result=operation.result as {candidate_id?:string};if(!result?.candidate_id)return fail('OPERATION_RESULT_INVALID');return readCandidate(result.candidate_id);
  }
  const original=readOperationInput(operation.id,'build_candidate');
  if(!validRequest(original)||collaborationHash(original)!==collaborationHash(request))return fail('OPERATION_INPUT_MISMATCH');
  if(operation.state==='running')return fail('CANDIDATE_BUILD_BUSY');
  if(!['claimed','queued'].includes(operation.state))return fail('OPERATION_NEEDS_RECOVERY');
  const id=uid(),attempt=uid(),staging=join(STORAGE_ROOT,'candidates','.staging',attempt),destination=candidateDirectory(id);
  const checkpoint:CandidateCheckpoint={version:1,phase:'freezing',operation_id:operation.id,candidate_id:id,attempt_id:attempt,job_id:hooks.job_id??null,staging_directory:staging,final_directory:destination,base_content:request.base_content,manifest_sha256:null,content_hash:null,files:[]};
  db.transaction(()=>{markCandidateProducing(request.task_id,operation.id);db.query("UPDATE collab_operations SET state='running',updated_at=? WHERE id=?").run(Date.now(),operation.id);writeOperationCheckpoint(operation.id,checkpoint);}).immediate();
  mkdirSync(staging,{recursive:true});
  try {
    abort(signal);const task=readTaskRecord(request.task_id),draft=readDraftContent(task.context);
    const alignment=draft.alignment;
    if(!alignment)throw new PipelineError('ALIGNMENT_REQUIRED','ALIGNMENT_REQUIRED',409);
    const frozenCoverage=coverage(request,draft);
    if(operationJson(draft.token)!==operationJson(request.base_content))fail('CONTENT_CONFLICT');
    const briefRow=db.query('SELECT brief_json FROM task_briefs WHERE task_id=? AND version=?').get(task.id,task.brief_version) as {brief_json:string};
    const brief=JSON.parse(briefRow.brief_json) as TaskBrief;
    const inputs=draft.frames.map((f,i)=>{
      abort(signal);if(!f.mask_version_id||!f.mask_path||!f.mask_sha256||!f.rgba_path||!f.rgba_sha256)return fail('MASK_REQUIRED');
      const files={raw:`inputs/${i}/raw.png`,mask:`inputs/${i}/mask.png`,rgba:`inputs/${i}/rgba.png`,png:''};
      for(const [kind,path,expected] of [['raw',f.raw_path,f.raw_sha256],['mask',f.mask_path,f.mask_sha256],['rgba',f.rgba_path,f.rgba_sha256]] as const){
        const target=join(staging,files[kind]);mkdirSync(dirname(target),{recursive:true});copyFileSync(path,target);
        if(fileHash(target)!==expected||fileHash(path)!==expected)fail('INPUT_CHANGED_DURING_FREEZE');
      }
      const mask=maskState(f.frame_id).current;const info=mask?.info?JSON.parse(mask.info):{};
      return {draft:f,files,provenance:{kind:mask?.kind??'unknown',reasons:info.reasons??[]}};
    });
    await hooks.onPhase?.('copied',checkpoint);abort(signal);
    const rendered=await runImageWorker({action:'export',directory:staging,alignment,...brief.output.value,draft:true,
      frames:inputs.map(({draft:f,files})=>({id:f.frame_id,path:join(staging,files.rgba),index:f.sequence_index,transform:f.transform,duration:f.duration}))},join(staging,'worker'),signal,progress,(done,total)=>`固定候选合成 ${done}/${total}`);
    await hooks.onPhase?.('rendered',checkpoint);abort(signal);
    const compositor={source_hash:collaborationHash({worker:fileHash(join(REPO_ROOT,'workers/image/worker.py')),compose:fileHash(join(REPO_ROOT,'workers/image/compose.py'))}),pillow_version:String(rendered.pillow_version)};
    const manifest:CandidateManifest={schema_version:'1.0',candidate_id:id,parent_candidate_id:request.parent_candidate_id??null,task_id:task.id,brief_version:task.brief_version,content_token:draft.token,content_hash:'',playback_hash:'',compositor_hash:collaborationHash({version:'pillow-compositor-v1',...compositor}),compositor,
      alignment,brief,coverage:frozenCoverage,output:{...brief.output.value,loop:brief.loop.value},frames:[],grid:rendered.grid,
      sheets:rendered.sheets.map((s:any)=>({...s,sha256:fileHash(join(staging,s.file))})),auxiliary_files:['previews/contact-sheet.png','worker/request.json','worker/result.json'].map(file=>({file,sha256:fileHash(join(staging,file))}))};
    manifest.frames=inputs.map(({draft:f,files,provenance},i)=>{
      const output=rendered.frames[i];
      const frame:CandidateFrame={frame_id:f.frame_id,source_frame_id:f.source_frame_id,source_index:f.source_index,sequence_index:f.sequence_index,duration:f.duration,duration_origin:f.duration_origin,source_size:f.source_size,
        raw_sha256:f.raw_sha256,mask_version_id:f.mask_version_id!,mask_sha256:f.mask_sha256!,rgba_sha256:f.rgba_sha256!,png_sha256:fileHash(join(staging,output.file)),content_hash:'',files:{...files,png:output.file},mask_provenance:provenance,
        resolved_transform:f.transform,resolved_root:{x:output.root[0],y:output.root[1]},source_to_canvas:output.source_to_canvas,grid_cell:{sheet_index:manifest.sheets.findIndex(s=>s.file===output.sheet),rect:output.rect}};
      frame.content_hash=candidateFrameHash(frame,manifest);return frame;
    });
    manifest.playback_hash=candidatePlaybackHash(manifest);manifest.content_hash=candidateContentHash(manifest);
    if(!validManifest(manifest))throw new PipelineError('CANDIDATE_MANIFEST_INVALID',JSON.stringify(validManifest.errors));
    writeFileSync(join(staging,'manifest.json'),operationJson(manifest));
    Object.assign(checkpoint,{phase:'prepared',manifest_sha256:fileHash(join(staging,'manifest.json')),content_hash:manifest.content_hash,files:[...candidateFiles(manifest),{file:'manifest.json',sha256:fileHash(join(staging,'manifest.json'))}]});
    writeOperationCheckpoint(operation.id,checkpoint);await hooks.onPhase?.('prepared',checkpoint);abort(signal);
    const assertBase=()=>{if(operationJson(readDraftContent(task.context).token)!==operationJson(request.base_content)||readTaskRecord(task.id).brief_version!==task.brief_version)fail('CONTENT_CONFLICT');if(readTaskRecord(task.id).state==='cancelled')fail('TASK_CANCELLED');};
    assertBase();for(const file of checkpoint.files)if(fileHash(join(staging,file.file))!==file.sha256)fail('FROZEN_INPUT_CHANGED');
    renameSync(staging,destination);await hooks.onPhase?.('moved',checkpoint);abort(signal);
    assertBase();for(const file of checkpoint.files)if(fileHash(join(destination,file.file))!==file.sha256)fail('FROZEN_INPUT_CHANGED');
    const revision=(db.query('SELECT content_revision FROM projects WHERE id=?').get(task.context.project_id) as {content_revision:number}).content_revision;
    db.transaction(()=>{
      abort(signal);if(readOperation(operation.id).state==='cancelled')throw new JobCancelledError();
      const current=readTaskRecord(task.id),currentRevision=(db.query('SELECT content_revision FROM projects WHERE id=?').get(task.context.project_id) as {content_revision:number}).content_revision;
      if(currentRevision!==revision||current.brief_version!==task.brief_version)fail('CONTENT_CONFLICT');
      if(current.state==='cancelled')fail('TASK_CANCELLED');
      db.query(`INSERT INTO candidates(id,task_id,parent_candidate_id,brief_version,content_revision,content_token_hash,content_hash,playback_hash,compositor_hash,manifest_path,manifest_sha256,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,task.id,manifest.parent_candidate_id,task.brief_version,draft.token.revision,draft.token.hash,manifest.content_hash,manifest.playback_hash,manifest.compositor_hash,join(destination,'manifest.json'),checkpoint.manifest_sha256,operationJson(manifest),Date.now());
      const insert=db.query(`INSERT INTO candidate_frames(candidate_id,frame_id,source_frame_id,source_index,sequence_index,duration_num,duration_den,duration_origin,raw_sha256,mask_version_id,mask_sha256,png_sha256,content_hash,files_json,resolved_transform_json,resolved_root_json,source_to_canvas_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const f of manifest.frames)insert.run(id,f.frame_id,f.source_frame_id,f.source_index,f.sequence_index,f.duration.num,f.duration.den,f.duration_origin,f.raw_sha256,f.mask_version_id,f.mask_sha256,f.png_sha256,f.content_hash,operationJson(f.files),operationJson(f.resolved_transform),operationJson(f.resolved_root),operationJson(f.source_to_canvas));
      checkpoint.phase='committed';writeOperationCheckpoint(operation.id,checkpoint);
      db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson({candidate_id:id,content_hash:manifest.content_hash}),Date.now(),operation.id);
      db.query('UPDATE collab_tasks SET operation_ids_json=?,updated_at=? WHERE id=?').run(operationJson([...new Set([...current.operation_ids,operation.id])]),Date.now(),task.id);
      finishCandidateTaskAttempt(task.id,operation.id,'checking');
    }).immediate();
    await hooks.onPhase?.('committed',checkpoint);return readCandidate(id);
  } catch(error) {
    // 提交后中断不撤销私有候选；Task9 可由 committed 身份补齐 job result。
    if(readOperation(operation.id).state==='succeeded')return readCandidate(id);
    const code=error instanceof PipelineError?error.code:error instanceof JobCancelledError?'CANCELLED':'BUILD_FAILED';
    const state=signal?.aborted||error instanceof JobCancelledError?'cancelled':code==='CONTENT_CONFLICT'?'needs_input':'failed';
    db.transaction(()=>{
      db.query('UPDATE collab_operations SET state=?,result_json=?,updated_at=? WHERE id=?').run(state,operationJson({error_code:code}),Date.now(),operation.id);
      finishCandidateTaskAttempt(request.task_id,operation.id,state==='cancelled'?'needs_input':state);
    }).immediate();
    writeFileSync(join(existsSync(staging)?staging:destination,'failure.json'),operationJson({code,message:error instanceof Error?error.message:String(error),checkpoint}));
    throw error;
  }
}
export function submitCandidate(id:string,expectedHash:string,actor:ActorContext):CandidateRecord {
  requireRole(actor,'maker');const record=row(id),manifest=readCandidateManifest(id);
  if(expectedHash!==manifest.content_hash)fail('CANDIDATE_HASH_CONFLICT');
  const report=record.technical_check_json?JSON.parse(record.technical_check_json):null;
  if(!record.technical_check_id||report?.id!==record.technical_check_id||report.candidate_id!==id||report.content_hash!==expectedHash||report.manifest_sha256!==record.manifest_sha256||report.checked_frame_count!==manifest.frames.length||!Array.isArray(report.blocking_errors)||report.blocking_errors.length)fail('TECHNICAL_CHECK_FAILED');
  verifyCandidateFiles(id,manifest);
  requireCandidateSelfCheck(id);
  return reviewTransaction(()=>{
    const task=readTaskRecord(record.task_id);if(task.state==='cancelled')fail('TASK_CANCELLED');
    if(row(id).visibility==='submitted')return readCandidate(id);
    invalidateAcceptance(task.id,'candidate_submitted');
    db.query("UPDATE candidates SET visibility='submitted',submitted_at=? WHERE id=?").run(Date.now(),id);
    db.query("UPDATE collab_tasks SET selected_candidate_id=?,state='awaiting_review',acceptance_epoch=acceptance_epoch+1,recovery_json=json_remove(COALESCE(recovery_json,'{}'),'$.candidate_operation'),updated_at=? WHERE id=?").run(id,Date.now(),task.id);
    return readCandidate(id);
  });
}

/** 固定清单恢复只补原私有提交；已提交时先验证原事实，不检查后来草稿。 */
export function inspectCandidateRecovery(operationId:string):{request:CandidateBuildRequest;checkpoint:CandidateCheckpoint|null;committed:CandidateRecord|null} {
 const op=readOperation(operationId),request=readOperationInput(operationId,'build_candidate');
 if(!validRequest(request))return fail('RECOVERY_IDENTITY_CONFLICT');
 if(op.checkpoint===null)return {request,checkpoint:null,committed:null};
 const cp=op.checkpoint;if(!validRecoveryCheckpoint(cp)||cp.operation_id!==op.id||operationJson(cp.base_content)!==operationJson(request.base_content)||cp.final_directory!==candidateDirectory(cp.candidate_id)||cp.staging_directory!==join(STORAGE_ROOT,'candidates','.staging',cp.attempt_id)||cp.job_id!==null&&!op.attempt_job_ids.includes(cp.job_id))return fail('RECOVERY_IDENTITY_CONFLICT');
 const committed=db.query('SELECT id FROM candidates WHERE id=?').get(cp.candidate_id);
 if(committed){
  if(op.state!=='succeeded'||cp.phase!=='committed'||(op.result as any)?.candidate_id!==cp.candidate_id||(op.result as any)?.content_hash!==cp.content_hash)return fail('RECOVERY_IDENTITY_CONFLICT');
  const m=readCandidateManifest(cp.candidate_id);verifyCandidateFiles(cp.candidate_id,m);
  if(operationJson(cp.files)!==operationJson([...candidateFiles(m),{file:'manifest.json',sha256:cp.manifest_sha256}]))return fail('RECOVERY_IDENTITY_CONFLICT');
  if(m.task_id!==request.task_id||operationJson(m.content_token)!==operationJson(request.base_content)||m.content_hash!==cp.content_hash||readCandidate(cp.candidate_id).manifest_sha256!==cp.manifest_sha256)return fail('RECOVERY_IDENTITY_CONFLICT');
  return {request,checkpoint:cp,committed:readCandidate(cp.candidate_id)};
 }
 if(op.state==='succeeded'||cp.phase==='committed')return fail('RECOVERY_IDENTITY_CONFLICT');
 return {request,checkpoint:cp,committed:null};
}
export function recoverPreparedCandidate(operationId:string,signal?:AbortSignal):CandidateRecord {
 const {request,checkpoint:cp,committed}=inspectCandidateRecovery(operationId);if(committed)return committed;
 if(!cp||cp.phase!=='prepared')return fail('RECOVERY_INCOMPLETE');
 abort(signal);if(readOperation(operationId).state==='cancelled')throw new JobCancelledError();
 const task=readTaskRecord(request.task_id);
 const assertBase=()=>{if(operationJson(readDraftContent(task.context).token)!==operationJson(request.base_content))fail('INPUT_IDENTITY_CONFLICT');if(readTaskRecord(task.id).state==='cancelled')fail('TASK_CANCELLED');};
 assertBase();
 const directory=existsSync(cp.final_directory)?cp.final_directory:cp.staging_directory;
 if(existsSync(cp.final_directory)&&existsSync(cp.staging_directory))return fail('RECOVERY_IDENTITY_CONFLICT');
 for(const entry of cp.files){if(isAbsolute(entry.file)||entry.file.includes('\\')||entry.file.split('/').some(x=>!x||x==='.'||x==='..'))fail('RECOVERY_IDENTITY_CONFLICT');const path=join(directory,entry.file);if(!existsSync(path)||fileHash(path)!==entry.sha256)fail('ARTIFACT_INTEGRITY_CONFLICT');}
 const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')) as CandidateManifest;
 if(!validManifest(manifest)||manifest.candidate_id!==cp.candidate_id||manifest.task_id!==task.id||manifest.brief_version!==task.brief_version||manifest.content_hash!==cp.content_hash||candidateContentHash(manifest)!==manifest.content_hash||candidatePlaybackHash(manifest)!==manifest.playback_hash||fileHash(join(directory,'manifest.json'))!==cp.manifest_sha256||operationJson(manifest.content_token)!==operationJson(request.base_content)||operationJson(cp.files)!==operationJson([...candidateFiles(manifest),{file:'manifest.json',sha256:cp.manifest_sha256}]))return fail('RECOVERY_IDENTITY_CONFLICT');
 if(directory!==cp.final_directory)renameSync(directory,cp.final_directory);
 db.transaction(()=>{
  abort(signal);if(readOperation(operationId).state==='cancelled')throw new JobCancelledError();assertBase();
  const current=readTaskRecord(task.id),id=cp.candidate_id;
  db.query(`INSERT INTO candidates(id,task_id,parent_candidate_id,brief_version,content_revision,content_token_hash,content_hash,playback_hash,compositor_hash,manifest_path,manifest_sha256,manifest_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,task.id,manifest.parent_candidate_id,manifest.brief_version,manifest.content_token.revision,manifest.content_token.hash,manifest.content_hash,manifest.playback_hash,manifest.compositor_hash,join(cp.final_directory,'manifest.json'),cp.manifest_sha256,operationJson(manifest),Date.now());
  const insert=db.query(`INSERT INTO candidate_frames(candidate_id,frame_id,source_frame_id,source_index,sequence_index,duration_num,duration_den,duration_origin,raw_sha256,mask_version_id,mask_sha256,png_sha256,content_hash,files_json,resolved_transform_json,resolved_root_json,source_to_canvas_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const f of manifest.frames)insert.run(id,f.frame_id,f.source_frame_id,f.source_index,f.sequence_index,f.duration.num,f.duration.den,f.duration_origin,f.raw_sha256,f.mask_version_id,f.mask_sha256,f.png_sha256,f.content_hash,operationJson(f.files),operationJson(f.resolved_transform),operationJson(f.resolved_root),operationJson(f.source_to_canvas));
  writeOperationCheckpoint(operationId,{...cp,phase:'committed'});
  db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson({candidate_id:id,content_hash:manifest.content_hash}),Date.now(),operationId);
  db.query('UPDATE collab_tasks SET operation_ids_json=?,updated_at=? WHERE id=?').run(operationJson([...new Set([...current.operation_ids,operationId])]),Date.now(),task.id);
  finishCandidateTaskAttempt(task.id,operationId,'checking');
 }).immediate();return readCandidate(cp.candidate_id);
}
