import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlignmentConfig,FrameRenderTransform } from '@framebaker/shared';
import { db, STORAGE_ROOT, uid } from '../db';
import { broadcast } from '../ws';
import { getProject, PipelineError, validateId } from './service';
import { maskState, runImageWorker } from './masks';

const key=(project:string,axis:string)=>`sfs.alignment.${project}.${axis}`;
const presetKey=(project:string)=>`sfs.preset.${project}`;
const setting=(key:string)=>{const row=db.query('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|null;return row?JSON.parse(row.value):null;};
const put=(key:string,value:unknown)=>db.query('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,JSON.stringify(value),Date.now());
export const fileHash=(path:string)=>{
 if(!existsSync(path))throw new PipelineError('INPUT_NOT_FOUND','源素材或处理产物已丢失，请重新定位素材',404);
 return createHash('sha256').update(readFileSync(path)).digest('hex');
};

export function axisFrames(projectId:string,axisId:string) {
 getProject(projectId);validateId(axisId);
 const axis=db.query('SELECT * FROM animation_axes WHERE id=? AND project_id=?').get(axisId,projectId) as any;
 if(!axis)throw new PipelineError('AXIS_NOT_FOUND','动作不存在',404);
 const frames=db.query(`SELECT f.*,s.idx AS sequence_index,s.duration AS step_duration FROM frames f
 JOIN animation_tracks t ON t.id=f.track_id JOIN animation_steps s ON s.id=f.step_id
 WHERE f.project_id=? AND t.axis_id=? AND t.is_primary=1 ORDER BY s.idx,s.id`).all(projectId,axisId) as any[];
 if(!frames.length)throw new PipelineError('INPUT_NOT_FOUND','动作没有主轨帧',404);
 return {axis,frames};
}

export function validateAlignment(config:AlignmentConfig, count:number) {
 const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=100000;
 if(!config||!config.canvas||![config.canvas.width,config.canvas.height].every(v=>Number.isSafeInteger(v)&&v>=1&&v<=4096)||!Array.isArray(config.anchor)||config.anchor.length!==2||!config.anchor.every(finite)||!finite(config.scale)||config.scale<=0||config.scale>16||!['pixel','cartoon'].includes(config.resampling)||!['fixed','ground_keyframes'].includes(config.mode)||!Array.isArray(config.roots)||!config.roots.length||config.roots.length>count)throw new PipelineError('INVALID_ALIGNMENT','画布、比例或根轨迹无效');
 const seen=new Set<number>();for(const r of config.roots){if(!r||!Number.isSafeInteger(r.index)||r.index<0||r.index>=count||seen.has(r.index)||!finite(r.x)||!finite(r.y))throw new PipelineError('INVALID_ALIGNMENT','根位置索引或坐标无效');seen.add(r.index);}
 if(config.mode==='fixed'&&config.roots.length!==1)throw new PipelineError('INVALID_ALIGNMENT','固定基准只能有一个根位置');
 if(!config.offsets||typeof config.offsets!=='object'||Array.isArray(config.offsets))throw new PipelineError('INVALID_ALIGNMENT','逐帧偏移无效');
 for(const [index,point] of Object.entries(config.offsets)){if(!/^\d+$/.test(index)||Number(index)>=count||!Array.isArray(point)||point.length!==2||!point.every(finite))throw new PipelineError('INVALID_ALIGNMENT','逐帧偏移索引或坐标无效');}
 return structuredClone(config);
}

export function alignmentState(project:string,axis:string) {
 const {frames}=axisFrames(project,axis), saved=setting(key(project,axis));
 const preset=setting(presetKey(project));
 const config=saved ? {...saved.config,...preset} : null;
 const review=setting(`sfs.review.${project}.${axis}`);
 return {config,revision:getProject(project).revision,approved_revision:review?.revision??null,approved_fingerprint:review?.fingerprint??null,frame_count:frames.length};
}

export function saveAlignment(project:string,axis:string,config:AlignmentConfig,revision:number) {
 const {frames}=axisFrames(project,axis);const validated=validateAlignment(config,frames.length);
 if(getProject(project).revision!==revision)throw new PipelineError('REVISION_CONFLICT','项目已变化，请重新载入',409);
 db.transaction(()=>{put(key(project,axis),{config:validated});put(presetKey(project),{canvas:validated.canvas,anchor:validated.anchor,scale:validated.scale,resampling:validated.resampling});db.query('UPDATE projects SET revision=revision+1 WHERE id=?').run(project);})();
 broadcast('frames_changed',{projectId:project});return alignmentState(project,axis);
}

export function composeInputs(project:string,axis:string) {
 const {frames}=axisFrames(project,axis),state=alignmentState(project,axis);
 if(!state.config)throw new PipelineError('ALIGNMENT_REVIEW_REQUIRED','请先标注地面基准和公共画布',409);
 validateAlignment(state.config,frames.length);
 return frames.map((f,index)=>{
  const mask=maskState(f.id);if(!mask.current)throw new PipelineError('MASK_REVIEW_REQUIRED','部分帧没有有效抠图，请生成或修复遮罩',409);
  const transform:FrameRenderTransform={offset_x:f.offset_x,offset_y:f.offset_y,scale:f.scale,rotation:f.rotation,opacity:f.opacity};
  if(!Object.values(transform).every(v=>typeof v==='number'&&Number.isFinite(v))||transform.opacity<0||transform.opacity>1)throw new PipelineError('INVALID_FRAME_TRANSFORM','帧变换必须是有限数，透明度须在0到1之间');
  return {id:f.id,index,path:mask.current.rgba_path,mask_version:mask.version_id,reviewed:mask.reviewed,sha256:fileHash(mask.current.rgba_path),transform};
 });
}

export function reviewFingerprint(project:string,axis:string) {
 const {frames}=axisFrames(project,axis),state=alignmentState(project,axis),inputs=composeInputs(project,axis);
 return createHash('sha256').update(JSON.stringify({config:state.config,inputs:inputs.map((f,i)=>({...f,raw_sha256:fileHash(frames[i].raw_path),mask_sha256:fileHash(maskState(f.id).current.mask_path)}))})).digest('hex');
}

export async function checkAlignment(project:string,axis:string) {
 const state=alignmentState(project,axis),frames=composeInputs(project,axis);
 const result=await runImageWorker({action:'compose',frames,alignment:state.config},join(STORAGE_ROOT,'staging','alignment-check',uid()));
 if(getProject(project).revision!==state.revision)throw new PipelineError('STALE_JOB_RESULT','预检期间项目发生修改',409);
 return {...result,revision:state.revision};
}

export async function approveAlignment(project:string,axis:string,revision:number,confirmation:string,source:string) {
 if(!confirmation?.trim()||!source?.trim())throw new PipelineError('INVALID_REVIEW','必须记录人工确认内容和来源');
 if(getProject(project).revision!==revision)throw new PipelineError('REVISION_CONFLICT','确认依据已经过期',409);
 if(composeInputs(project,axis).some(f=>!f.reviewed))throw new PipelineError('MASK_REVIEW_REQUIRED','请先逐帧确认当前遮罩',409);
 const fingerprint=reviewFingerprint(project,axis);
 const result=await checkAlignment(project,axis);
 if(result.checks.some((c:any)=>c.overflow||c.empty))throw new PipelineError('ALIGNMENT_REVIEW_REQUIRED','存在越界或空帧，请调整公共画布或修正遮罩',409);
 if(getProject(project).revision!==revision||reviewFingerprint(project,axis)!==fingerprint)throw new PipelineError('STALE_JOB_RESULT','检查期间输入发生变化，确认未保存',409);
 put(`sfs.review.${project}.${axis}`,{revision,fingerprint,confirmation:confirmation.slice(0,2000),source:source.slice(0,200),at:Date.now()});
 return alignmentState(project,axis);
}

const pendingPreviews=new Map<string,Promise<void>>();
export async function previewFrame(project:string,axis:string,frameId:string) {
 const state=alignmentState(project,axis),frames=composeInputs(project,axis),frame=frames.find(f=>f.id===frameId);
 if(!frame)throw new PipelineError('FRAME_NOT_FOUND','此帧不属于动作',404);
 const fingerprint=createHash('sha256').update(JSON.stringify({config:state.config,frame})).digest('hex');
 const directory=join(STORAGE_ROOT,'cache','compose',fingerprint);mkdirSync(directory,{recursive:true});
 const output=join(directory,'frame.png');
 const checksum=join(directory,'sha256.txt');
 if(!existsSync(output)||!existsSync(checksum)||fileHash(output)!==readFileSync(checksum,'utf8')){
  let pending=pendingPreviews.get(fingerprint);
  if(!pending){pending=(async()=>{await runImageWorker({action:'compose',alignment:state.config,frames:[{...frame,output}]},join(directory,uid()));writeFileSync(checksum,fileHash(output));})();pendingPreviews.set(fingerprint,pending);}
  try{await pending;}finally{if(pendingPreviews.get(fingerprint)===pending)pendingPreviews.delete(fingerprint);}
 }
 if(getProject(project).revision!==state.revision)throw new PipelineError('STALE_JOB_RESULT','预览期间项目发生修改',409);
 return output;
}
