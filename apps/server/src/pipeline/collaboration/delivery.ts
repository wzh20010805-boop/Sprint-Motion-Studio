import {Ajv} from 'ajv';
import {createHash} from 'node:crypto';
import {acceptanceCheckpointSchema,deliveryOperationInputSchema,deliveryResultSchema} from '@framebaker/shared';
import type {AcceptanceCheckpoint,ActionExportResolution,DeliveryCheckpoint,DeliveryOperationInput,DeliveryRequest,DeliveryResult,WorkContext} from '@framebaker/shared';
import {copyFileSync,existsSync,mkdirSync,readFileSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {db,STORAGE_ROOT,uid} from '../../db';
import {JobCancelledError} from '../../jobs/run';
import {fileHash} from '../alignment';
import {runImageWorker} from '../masks';
import {checkCancelled,runPipelineCommand} from '../probe';
import {PipelineError} from '../service';
import {candidateFilePath,readCandidate,readCandidateManifest,verifyCandidateFiles} from './candidates';
import {collaborationHash,operationJson,readOperation,readOperationInput} from './operations';
import {reviewTransaction} from './reviewBoundary';
import {readReviewState,withAcceptedDelivery} from './reviews';
import {requireCandidateSelfCheck} from './samplingStore';
import {axisWorkflowMode,readTaskRecord} from './store';

const ajv=new Ajv({strict:true});
const validInput=ajv.compile<DeliveryOperationInput>(deliveryOperationInputSchema),validCheckpoint=ajv.compile<AcceptanceCheckpoint>(acceptanceCheckpointSchema),validResult=ajv.compile<DeliveryResult>(deliveryResultSchema);
const fail=(code:string,message=code):never=>{throw new PipelineError(code,message,409);};

/** 只读原始负载；调度信封不参与负载 hash，也不能由当前 Task 重建。 */
export function readDeliveryRequest(operationId:string):DeliveryRequest {
 const op=readOperation(operationId);if(op.base_content!==null)return fail('DELIVERY_IDENTITY_INVALID');
 const input=readOperationInput(operationId,'deliver_candidate');
 if(!validInput(input)||op.base_content!==null||!validCheckpoint(op.checkpoint)||operationJson(op.checkpoint.snapshot)!==operationJson(input.snapshot))return fail('DELIVERY_IDENTITY_INVALID');
 if(input.snapshot.task_id!==input.task_id||input.snapshot.candidate_id!==input.candidate_id||input.snapshot.acceptance_epoch!==input.acceptance_epoch)return fail('DELIVERY_IDENTITY_INVALID');
 return {task_id:input.task_id,candidate_id:input.candidate_id,acceptance_epoch:input.acceptance_epoch,operation_id:op.id};
}
export function readDelivery(id:string):DeliveryResult {
 const request=readDeliveryRequest(id),op=readOperation(id);
 if(op.state!=='succeeded'||!validResult(op.result)||(op.checkpoint as unknown as AcceptanceCheckpoint).delivery?.phase!=='committed')return fail('DELIVERY_NOT_COMMITTED');
 const input=readOperationInput(id,'deliver_candidate') as DeliveryOperationInput,result=op.result;
 if(result.delivery_id!==id||result.operation_id!==id||result.task_id!==request.task_id||result.candidate_id!==request.candidate_id||result.acceptance_epoch!==request.acceptance_epoch||result.manifest_sha256!==input.snapshot.manifest_sha256||result.content_hash!==input.snapshot.content_hash||result.playback_hash!==input.snapshot.playback_hash)return fail('DELIVERY_IDENTITY_INVALID');
 if(result.directory!==join(STORAGE_ROOT,'deliveries',id))return fail('DELIVERY_PATH_INVALID');
 return result;
}
/** 旧 renderer 永不消费协作接受；即便已接受，也必须走固定候选。 */
export function assertFormalExportAllowed(context:WorkContext,_candidateId?:string):void {
 if(axisWorkflowMode(context)==='collaboration')fail('IMMUTABLE_DELIVERY_REQUIRED','协作动作必须交付已验收的固定候选；旧渲染导出不可用');
}
function child(root:string,file:string):string {
 if(isAbsolute(file)||file.includes('\\')||file.split('/').some(p=>!p||p==='.'||p==='..'))return fail('DELIVERY_PATH_INVALID');
 const path=resolve(root,file),rel=relative(resolve(root),path);
 if(rel.startsWith('..')||isAbsolute(rel))return fail('DELIVERY_PATH_INVALID');
 if(existsSync(path)){const real=relative(realpathSync(root),realpathSync(path));if(real.startsWith('..')||isAbsolute(real))return fail('DELIVERY_PATH_INVALID');}
 return path;
}
export function deliveryFilePath(id:string,file:string):string {
 const result=readDelivery(id),cp=(readOperation(id).checkpoint as unknown as AcceptanceCheckpoint).delivery;
 const entry=cp?.files.find(x=>x.file===file);if(!entry)return fail('DELIVERY_FILE_NOT_FOUND');
 const path=child(result.directory,file);if(!existsSync(path)||fileHash(path)!==entry.sha256)return fail('DELIVERY_FILE_CHANGED');return path;
}
export async function resolveActionExport(context:WorkContext & {task_id?:string},format:string):Promise<ActionExportResolution> {
 if(!['sequence','png_sequence','spritesheet'].includes(format))return fail('INVALID_EXPORT_FORMAT');
 const mode=axisWorkflowMode(context);
 const tasks=db.query('SELECT id FROM collab_tasks WHERE project_id=? AND axis_id=? ORDER BY id').all(context.project_id,context.axis_id) as {id:string}[];
 if(context.task_id&&!tasks.some(task=>task.id===context.task_id))return fail('TASK_CONTEXT_MISMATCH');
 if(mode==='legacy')return {mode:'legacy'};
 if(!context.task_id&&tasks.length>1)return {mode:'ambiguous',task_ids:tasks.map(x=>x.id)};
 if(!tasks.length)return fail('ACCEPTED_CANDIDATE_REQUIRED');
 const task=readTaskRecord(context.task_id??tasks[0]!.id);if(!task.selected_candidate_id)return fail('ACCEPTED_CANDIDATE_REQUIRED');
 const m=readCandidateManifest(task.selected_candidate_id),requested=format==='sequence'?'png_sequence':format;
 if(!m.output.formats.includes(requested as 'png_sequence'|'spritesheet'))return fail('NEW_CANDIDATE_REQUIRED','此格式未在候选中固定，请声明新候选');
 const review=readReviewState(m.candidate_id);if(!review.accepted||!review.pending_delivery_operation_id)return fail('ACCEPTED_CANDIDATE_REQUIRED');
 const result=readDelivery(review.pending_delivery_operation_id);if(result.approval_status!=='approved')return fail('ACCEPTED_CANDIDATE_REQUIRED');
 // 序列下载完整已校验包；图集逐页下载原文件，不重新打包、裁切或编码。
 const files=requested==='png_sequence'?['assets.zip']:m.sheets.map(x=>x.file);
 return {mode:'candidate',candidate_id:m.candidate_id,delivery_id:result.delivery_id,files:files.map(file=>({file,url:`/api/v1/deliveries/${result.delivery_id}/file?path=${encodeURIComponent(file)}`}))};
}

export interface DeliveryHooks {
 /** prepared 可异步设置可控屏障；moved 在同步审核事务内，只允许同步观察。 */
 onPhase?:(phase:'copied'|'packaging'|'prepared'|'moved'|'committed',checkpoint:DeliveryCheckpoint)=>void|Promise<void>;
}
const executing=new Map<string,Promise<DeliveryResult>>();
export function packageAcceptedCandidate(request:DeliveryRequest,signal?:AbortSignal,progress?:(text:string)=>void,hooks:DeliveryHooks={}):Promise<DeliveryResult> {
 try{if(operationJson(readDeliveryRequest(request.operation_id))!==operationJson(request))return Promise.reject(new PipelineError('DELIVERY_IDENTITY_INVALID','DELIVERY_IDENTITY_INVALID',409));}catch(e){return Promise.reject(e);}
 const active=executing.get(request.operation_id);if(active)return active;
 const promise=packageOnce(request,signal,progress,hooks);executing.set(request.operation_id,promise);void promise.finally(()=>executing.delete(request.operation_id)).catch(()=>{});return promise;
}
async function packageOnce(request:DeliveryRequest,signal:AbortSignal|undefined,progress:((text:string)=>void)|undefined,hooks:DeliveryHooks):Promise<DeliveryResult> {
 const original=readOperation(request.operation_id);if(original.state==='succeeded')return readDelivery(original.id);
 checkCancelled(signal);
 const input=readOperationInput(original.id,'deliver_candidate') as DeliveryOperationInput;
 const attempt=uid(),staging=join(STORAGE_ROOT,'staging','delivery',original.id,attempt),directory=join(STORAGE_ROOT,'deliveries',original.id);
 const checkpoint:DeliveryCheckpoint={version:1,phase:'packaging',operation_id:original.id,delivery_id:original.id,attempt_id:attempt,job_id:original.attempt_job_ids.at(-1)??null,staging_directory:staging,final_directory:directory,manifest_sha256:input.snapshot.manifest_sha256,content_hash:input.snapshot.content_hash,playback_hash:input.snapshot.playback_hash,files:[]};
 const save=(phase:DeliveryCheckpoint['phase'])=>{checkpoint.phase=phase;const current=readOperation(original.id),cp=current.checkpoint as unknown as AcceptanceCheckpoint;if(current.state==='succeeded')return fail('DELIVERY_ALREADY_COMMITTED');db.query('UPDATE collab_operations SET checkpoint_json=?,updated_at=? WHERE id=?').run(operationJson({...cp,delivery:checkpoint}),Date.now(),original.id);};
 withAcceptedDelivery(request,()=>{if((original.checkpoint as unknown as AcceptanceCheckpoint).delivery)return fail('OPERATION_NEEDS_RECOVERY');save('packaging');db.query("UPDATE collab_operations SET state='running' WHERE id=?").run(original.id);db.query("UPDATE collab_tasks SET state='packaging' WHERE id=?").run(request.task_id);});
 try {
  if(existsSync(staging)||existsSync(directory))return fail('DELIVERY_DIRECTORY_EXISTS');
  mkdirSync(staging,{recursive:true});
  const m=readCandidateManifest(request.candidate_id);verifyCandidateFiles(m.candidate_id,m);
  const self=requireCandidateSelfCheck(m.candidate_id),selfHash=collaborationHash(self);
  const payload=[...m.frames.map(f=>({file:f.files.png,sha256:f.png_sha256})),...m.sheets,...m.auxiliary_files.filter(x=>x.file.startsWith('previews/'))];
  // 固定文件来自候选身份；生成文档来自即将写入的确定字节，不能在异步归档后重新采信磁盘。
  const expected:Record<string,string>=Object.fromEntries(payload.map(x=>[x.file,x.sha256]));
  expected['candidate-manifest.json']=input.snapshot.manifest_sha256;
  const writeExpected=(file:string,bytes:string)=>{expected[file]=createHash('sha256').update(bytes).digest('hex');writeFileSync(child(staging,file),bytes);};
  const inventory=()=>Object.entries(expected).map(([file,sha256])=>({file,sha256}));
  const verifyExpected=()=>{for(const entry of inventory())if(fileHash(child(staging,entry.file))!==entry.sha256)fail('DELIVERY_FILE_CHANGED');};
  const saveExpected=()=>{checkpoint.files=inventory();reviewTransaction(()=>save('packaging'));const observed=hooks.onPhase?.('packaging',checkpoint);if(observed&&typeof observed.then==='function')fail('ASYNC_PACKAGING_OBSERVER');};
  progress?.('复制已验收的固定帧与图集');
  for(const entry of payload){checkCancelled(signal);const destination=child(staging,entry.file);mkdirSync(dirname(destination),{recursive:true});copyFileSync(candidateFilePath(m.candidate_id,entry.file),destination);if(fileHash(destination)!==entry.sha256)fail('DELIVERY_FILE_CHANGED');}
  await hooks.onPhase?.('copied',checkpoint);
  copyFileSync(readCandidate(m.candidate_id).manifest_path,join(staging,'candidate-manifest.json'));
  writeExpected('manifest.json',operationJson({schema_version:'1.0',delivery_id:original.id,operation_id:original.id,acceptance_snapshot:input.snapshot,candidate:m,coordinate_system:'top-left-x-right-y-down-pixel-edges',canvas:m.alignment.canvas,anchor_pixels:m.alignment.anchor,grid:m.grid,frames:m.frames,sheets:m.sheets}));
  writeExpected('quality-report.json',operationJson({schema_version:'1.0',technical_check:self.technical_check,self_check:self,acceptance_snapshot:input.snapshot,visual_scope:'sampled; unviewed and uncovered facts are not visual approval'}));
  writeExpected('README_COCOS_3.8.8.md','# Cocos Creator 3.8.8\n\nCopy frozen PNG frames in manifest sequence order. Preserve rational duration, common canvas, anchor and grid rectangles. Candidate manifest is immutable. Preview is auxiliary, not transparent game input. Current approval status must be read from the delivery service; later withdrawal retains this historical package.\n');
  if(m.output.formats.includes('preview_mp4')){
   mkdirSync(join(staging,'previews'),{recursive:true});const list=join(staging,'previews','timing.ffconcat');
   writeExpected('previews/timing.ffconcat',m.frames.map(f=>`file '../${f.files.png}'\nduration ${(f.duration.num/f.duration.den).toFixed(12)}`).join('\n')+`\nfile '../${m.frames.at(-1)!.files.png}'\n`);saveExpected();
   const preview='previews/preview-on-background.mp4';await runPipelineCommand(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','concat','-safe','0','-i',list,'-vf','format=rgb24,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=0x261a3d','-fps_mode','vfr','-t',String(m.frames.reduce((n,f)=>n+f.duration.num/f.duration.den,0)),'-c:v','libx264','-pix_fmt','yuv420p',join(staging,preview)],signal);expected[preview]=fileHash(join(staging,preview));
  }
  const checksums={...expected};writeExpected('checksums.json',operationJson(checksums));saveExpected();verifyExpected();
  await runImageWorker({action:'archive',directory:staging,files:Object.keys(expected)},join(staging,'archive-worker'),signal);
  verifyExpected();
  // 校验 ZIP 内的每个条目，防止归档时篡改输入、事后恢复松散文件；校验过程仍在事务外。
  const verified=await runImageWorker({action:'verify_archive',directory:staging,files:expected},join(staging,'verify-archive-worker'),signal);
  if(typeof verified.archive_sha256!=='string'||!/^[a-f0-9]{64}$/.test(verified.archive_sha256)||operationJson(verified.files)!==operationJson(expected))fail('DELIVERY_ARCHIVE_CHANGED');
  const archive_sha256:string=verified.archive_sha256;
  checkpoint.files=[...inventory(),{file:'assets.zip',sha256:archive_sha256}];
  reviewTransaction(()=>save('prepared'));await hooks.onPhase?.('prepared',checkpoint);checkCancelled(signal);
  const result=withAcceptedDelivery(request,()=>{
   checkCancelled(signal);verifyCandidateFiles(m.candidate_id);if(collaborationHash(requireCandidateSelfCheck(m.candidate_id))!==selfHash)fail('DELIVERY_QA_CHANGED');
   for(const entry of [...payload,...checkpoint.files])if(fileHash(child(staging,entry.file))!==entry.sha256)fail('DELIVERY_FILE_CHANGED');
   if(fileHash(join(staging,'candidate-manifest.json'))!==input.snapshot.manifest_sha256)fail('DELIVERY_FILE_CHANGED');
   // 路径必须留在工作区内，目标必须不存在；rename 后未提交目录只是保留证据。
   for(const path of [staging,directory]){const rel=relative(realpathSync(STORAGE_ROOT),resolve(path));if(rel.startsWith('..')||isAbsolute(rel))fail('DELIVERY_PATH_INVALID');}
   mkdirSync(dirname(directory),{recursive:true});if(existsSync(directory))fail('DELIVERY_DIRECTORY_EXISTS');renameSync(staging,directory);
   const moved=hooks.onPhase?.('moved',checkpoint);if(moved&&typeof moved.then==='function')fail('ASYNC_REVIEW_TRANSACTION');
   const result:DeliveryResult={delivery_id:original.id,operation_id:original.id,task_id:request.task_id,candidate_id:m.candidate_id,acceptance_epoch:request.acceptance_epoch,approval_status:'approved',directory,committed_at:Date.now(),review_revision:readCandidate(m.candidate_id).review_revision,manifest_sha256:input.snapshot.manifest_sha256,content_hash:m.content_hash,playback_hash:m.playback_hash,checksums,archive_sha256};
   save('committed');db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson(result),Date.now(),original.id);db.query("UPDATE collab_tasks SET state='delivered',updated_at=? WHERE id=?").run(Date.now(),request.task_id);return result;
  });
  await hooks.onPhase?.('committed',checkpoint);return result;
 }catch(error){
  if(readOperation(original.id).state==='succeeded')return readDelivery(original.id);
  reviewTransaction(()=>{db.query("UPDATE collab_operations SET state=?,updated_at=? WHERE id=? AND state!='succeeded'").run(signal?.aborted||error instanceof JobCancelledError?'cancelled':'failed',Date.now(),original.id);});throw error;
 }
}

/** 检查原归属和可信预期清单；未完成目录不能自行成为发布事实。 */
export async function recoverAcceptedDelivery(operationId:string,signal?:AbortSignal):Promise<DeliveryResult> {
 const request=readDeliveryRequest(operationId),op=readOperation(operationId),input=readOperationInput(operationId,'deliver_candidate') as DeliveryOperationInput;
 const cp=(op.checkpoint as unknown as AcceptanceCheckpoint).delivery;
 if(cp&&(cp.operation_id!==op.id||cp.delivery_id!==op.id||cp.final_directory!==join(STORAGE_ROOT,'deliveries',op.id)||cp.staging_directory!==join(STORAGE_ROOT,'staging','delivery',op.id,cp.attempt_id)||cp.job_id!==null&&!op.attempt_job_ids.includes(cp.job_id)||cp.manifest_sha256!==input.snapshot.manifest_sha256||cp.content_hash!==input.snapshot.content_hash||cp.playback_hash!==input.snapshot.playback_hash))return fail('RECOVERY_IDENTITY_CONFLICT');
 if(op.state==='succeeded'){
  const result=readDelivery(operationId);if(!cp)return fail('RECOVERY_IDENTITY_CONFLICT');
  const expected={...result.checksums,'checksums.json':collaborationHash(result.checksums),'assets.zip':result.archive_sha256};
  if(operationJson(Object.fromEntries(cp.files.map(x=>[x.file,x.sha256])))!==operationJson(expected)||cp.files.length!==Object.keys(expected).length)return fail('RECOVERY_IDENTITY_CONFLICT');
  for(const entry of cp.files)deliveryFilePath(operationId,entry.file);
  return result;
 }
 if(op.state==='cancelled')return fail('OPERATION_CANCELLED');
 withAcceptedDelivery(request,()=>{});
 if(!cp)return packageAcceptedCandidate(request,signal);

 if(cp.phase==='packaging')return completePackagingRecovery(request,cp,signal);
 if(cp.phase!=='prepared')return fail('RECOVERY_INCOMPLETE');
 const directory=existsSync(cp.final_directory)?cp.final_directory:cp.staging_directory;
 if(existsSync(cp.final_directory)&&existsSync(cp.staging_directory))return fail('RECOVERY_IDENTITY_CONFLICT');
 const verify=()=>{for(const entry of cp.files){const path=child(directory,entry.file);if(!existsSync(path)||fileHash(path)!==entry.sha256)fail('ARTIFACT_INTEGRITY_CONFLICT');}};
 verify();
 const expected=Object.fromEntries(cp.files.filter(x=>x.file!=='assets.zip').map(x=>[x.file,x.sha256]));
 if(Object.keys(expected).length!==cp.files.length-1||expected['candidate-manifest.json']!==input.snapshot.manifest_sha256)return fail('RECOVERY_IDENTITY_CONFLICT');
 const checksums=JSON.parse(readFileSync(child(directory,'checksums.json'),'utf8')) as Record<string,string>;
 const payloadExpected={...expected};delete payloadExpected['checksums.json'];
 if(operationJson(checksums)!==operationJson(payloadExpected))return fail('RECOVERY_IDENTITY_CONFLICT');
 const m=readCandidateManifest(request.candidate_id);verifyCandidateFiles(m.candidate_id,m);
 for(const entry of [...m.frames.map(f=>({file:f.files.png,sha256:f.png_sha256})),...m.sheets,...m.auxiliary_files.filter(x=>x.file.startsWith('previews/'))])if(expected[entry.file]!==entry.sha256)return fail('RECOVERY_IDENTITY_CONFLICT');
 const qa=JSON.parse(readFileSync(child(directory,'quality-report.json'),'utf8'));
 if(operationJson(qa.self_check)!==operationJson(requireCandidateSelfCheck(m.candidate_id)))return fail('DELIVERY_QA_CHANGED');
 const verified=await runImageWorker({action:'verify_archive',directory,files:expected},join(STORAGE_ROOT,'jobs','verify-recovery-'+uid()),signal);
 const archive=cp.files.find(x=>x.file==='assets.zip')?.sha256;
 if(!archive||verified.archive_sha256!==archive||operationJson(verified.files)!==operationJson(expected))return fail('ARTIFACT_INTEGRITY_CONFLICT');
 return withAcceptedDelivery(request,()=>{
  checkCancelled(signal);if(readOperation(op.id).state==='cancelled')return fail('OPERATION_CANCELLED');verify();verifyCandidateFiles(m.candidate_id);
  if(operationJson(qa.self_check)!==operationJson(requireCandidateSelfCheck(m.candidate_id)))return fail('DELIVERY_QA_CHANGED');
  if(directory!==cp.final_directory){mkdirSync(dirname(cp.final_directory),{recursive:true});renameSync(directory,cp.final_directory);}
  const result:DeliveryResult={delivery_id:op.id,operation_id:op.id,task_id:request.task_id,candidate_id:request.candidate_id,acceptance_epoch:request.acceptance_epoch,approval_status:'approved',directory:cp.final_directory,committed_at:Date.now(),review_revision:readCandidate(m.candidate_id).review_revision,manifest_sha256:cp.manifest_sha256,content_hash:cp.content_hash,playback_hash:cp.playback_hash,checksums,archive_sha256:archive};
  const current=readOperation(op.id).checkpoint as unknown as AcceptanceCheckpoint;
  db.query("UPDATE collab_operations SET state='succeeded',checkpoint_json=?,result_json=?,updated_at=? WHERE id=?").run(operationJson({...current,delivery:{...cp,phase:'committed'}}),operationJson(result),Date.now(),op.id);
  db.query("UPDATE collab_tasks SET state='delivered',updated_at=? WHERE id=?").run(Date.now(),request.task_id);return result;
 });
}

/** 部分辅助输出只消费持久预期字节，不能从现存文件重建预期 hash。 */
async function completePackagingRecovery(request:DeliveryRequest,cp:DeliveryCheckpoint,signal?:AbortSignal):Promise<DeliveryResult> {
 const directory=cp.staging_directory,m=readCandidateManifest(request.candidate_id),expected=Object.fromEntries(cp.files.map(x=>[x.file,x.sha256]));
 if(existsSync(cp.final_directory)||!existsSync(directory)||Object.keys(expected).length!==cp.files.length||!['manifest.json','quality-report.json','candidate-manifest.json','README_COCOS_3.8.8.md'].every(x=>expected[x]))return fail('RECOVERY_INCOMPLETE');
 const verify=()=>{for(const [file,sha] of Object.entries(expected)){const path=child(directory,file);if(!existsSync(path)||fileHash(path)!==sha)fail('ARTIFACT_INTEGRITY_CONFLICT');}};verify();
 withAcceptedDelivery(request,()=>{});verifyCandidateFiles(m.candidate_id,m);
 const preview='previews/preview-on-background.mp4';
 if(m.output.formats.includes('preview_mp4')&&!expected[preview]){
  if(!expected['previews/timing.ffconcat']||existsSync(child(directory,preview)))return fail('RECOVERY_INCOMPLETE');
  await runPipelineCommand(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','concat','-safe','0','-i',child(directory,'previews/timing.ffconcat'),'-vf','format=rgb24,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=0x261a3d','-fps_mode','vfr','-t',String(m.frames.reduce((n,f)=>n+f.duration.num/f.duration.den,0)),'-c:v','libx264','-pix_fmt','yuv420p',child(directory,preview)],signal);
  verify();expected[preview]=fileHash(child(directory,preview));
 }
 if(!expected['checksums.json']){
  const bytes=operationJson(expected),path=child(directory,'checksums.json');if(existsSync(path))return fail('RECOVERY_INCOMPLETE');
  expected['checksums.json']=createHash('sha256').update(bytes).digest('hex');writeFileSync(path,bytes,{flag:'wx'});
 }
 const save=(phase:'packaging'|'prepared')=>withAcceptedDelivery(request,()=>{const op=readOperation(request.operation_id);if(op.state==='cancelled')return fail('OPERATION_CANCELLED');const ac=op.checkpoint as unknown as AcceptanceCheckpoint;db.query('UPDATE collab_operations SET checkpoint_json=?,updated_at=? WHERE id=?').run(operationJson({...ac,delivery:{...cp,phase,files:Object.entries(expected).map(([file,sha256])=>({file,sha256}))}}),Date.now(),op.id);});
 save('packaging');verify();
 if(!existsSync(child(directory,'assets.zip')))await runImageWorker({action:'archive',directory,files:Object.keys(expected)},join(STORAGE_ROOT,'jobs','archive-recovery-'+uid()),signal);
 const verified=await runImageWorker({action:'verify_archive',directory,files:expected},join(STORAGE_ROOT,'jobs','verify-recovery-'+uid()),signal);
 verify();if(typeof verified.archive_sha256!=='string'||!/^[a-f0-9]{64}$/.test(verified.archive_sha256)||operationJson(verified.files)!==operationJson(expected))return fail('ARTIFACT_INTEGRITY_CONFLICT');
 expected['assets.zip']=verified.archive_sha256;save('prepared');return recoverAcceptedDelivery(request.operation_id,signal);
}
