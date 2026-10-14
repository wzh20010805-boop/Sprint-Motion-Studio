import {invalidateAcceptance} from './reviewBoundary';
import {verifiedTaskBrief} from './brief';
import { Ajv } from 'ajv';
import { taskBriefSchema, taskTimingSchema } from '@framebaker/shared';
import { join } from 'node:path';
import type { ActorContext, ContentToken, DraftContent, DraftFrame, DurationOrigin, RequestIdentity, TaskBrief, WorkContext } from '@framebaker/shared';
import { db, STORAGE_ROOT } from '../../db';
import { requireRole } from '../../localSessions';
import { fileHash, saveTaskAlignment } from '../alignment';
import { invalidateProjectUndo } from '../../undo';
import { maskState } from '../masks';
import { getProject, getSource, PipelineError, validateId } from '../service';
import { createTaskRecord, readTaskRecord } from './store';
import { claimOperation, collaborationHash, operationJson } from './operations';
import { draftState, rational, retimeAxisFps, saveDraftState } from './timing';

const ajv=new Ajv({strict:true,allErrors:true});
const validTiming=ajv.compile(taskTimingSchema),validBrief=ajv.compile<TaskBrief>(taskBriefSchema);

export function draftAxis(context:WorkContext) {
  getProject(context.project_id);validateId(context.axis_id);
  const axis=db.query('SELECT * FROM animation_axes WHERE id=? AND project_id=?').get(context.axis_id,context.project_id) as {id:string;fps:number}|null;
  if(!axis)throw new PipelineError('AXIS_NOT_FOUND','动作不属于当前项目',404);
  return axis;
}
const setting=(key:string)=>{const r=db.query('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|null;return r?JSON.parse(r.value):null;};
export function sourceSelection(context:WorkContext,sourceId:string) {
  const source=getSource(context.project_id,sourceId);
  return source.probe.kind==='png_sequence' ? source.probe.frames : (db.query('SELECT timing_json FROM source_frames WHERE source_id=? ORDER BY source_index').all(sourceId) as {timing_json:string}[]).map(r=>JSON.parse(r.timing_json));
}
export function readDraftContent(context:WorkContext):DraftContent {
  draftAxis(context);const state=draftState(context);
  const saved=setting(`sfs.alignment.${context.project_id}.${context.axis_id}`),preset=setting(`sfs.preset.${context.project_id}`);
  const alignment=saved?{...saved.config,...preset}:null;
  const rows=db.query('SELECT f.*,s.idx sequence_index,s.duration step_duration FROM frames f JOIN animation_tracks t ON t.id=f.track_id JOIN animation_steps s ON s.id=f.step_id WHERE f.project_id=? AND t.axis_id=? AND s.axis_id=? AND t.is_primary=1 ORDER BY s.idx,s.id,f.id').all(context.project_id,context.axis_id,context.axis_id) as any[];
  // 每次读取仅解析一次完整来源；删除制作单元格仍保留源选择和原字节身份。
  const sources=new Map<string,{source:ReturnType<typeof getSource>;frames:any[];byId:Map<string,any>;original_bytes:string}>();
  const loadSource=(id:string)=>{
    let entry=sources.get(id);
    if(!entry){const source=getSource(context.project_id,id),frames=sourceSelection(context,id);entry={source,frames,byId:new Map(frames.map((f:any)=>[f.source_frame_id,f])),original_bytes:fileHash(source.original_path)};sources.set(id,entry);}
    return entry;
  };
  const clip=db.query('SELECT source_id FROM clips WHERE axis_id=?').get(context.axis_id) as {source_id:string}|null;
  const selectedSource=state?.source_id??clip?.source_id;
  const expected=state?.expected_source_frame_ids??(selectedSource?loadSource(selectedSource).frames.map((s:any)=>s.source_frame_id):[]);
  const canonical=new Map<string,unknown>();
  const captureSource=(sourceId:string,frameId:string)=>{
    const entry=loadSource(sourceId),map=entry.byId.get(frameId),source=entry.source;
    if(!map)throw new PipelineError('SOURCE_MAPPING_MISMATCH','期望源帧不属于所选素材',409);
    if(!canonical.has(frameId)){
      const path=source.probe.kind==='png_sequence'?map.canonical_path:join(STORAGE_ROOT,'sources',source.id,map.file);
      canonical.set(frameId,{source_id:source.id,source_frame_id:frameId,source_sha256:source.sha256,source_bytes:fileHash(path),original_bytes:entry.original_bytes,source:map});
    }
    return {source,map};
  };
  if(selectedSource)for(const id of expected)captureSource(selectedSource,id);
  const frames:DraftFrame[]=rows.map(f=>{
    const meta=JSON.parse(f.metadata??'{}');
    if(!meta.source_id||!meta.source_frame_id)throw new PipelineError('SOURCE_MAPPING_MISSING','制作帧缺少明确源映射',409);
    const {source,map}=captureSource(meta.source_id,meta.source_frame_id);
    if(!map||map.source_index!==meta.source_index)throw new PipelineError('SOURCE_MAPPING_MISMATCH','制作帧源映射无效',409);
    const mask=maskState(f.id);
    if(mask.source_changed)throw new PipelineError('SOURCE_CHANGED','原图已改变，遮罩失效',409);
    const output=state?.durations[f.id];
    const duration=output?.duration??map.display_duration;
    const duration_origin:DurationOrigin=output?.duration_origin??map.duration_origin;
    if(!duration)throw new PipelineError('TIMING_REQUIRED','PNG 需要确认输出时长',409);
    const transform={offset_x:f.offset_x,offset_y:f.offset_y,scale:f.scale,rotation:f.rotation,opacity:f.opacity};
    if(!Object.values(transform).every(Number.isFinite))throw new PipelineError('INVALID_FRAME_TRANSFORM','帧变换无效');
    return {frame_id:f.id,source_frame_id:map.source_frame_id,source_index:map.source_index,sequence_index:f.sequence_index,duration:rational(duration.num,duration.den),duration_origin,source_size:{width:source.probe.kind==='png_sequence'?map.width:source.probe.width,height:source.probe.kind==='png_sequence'?map.height:source.probe.height},raw_path:f.raw_path,raw_sha256:fileHash(f.raw_path),mask_path:mask.current?.mask_path??null,mask_sha256:mask.current?fileHash(mask.current.mask_path):null,rgba_path:mask.current?.rgba_path??null,rgba_sha256:mask.current?fileHash(mask.current.rgba_path):null,mask_version_id:mask.version_id,transform};
  });
  // 完整期望集独立于 JOIN 后的制作帧；缺格不会减少期望数。
  const hash=collaborationHash({context,frames,canonical:[...canonical.values()],expected_source_frame_ids:expected,alignment,timing:state?.timing??null});
  const key=`sfs.draft-token.${context.project_id}.${context.axis_id}`,previous=setting(key) as ContentToken|null;
  const revision=(db.query('SELECT content_revision FROM projects WHERE id=?').get(context.project_id) as {content_revision:number}).content_revision;
  const token=previous?.hash===hash?previous:{revision:Math.max(previous?previous.revision+1:0,revision),hash};
  if(previous?.hash!==hash)db.transaction(()=>{
    db.query('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,JSON.stringify(token),Date.now());
    if(previous)db.query('UPDATE projects SET content_revision=content_revision+1 WHERE id=?').run(context.project_id);
    db.query('UPDATE collab_tasks SET content_revision=?,content_hash=?,updated_at=? WHERE project_id=? AND axis_id=?').run(token.revision,token.hash,Date.now(),context.project_id,context.axis_id);
  }).immediate();
  // 未配置对齐的空动作可读取制作身份，构建候选前必须明确配置。
  return {context,token,frames,expected_source_frame_ids:[...expected],alignment};
}
export function assertDraftBase(context:WorkContext,base:ContentToken):void {
  const token=readDraftContent(context).token;
  if(!base||base.revision!==token.revision||base.hash!==token.hash)throw new PipelineError('CONTENT_CONFLICT','制作内容已变化',409);
}
export function finishDraftOperation(id:string,result:unknown):void {
  db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson(result),Date.now(),id);
}
export function outputDurations(timing:TaskBrief['timing'],sourceFrames:any[]) {
  if(!timing||!['user','preset','inferred'].includes(timing.origin)||!validTiming(timing.value))throw new PipelineError('INVALID_TIMING','必须记录时长来源');
  const policy=timing.value;
  if(policy.mode==='explicit_durations'&&policy.durations.length!==sourceFrames.length)throw new PipelineError('INVALID_TIMING','明确时长必须覆盖全部帧');
  return sourceFrames.map((f,i)=>{
    if(policy.mode==='source_pts'){
      if(!f.display_duration)throw new PipelineError('TIMING_REQUIRED','PNG 没有视频 PTS，需要确认 FPS 或明确时长');
      return {duration:rational(f.display_duration.num,f.display_duration.den),duration_origin:f.duration_origin as DurationOrigin};
    }
    if(policy.mode==='confirmed_fps')return {duration:rational(policy.fps.den,policy.fps.num),duration_origin:'confirmed_fps' as const};
    if(policy.mode==='explicit_durations')return {duration:rational(policy.durations[i]!.num,policy.durations[i]!.den),duration_origin:'explicit_durations' as const};
    throw new PipelineError('INVALID_TIMING','输出时序策略无效');
  });
}
export function setOutputTiming(context:WorkContext,timing:TaskBrief['timing'],base:ContentToken,request:RequestIdentity):ContentToken {
  let committed=false;
  const result=db.transaction(()=>{
    const operation=claimOperation('set_output_timing',request,{context,timing,base_content:base});
    if(operation.state==='succeeded')return operation.result as ContentToken;
    assertDraftBase(context,base);const content=readDraftContent(context),state=draftState(context);
    if(!state)throw new PipelineError('TASK_REQUIRED','需要先建立协作源选择');
    if(content.frames.length!==state.expected_source_frame_ids.length||new Set(content.frames.map(f=>f.source_frame_id)).size!==state.expected_source_frame_ids.length||content.frames.some(f=>!state.expected_source_frame_ids.includes(f.source_frame_id)))throw new PipelineError('INCOMPLETE_SOURCE_SELECTION','时序变更必须覆盖完整所选源集',409);
    const map=sourceSelection(context,state.source_id),sources=content.frames.map(f=>map.find((s:any)=>s.source_frame_id===f.source_frame_id));
    if(sources.some(s=>!s))throw new PipelineError('SOURCE_MAPPING_MISMATCH','输出帧不属于所选源');
    const durations=outputDurations(timing,sources);state.timing=structuredClone(timing);
    if(timing.value.mode==='confirmed_fps'){state.preview_fps=rational(timing.value.fps.num,timing.value.fps.den);db.query('UPDATE animation_axes SET fps=? WHERE id=?').run(state.preview_fps.num/state.preview_fps.den,context.axis_id);}
    content.frames.forEach((f,i)=>state.durations[f.frame_id]=durations[i]!);saveDraftState(context,state);
    const token=readDraftContent(context).token;finishDraftOperation(operation.id,token);committed=true;return token;
  }).immediate();
  if(committed)invalidateProjectUndo(context.project_id);
  return result;
}
export function setAxisFps(axisId:string,fps:number):void {
  if(!Number.isFinite(fps)||fps<1||fps>120)throw new PipelineError('INVALID_TIMING','FPS 必须为1到120');
  db.transaction(()=>{retimeAxisFps(axisId,fps);db.query('UPDATE animation_axes SET fps=? WHERE id=?').run(fps,axisId);}).immediate();
}
export function createCollaborationTask(brief:TaskBrief,request:RequestIdentity,actor:ActorContext) {
  requireRole(actor,'maker');
  brief=verifiedTaskBrief(brief);
  if(!validBrief(brief))throw new PipelineError('INVALID_TASK_BRIEF','任务要求不符合共用契约');
  let committed=false;
  const result=db.transaction(()=>{
    // Task1 的已完成操作优先返回，重试不能重新应用已编辑的要求。
    const op=claimOperation('create_task',request,brief);
    if(op.state==='succeeded'&&op.result&&typeof op.result==='object'&&!Array.isArray(op.result)&&typeof op.result.task_id==='string')return readTaskRecord(op.result.task_id);
    draftAxis(brief.context);const map=sourceSelection(brief.context,brief.source_id),ids=brief.ordered_source_frame_ids;
    if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!map.some((f:any)=>f.source_frame_id===id)))throw new PipelineError('INVALID_SOURCE_SELECTION','源选择包含重复、未知或跨源帧');
    const content=readDraftContent(brief.context);
    if(content.frames.length!==ids.length||new Set(content.frames.map(f=>f.source_frame_id)).size!==ids.length||content.frames.some((f,i)=>ids[i]!==f.source_frame_id))throw new PipelineError('INCOMPLETE_SOURCE_SELECTION','主轨必须覆盖完整所选源集',409);
    const durations=outputDurations(brief.timing,content.frames.map(f=>map.find((s:any)=>s.source_frame_id===f.source_frame_id)));
    saveTaskAlignment(brief.context.project_id,brief.context.axis_id,brief.alignment.value,ids.length);
    const task=createTaskRecord(brief,request);
    if(brief.timing.value.mode==='confirmed_fps')db.query('UPDATE animation_axes SET fps=? WHERE id=?').run(brief.timing.value.fps.num/brief.timing.value.fps.den,brief.context.axis_id);
    saveDraftState(brief.context,{...(brief.timing.value.mode==='confirmed_fps'?{preview_fps:brief.timing.value.fps}:{}),source_id:brief.source_id,expected_source_frame_ids:[...ids],timing:structuredClone(brief.timing),durations:Object.fromEntries(content.frames.map((f,i)=>[f.frame_id,durations[i]]))});
    readDraftContent(brief.context);committed=true;return readTaskRecord(task.id);
  }).immediate();
  if(committed)invalidateProjectUndo(brief.context.project_id);
  return result;
}
export function startRework(taskId:string,parentCandidateId:string,base:ContentToken,request:RequestIdentity,actor:ActorContext) {
  requireRole(actor,'maker');return db.transaction(()=>{
    const operation=claimOperation('start_rework',request,{task_id:taskId,parent_candidate_id:parentCandidateId,base_content:base});
    if(operation.state==='succeeded')return operation.result as unknown as {task:ReturnType<typeof readTaskRecord>;content_token:ContentToken};
    const task=readTaskRecord(taskId);assertDraftBase(task.context,base);
    if(!db.query('SELECT id FROM candidates WHERE id=? AND task_id=?').get(parentCandidateId,taskId))throw new PipelineError('CANDIDATE_NOT_FOUND','父候选不属于任务',404);
    invalidateAcceptance(taskId,'rework_started');
    db.query("UPDATE collab_tasks SET state='reworking',acceptance_epoch=acceptance_epoch+1,operation_ids_json=?,updated_at=? WHERE id=?").run(JSON.stringify([...task.operation_ids,operation.id]),Date.now(),taskId);
    const result={task:readTaskRecord(taskId),content_token:readDraftContent(task.context).token};finishDraftOperation(operation.id,result);return result;
  }).immediate();
}
