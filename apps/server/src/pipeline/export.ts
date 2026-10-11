import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportRequest } from '@framebaker/shared';
import { db, STORAGE_ROOT, uid } from '../db';
import { alignmentState, axisFrames, composeInputs, fileHash,reviewFingerprint } from './alignment';
import { getProject, PipelineError } from './service';
import { runImageWorker } from './masks';
import { checkCancelled, runPipelineCommand } from './probe';

export interface ExportPayload { request:ExportRequest; revision:number; fingerprint:string }

export function exportSnapshot(request:ExportRequest) {
 const project=getProject(request.project_id),state=alignmentState(project.id,request.axis_id);
 if(request.base_revision!==undefined&&request.base_revision!==project.revision)throw new PipelineError('REVISION_CONFLICT','导出基础修订已变化',409);
 if(!request.draft&&state.approved_revision!==project.revision)throw new PipelineError('ALIGNMENT_REVIEW_REQUIRED','请先确认当前修订的地面根位置、画布与素材',409);
 if(!request.draft&&state.approved_fingerprint!==reviewFingerprint(project.id,request.axis_id))throw new PipelineError('MASK_REVIEW_REQUIRED','审核后输入文件发生变化，请重新检查并确认',409);
 const inputs=composeInputs(project.id,request.axis_id);
 if(!request.draft&&inputs.some(f=>!f.reviewed))throw new PipelineError('MASK_REVIEW_REQUIRED','存在尚未确认的遮罩',409);
 const {axis,frames}=axisFrames(project.id,request.axis_id);
 const exportFrames=inputs.map((input,index)=>{
  const f=frames[index],metadata=JSON.parse(f.metadata??'{}');
  const source=metadata.source_id?db.query('SELECT sha256 FROM sources WHERE id=?').get(metadata.source_id) as any:null;
  return {...input,raw_sha256:fileHash(f.raw_path),source_id:metadata.source_id??null,source_sha256:source?.sha256??null,
   source_frame_id:metadata.source_frame_id??null,source_index:metadata.source_index??index,
   duration:request.timing==='constant'||!metadata.timing?{num:f.step_duration,den:axis.fps}:metadata.timing.display_duration};
 });
 const settings={max_texture:request.max_texture??2048,gap:request.gap??2,margin:request.margin??1};
 if(!Number.isSafeInteger(settings.max_texture)||settings.max_texture<16||settings.max_texture>8192||![settings.gap,settings.margin].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=64)||!['source_pts','constant'].includes(request.timing??'source_pts'))throw new PipelineError('INVALID_EXPORT','纹理大小、间距或时序模式无效');
 const snapshot={project:project.id,axis:axis.id,clip_name:axis.name,revision:project.revision,alignment:state.config,frames:exportFrames,draft:!!request.draft,...settings};
 const fingerprint=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 return {snapshot,fingerprint};
}

export function prepareExport(request:ExportRequest):ExportPayload {
 const {snapshot,fingerprint}=exportSnapshot(request);
 return {request,revision:snapshot.revision,fingerprint};
}

export function exportRecord(id:string) {
 const row=db.query('SELECT value FROM settings WHERE key=?').get(`sfs.export.${id}`) as {value:string}|null;
 if(!row)throw new PipelineError('EXPORT_NOT_FOUND','导出版本不存在',404);
 return JSON.parse(row.value);
}

function verifySnapshot(payload:ExportPayload) {
 if(getProject(payload.request.project_id).revision!==payload.revision)throw new PipelineError('STALE_JOB_RESULT','项目已更新，旧产物已保留但未发布',409);
 if(exportSnapshot(payload.request).fingerprint!==payload.fingerprint)throw new PipelineError('STALE_JOB_RESULT','输入文件或参数已变化，不能发布旧结果',409);
}

