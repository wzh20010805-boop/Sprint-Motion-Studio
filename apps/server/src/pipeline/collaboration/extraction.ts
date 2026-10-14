import type {ActorContext,ContentToken,OperationRecord,SourceTiming,VideoProbe} from '@framebaker/shared';
import {existsSync,readFileSync,renameSync} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {db,STORAGE_ROOT,uid} from '../../db';
import {requireCurrentMaker} from '../../localSessions';
import {fileHash} from '../alignment';
import {extractSource,getClip,getSource,PipelineError,prepareSourceExtraction,requireVideoSource,type SourceExtractPayload,type ExtractionCell} from '../service';
import {makeSourceTiming} from '../extractAll';
import {claimOperation,collaborationHash,operationJson,readOperation,readOperationInput,writeOperationCheckpoint,resumeCollaborationOperation} from './operations';
interface ExtractionInput {payload:SourceExtractPayload;source_sha256:string;probe:VideoProbe;base_content:ContentToken}
export interface ExtractionCheckpoint {version:1;operation_id:string;attempt_id:string;job_id:string|null;phase:'extracting'|'prepared'|'raw_renamed'|'timing_renamed'|'copying'|'committed';stage:string|null;timing:SourceTiming|null;files:{file:string;sha256:string}[];cells:ExtractionCell[]}
export interface ExtractionHooks {onCheckpoint?:(phase:string,checkpoint:ExtractionCheckpoint,index?:number)=>void}
const fail=(code:string):never=>{throw new PipelineError(code,code,409);};
/** 重复请求先找原操作，不再用已编辑动作重新准备或清空基础。 */
export async function startSourceExtraction(projectId:string,clipId:string,baseRevision:number|undefined,request_key:string,actor:ActorContext):Promise<OperationRecord>{
 requireCurrentMaker(actor);const saved=db.query('SELECT id,kind FROM collab_operations WHERE request_key=?').get(request_key) as {id:string;kind:string}|null;
 if(saved){if(saved.kind!=='extract_source')return fail('REQUEST_CONFLICT');const input=readOperationInput(saved.id,'extract_source') as ExtractionInput;if(input.payload.projectId!==projectId||input.payload.clipId!==clipId||baseRevision!==undefined&&input.payload.baseRevision!==baseRevision)return fail('REQUEST_CONFLICT');return resumeCollaborationOperation(saved.id,actor);}
 const op=prepareExtractionOperation(prepareSourceExtraction(projectId,clipId,baseRevision),{request_key},actor);return resumeCollaborationOperation(op.id,actor);
}
/** 显式稳定请求入口；旧 sourceExtract 调用仍保留旧兼容语义。 */
export function prepareExtractionOperation(payload:SourceExtractPayload,request:{request_key:string},actor:ActorContext):OperationRecord {
 requireCurrentMaker(actor);const source=requireVideoSource(getSource(payload.projectId,payload.sourceId));
 const input:ExtractionInput={payload,source_sha256:source.sha256,probe:source.probe,base_content:{revision:payload.baseRevision,hash:collaborationHash({payload,source_sha256:source.sha256,probe:source.probe})}};
 return claimOperation('extract_source',request,input);
}
export function inspectExtractionOperation(id:string):{input:ExtractionInput;checkpoint:ExtractionCheckpoint|null;committed:boolean} {
 const op=readOperation(id),input=readOperationInput(id,'extract_source') as ExtractionInput;
 if(!input?.payload||input.base_content?.revision!==input.payload.baseRevision||input.base_content.hash!==collaborationHash({payload:input.payload,source_sha256:input.source_sha256,probe:input.probe}))return fail('RECOVERY_IDENTITY_CONFLICT');
 const cp=op.checkpoint as unknown as ExtractionCheckpoint|null;
 if(cp){
  if(cp.version!==1||cp.operation_id!==id||!['extracting','prepared','raw_renamed','timing_renamed','copying','committed'].includes(cp.phase)||typeof cp.attempt_id!=='string'||!Array.isArray(cp.files)||!Array.isArray(cp.cells)||cp.job_id!==null&&!op.attempt_job_ids.includes(cp.job_id))return fail('RECOVERY_IDENTITY_CONFLICT');
  const directory=join(STORAGE_ROOT,'sources',input.payload.sourceId);
  if(cp.stage!==null&&(dirname(cp.stage)!==directory||!cp.stage.startsWith(join(directory,'staging-'))))return fail('RECOVERY_IDENTITY_CONFLICT');
  if(cp.timing&&operationJson(cp.timing)!==operationJson(makeSourceTiming(input.payload.sourceId,input.probe)))return fail('RECOVERY_IDENTITY_CONFLICT');
  const frameIds=new Set<string>(),stepIds=new Set<string>();
  for(const [index,cell] of cp.cells.entries()){
   if(!cell||!cp.timing||operationJson(cell.frame)!==operationJson(cp.timing.frames[index])||!Number.isSafeInteger(cell.ticks)||cell.ticks<1||typeof cell.frameId!=='string'||typeof cell.stepId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(cell.frameId)||!/^[a-zA-Z0-9_-]+$/.test(cell.stepId)||frameIds.has(cell.frameId)||stepIds.has(cell.stepId)||dirname(dirname(cell.path))!==join(STORAGE_ROOT,'projects',input.payload.projectId,'raw',input.payload.clipId)||basename(cell.path)!==basename(cell.frame.file))return fail('RECOVERY_IDENTITY_CONFLICT');frameIds.add(cell.frameId);stepIds.add(cell.stepId);
  }
  if(cp.cells.length&&cp.cells.length!==input.probe.frames.length)return fail('RECOVERY_IDENTITY_CONFLICT');
  if(cp.phase==='committed'){
   if(op.state!=='succeeded'||!op.result||(op.result as any).source_id!==input.payload.sourceId||(op.result as any).clip_id!==input.payload.clipId||(op.result as any).frame_count!==cp.cells.length||cp.cells.length!==input.probe.frames.length)return fail('RECOVERY_IDENTITY_CONFLICT');
   for(const entry of cp.files){const path=join(directory,entry.file);if(!existsSync(path)||fileHash(path)!==entry.sha256)return fail('ARTIFACT_INTEGRITY_CONFLICT');}
   // 主轨插入与原操作/检查点/结果原子提交；之后的编辑投影可移动或删除，不能否定历史提交。
   // 这里只验证原提交身份和源文件，未提交恢复仍须通过下方原输入及投影校验。
   return {input,checkpoint:cp,committed:true};
  }
 }
 if(op.state==='succeeded')return fail('RECOVERY_IDENTITY_CONFLICT');
 const source=requireVideoSource(getSource(input.payload.projectId,input.payload.sourceId)),clip=getClip(input.payload.projectId,input.payload.clipId);
 if(source.sha256!==input.source_sha256||fileHash(source.original_path)!==input.source_sha256||operationJson(source.probe)!==operationJson(input.probe)||clip.source_id!==input.payload.sourceId||clip.revision!==input.payload.baseRevision)return fail('INPUT_IDENTITY_CONFLICT');
 return {input,checkpoint:cp,committed:false};
}
export async function executeExtractionOperation(id:string,signal?:AbortSignal,progress?:(text:string)=>void,hooks:ExtractionHooks={}):Promise<unknown> {
 const inspected=inspectExtractionOperation(id);if(inspected.committed)return readOperation(id).result;
 const {input}=inspected,op=readOperation(id);if(op.state==='cancelled')return fail('OPERATION_CANCELLED');
 const cp:ExtractionCheckpoint=inspected.checkpoint??{version:1,operation_id:id,attempt_id:uid(),job_id:op.attempt_job_ids.at(-1)??null,phase:'extracting',stage:null,timing:null,files:[],cells:[]};
 const save=()=>{if(readOperation(id).state==='cancelled')return fail('OPERATION_CANCELLED');writeOperationCheckpoint(id,cp);};
 const directory=join(STORAGE_ROOT,'sources',input.payload.sourceId);
 let verifiedTiming:SourceTiming|undefined;
 if(cp.timing){
  if(operationJson(cp.timing)!==operationJson(makeSourceTiming(input.payload.sourceId,input.probe)))return fail('RECOVERY_IDENTITY_CONFLICT');
  const required=[...cp.timing.frames.map(f=>f.file),'timing.json'];if(operationJson(cp.files.map(f=>f.file))!==operationJson(required))return fail('RECOVERY_IDENTITY_CONFLICT');
  for(const entry of cp.files){const final=join(directory,entry.file),staged=cp.stage?join(cp.stage,entry.file):null;const path=existsSync(final)?final:staged;if(!path||!existsSync(path)||fileHash(path)!==entry.sha256)return fail('ARTIFACT_INTEGRITY_CONFLICT');if(staged&&existsSync(final)&&existsSync(staged))return fail('RECOVERY_IDENTITY_CONFLICT');}
  if(!existsSync(join(directory,'raw'))){if(!cp.stage)return fail('RECOVERY_INCOMPLETE');renameSync(join(cp.stage,'raw'),join(directory,'raw'));}
  if(!existsSync(join(directory,'timing.json'))){if(!cp.stage)return fail('RECOVERY_INCOMPLETE');renameSync(join(cp.stage,'timing.json'),join(directory,'timing.json'));}
  verifiedTiming=cp.timing;
 }else if(cp.phase!=='extracting')return fail('RECOVERY_INCOMPLETE');
 db.query("UPDATE collab_operations SET state='running',updated_at=? WHERE id=? AND state!='cancelled'").run(Date.now(),id);save();
 try{return await extractSource(input.payload,progress,signal,{
  verifiedTiming,cells:cp.cells.length?cp.cells:undefined,
  onArtifacts(phase,stage,timing,probe){if(operationJson(probe)!==operationJson(input.probe))return fail('INPUT_IDENTITY_CONFLICT');cp.phase=phase;cp.stage=stage;cp.timing=timing;if(phase==='prepared')cp.files=[...timing.frames.map(f=>f.file),'timing.json'].map(file=>({file,sha256:fileHash(join(stage,file))}));save();hooks.onCheckpoint?.(phase,cp);},
  onCells(cells){if(!cp.timing){cp.timing=makeSourceTiming(input.payload.sourceId,input.probe);cp.files=[...cp.timing.frames.map(f=>f.file),'timing.json'].map(file=>({file,sha256:fileHash(join(directory,file))}));}cp.phase='copying';cp.cells=cells;save();},
  onCheckpoint(phase,index){hooks.onCheckpoint?.(phase,cp,index);},
  beforeCommit(){if(readOperation(id).state==='cancelled'||signal?.aborted)return fail('OPERATION_CANCELLED');inspectExtractionOperation(id);},
  commit(result){cp.phase='committed';save();db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson(result),Date.now(),id);}
 });}catch(error){if(readOperation(id).state!=='succeeded')db.query("UPDATE collab_operations SET state=CASE WHEN state='cancelled' THEN state ELSE 'needs_input' END,result_json=?,updated_at=? WHERE id=?").run(operationJson({error_code:error instanceof PipelineError?error.code:'EXTRACTION_FAILED'}),Date.now(),id);throw error;}
}