export async function exportAssets(payload:ExportPayload,progress?:(text:string)=>void,signal?:AbortSignal) {
 checkCancelled(signal);verifySnapshot(payload);
 const {snapshot}=exportSnapshot(payload.request);
 const id=uid(),staging=join(STORAGE_ROOT,'staging','export',id),directory=join(STORAGE_ROOT,'exports',payload.request.project_id,id);
 mkdirSync(staging,{recursive:true});
 progress?.('合成透明帧与规则图集');
 const result=await runImageWorker({action:'export',directory:staging,...snapshot},join(staging,'worker'),signal,progress);
 checkCancelled(signal);
 if(!snapshot.draft&&result.checks.some((c:any)=>c.overflow||c.empty))throw new PipelineError('ALIGNMENT_REVIEW_REQUIRED','正式输出存在空帧或裁切，旧导出版本未覆盖',409);
 const manifest={schema_version:'1.0',generator:{name:'soldier-frame-studio',version:'1.0.0'},export_id:id,
  character:getProject(snapshot.project).name,clip:snapshot.clip_name,axis_id:snapshot.axis,project_id:snapshot.project,
  input_revision:snapshot.revision,input_fingerprint:payload.fingerprint,coordinate_system:'top-left-x-right-y-down-pixel-edges',
  canvas:snapshot.alignment!.canvas,anchor_pixels:snapshot.alignment!.anchor,
  cocos_anchor:{x:snapshot.alignment!.anchor[0]/snapshot.alignment!.canvas.width,y:1-snapshot.alignment!.anchor[1]/snapshot.alignment!.canvas.height},
  scale:snapshot.alignment!.scale,resampling:snapshot.alignment!.resampling,timing_mode:payload.request.timing??'source_pts',...result};
 // 不把 Worker 的机器路径写进可转移的 manifest。
 manifest.frames=manifest.frames.map(({reviewed,sha256,raw_sha256,...f}:any)=>({...f,input_sha256:sha256,raw_sha256,rgba_sha256:fileHash(join(staging,f.file))}));
 const report={schema_version:'1.0',draft:snapshot.draft,input_revision:snapshot.revision,checks:result.checks,warnings:[...(snapshot.draft?['DRAFT_NOT_APPROVED']:[]),...(result.checks.some((c:any)=>c.overflow)?['CANVAS_OVERFLOW']:[])],frame_count:result.frames.length};
 writeFileSync(join(staging,'manifest.json'),JSON.stringify(manifest,null,2));
 writeFileSync(join(staging,'quality-report.json'),JSON.stringify(report,null,2));
 writeFileSync(join(staging,'README_COCOS_3.8.8.md'),'# Cocos Creator 3.8.8\n\n导入 frames 中的 RGBA PNG，按 manifest.frames 顺序和 duration 有理数设置时长。画布大小相同，锚点见 cocos_anchor（Cocos y 向上）。grid.rect 使用左上坐标。preview 是带背景检查视频，不是透明素材。草稿不可作为已批准素材。\n');
 // concat 时间使用每帧显示时长，重复末帧只为给它完整显示区间，输出总时长明确截断。
 const concat=result.frames.map((f:any)=>`file '../${f.file}'\nduration ${(f.duration.num/f.duration.den).toFixed(12)}`).join('\n')+`\nfile '../${result.frames.at(-1).file}'\n`;
 const list=join(staging,'previews','timing.ffconcat');writeFileSync(list,concat);
 progress?.('生成带背景检查视频');
 await runPipelineCommand(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','concat','-safe','0','-i',list,'-vf','format=rgb24,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=0x261a3d','-fps_mode','vfr','-t',String(result.duration.num/result.duration.den),'-c:v','libx264','-pix_fmt','yuv420p',join(staging,'previews','preview-on-background.mp4')],signal);
 // 逐个文件摘要作为发布检查点；不覆盖旧版本。
 const files=['manifest.json','quality-report.json','README_COCOS_3.8.8.md','previews/contact-sheet.png','previews/preview-on-background.mp4',...result.frames.map((f:any)=>f.file),...result.sheets.map((s:any)=>s.file)];
 const checksums=Object.fromEntries(files.map(file=>[file,fileHash(join(staging,file))]));
 writeFileSync(join(staging,'checksums.json'),JSON.stringify(checksums,null,2));
 await runImageWorker({action:'archive',directory:staging,files:[...files,'checksums.json']},join(staging,'archive-worker'),signal);
 checksums['assets.zip']=fileHash(join(staging,'assets.zip'));
 writeFileSync(join(staging,'checksums.json'),JSON.stringify(checksums,null,2));
 checkCancelled(signal);verifySnapshot(payload);
 mkdirSync(join(STORAGE_ROOT,'exports',payload.request.project_id),{recursive:true});renameSync(staging,directory);
 const record={id,directory,draft:snapshot.draft,input_revision:payload.revision,input_fingerprint:payload.fingerprint,frame_count:result.frames.length,checksums,
  warnings:report.warnings,artifacts:[{kind:'export',path:directory},{kind:'manifest',path:join(directory,'manifest.json')},{kind:'contact_sheet',path:join(directory,'previews/contact-sheet.png')},{kind:'preview_video',path:join(directory,'previews/preview-on-background.mp4')}]};
 db.query('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run(`sfs.export.${id}`,JSON.stringify(record),Date.now());
 return record;
}
