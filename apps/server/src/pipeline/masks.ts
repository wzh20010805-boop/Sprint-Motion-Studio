import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, getFrame, REPO_ROOT, STORAGE_ROOT, uid } from '../db';
import { broadcast } from '../ws';
import { JobCancelledError } from '../jobs/run';
import { getProject, PipelineError, validateId } from './service';
import type { MaskStroke, MatteRequest } from '@framebaker/shared';
import { invalidateProjectUndo } from '../undo';


export const modelDirectory = () => process.env.SFS_MODEL_DIR ?? join(REPO_ROOT, '.models');
export const imagePython = () => process.env.SFS_IMAGE_PYTHON ?? join(REPO_ROOT, '.venv-image', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const maskBackend = () => ({ ready: existsSync(imagePython()) && existsSync(join(modelDirectory(), 'u2netp.onnx')), python: imagePython(), model: 'u2netp', models: modelDirectory() });
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function runImageWorker(request: unknown, directory: string, signal?: AbortSignal, progress?: (text: string) => void): Promise<any> {
  if (signal?.aborted) throw new JobCancelledError();
  if (!existsSync(imagePython())) throw new PipelineError('DEPENDENCY_MISSING', '独立 Python 图像环境未准备', 503);
  mkdirSync(directory, { recursive: true });
  const input = join(directory, 'request.json'), output = join(directory, 'result.json');
  writeFileSync(input, JSON.stringify(request));
  const proc = Bun.spawn([imagePython(), join(REPO_ROOT, 'workers/image/worker.py'), input, output], { env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}, windowsHide: true, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const abort = () => { try { proc.kill(); } catch { /* 已退出 */ } };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const stdout = (async () => {
    const reader = proc.stdout.getReader(); const decoder = new TextDecoder(); let pending = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end+1); try { const p = JSON.parse(line); if (p.progress) progress?.(`场景抠图 ${p.progress}/${p.total}`); } catch { /* 库普通输出不充当进度 */ } }
    }
  })();
  try {
    const [code, , stderr] = await Promise.all([proc.exited, stdout, new Response(proc.stderr).text()]);
    if (signal?.aborted) throw new JobCancelledError();
    if (code !== 0 || !existsSync(output)) {
      const failure=['MODEL_NOT_READY','MODEL_INVALID','REGION_NO_FOREGROUND','MATTE_NO_FOREGROUND'].find(code=>stderr.includes(code)) ?? 'IMAGE_WORKER_FAILED';
      throw new PipelineError(failure, stderr.slice(-2500) || '图像 Worker 未生成结果', ['REGION_NO_FOREGROUND','MATTE_NO_FOREGROUND'].includes(failure)?422:503);
    }
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally { signal?.removeEventListener('abort', abort); }
}

/** 兼容旧版PNG提示；仅修正派生信息，不改写原件、遮罩或审核状态。 */
export function maskInspectionInfo(kind:string|null,encoded:string|null):string|null {
  if(kind!=='imported'||!encoded)return encoded;
  const info=JSON.parse(encoded);
  if(info.foreground_fraction>0&&!info.reasons.includes('EMPTY_MASK'))return JSON.stringify({...info,visible_fraction:info.foreground_fraction,reasons:info.reasons.filter((reason:string)=>reason!=='LOW_CONFIDENCE')});
  return encoded;
}

export function maskState(frameId: string) {
  validateId(frameId); const frame = getFrame(frameId);
  if (!frame) throw new PipelineError('FRAME_NOT_FOUND', '帧不存在', 404);
  const head = db.query('SELECT * FROM mask_heads WHERE frame_id=?').get(frameId) as { version_id: string; reviewed: number } | null;
  const versions = (db.query('SELECT * FROM mask_versions WHERE frame_id=? ORDER BY created_at DESC,id').all(frameId) as any[]).map(version=>({...version,info:maskInspectionInfo(version.kind,version.info)}));
  const current = versions.find(v => v.id === head?.version_id) ?? null;
  const sourceChanged=!!current&&(!frame.raw_path||!existsSync(frame.raw_path)||hash(frame.raw_path)!==current.raw_sha256);
  return { frame_id: frameId, revision: (getProject(frame.project_id) as any).revision, version_id: head?.version_id ?? null, reviewed: !!head?.reviewed&&!sourceChanged, source_changed:sourceChanged, current:sourceChanged?null:current, versions, raw_path:sourceChanged?frame.raw_path:current?.raw_path ?? frame.raw_path };
}

export function prepareMatte(request: MatteRequest): MatteRequest & { base_revision: number } {
  const project = getProject(request.project_id) as any;
  const base = request.base_revision ?? project.revision;
  if (base !== project.revision) throw new PipelineError('REVISION_CONFLICT', '项目已修改，请刷新后重试', 409);
  if (!request.frame_ids.length || request.frame_ids.length > 2000 || new Set(request.frame_ids).size !== request.frame_ids.length) throw new PipelineError('INVALID_INPUT', '请选择1到2000个不同帧');
  for (const id of request.frame_ids) { validateId(id); const frame = getFrame(id); if (!frame || frame.project_id !== request.project_id || !frame.raw_path) throw new PipelineError('FRAME_PROJECT_MISMATCH', '帧不存在、无原图或不属于此项目'); }
  if (!maskBackend().ready) throw new PipelineError('MODEL_NOT_READY', '请先运行 scripts/setup_p2.ps1 准备本地 CPU 模型', 503);
  return { ...request, base_revision: base };
}

function commitVersions(projectId: string, revision: number, entries: any[], kind: string, info: any[]) {
  db.transaction(() => {
    if ((getProject(projectId) as any).revision !== revision) throw new PipelineError('STALE_JOB_RESULT', '项目修订变化，旧抠图结果已保留但未覆盖当前帧', 409);
    for (let i=0; i<entries.length; i++) {
      const e = entries[i]; const frame = getFrame(e.id);
      if (!frame || frame.project_id !== projectId || frame.raw_path !== e.sourcePath || hash(frame.raw_path!) !== e.sourceHash) throw new PipelineError('STALE_JOB_RESULT', '原图已修改，不能提交旧遮罩', 409);
      const parent = maskState(e.id).version_id;
      db.query('INSERT INTO mask_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(e.version, e.id, parent, kind, e.mask, e.rgba, e.preview, e.raw, hash(e.raw), JSON.stringify(info[i]), Date.now());
      db.query('INSERT INTO mask_heads VALUES(?,?,0) ON CONFLICT(frame_id) DO UPDATE SET version_id=excluded.version_id,reviewed=0').run(e.id,e.version);
      db.query("UPDATE frames SET processed_path=?,status='ready' WHERE id=?").run(e.rgba, e.id);
    }
  })();
  invalidateProjectUndo(projectId);
  broadcast('frames_changed', { projectId });
}

function entry(frameId: string, directory: string, rawOverride?: string) {
  const frame = getFrame(frameId)!; const version = uid(); const dir = join(directory, version); mkdirSync(dir, { recursive: true });
  const raw = join(dir, 'original.png'); writeFileSync(raw, readFileSync(rawOverride ?? frame.raw_path!));
  return { id: frameId, version, sourcePath: frame.raw_path!, sourceHash: hash(frame.raw_path!), raw, mask: join(dir,'mask.png'), rgba: join(dir,'foreground.png'), preview: join(dir,'preview.png') };
}

export async function matteBatch(request: MatteRequest & { base_revision: number }, progress?: (text: string) => void, signal?: AbortSignal) {
  const dir = join(STORAGE_ROOT, 'projects', request.project_id, 'masks', uid());
  const backend = maskBackend();
  const model = await runImageWorker({ action:'doctor', models:backend.models, model:backend.model }, join(dir,'model'), signal);
  const entries = request.frame_ids.map(id => entry(id, dir));
  const result = await runImageWorker({ action:'batch', frames:entries, model:backend.model, models:backend.models, region:request.region,cache:join(STORAGE_ROOT,'cache','matting',request.project_id) }, dir, signal, progress);
  commitVersions(request.project_id, request.base_revision, entries, 'automatic', result.frames);
  const report = { model, session_count:result.session_count, cache_hits:result.cache_hits, frame_count:entries.length, region:request.region ?? null, abnormal_frames:result.frames.filter((f:any) => f.reasons.length), requires_user_action:true, artifacts:entries.map(e=>({frame_id:e.id,kind:'rgba_draft',path:e.rgba,mask:e.mask,preview:e.preview})) };
  const reportPath=join(dir,'review.json'); writeFileSync(reportPath, JSON.stringify(report,null,2));
  return { ...report, report_path:reportPath };
}

export async function editMask(frameId: string, baseVersion: string | null, strokes: MaskStroke[], revision: number) {
  const state = maskState(frameId); const frame = getFrame(frameId)!;
  if (state.source_changed) throw new PipelineError('SOURCE_CHANGED','当前帧原图已修改，请重新生成抠图初稿',409);
  if (!state.current) throw new PipelineError('MASK_NOT_FOUND','请先生成抠图初稿',409);
  if (!frame.raw_path || hash(frame.raw_path) !== state.current.raw_sha256) throw new PipelineError('SOURCE_CHANGED','当前帧原图已修改，请重新生成抠图初稿',409);
  if (state.version_id !== baseVersion || state.revision !== revision) throw new PipelineError('REVISION_CONFLICT','遮罩或项目已更新，请重新载入',409);
  if (!strokes.length || strokes.length > 1000 || strokes.some(s=>s.points.length > 20000)) throw new PipelineError('INVALID_INPUT','笔刷数量无效');
  const dir=join(STORAGE_ROOT,'projects',frame.project_id,'masks',uid());
  const e=entry(frameId,dir,state.raw_path); const result=await runImageWorker({action:'edit',frames:[{...e,input_mask:state.current.mask_path}],strokes},dir);
  commitVersions(frame.project_id,revision,[e],'manual',result.frames);
  return maskState(frameId);
}

export function undoMask(frameId: string, versionId: string, revision: number) {
  const state=maskState(frameId), frame=getFrame(frameId)!;
  if (state.version_id !== versionId || state.revision !== revision) throw new PipelineError('REVISION_CONFLICT','遮罩已更新',409);
  if (!frame.raw_path || hash(frame.raw_path) !== state.current?.raw_sha256) throw new PipelineError('SOURCE_CHANGED','原图已修改，请重新生成抠图',409);
  const parent=state.versions.find(v=>v.id === state.current?.parent_id);
  if (!parent) throw new PipelineError('NO_MASK_UNDO','没有可撤销的遮罩修订',409);
  db.transaction(()=>{
    db.query('UPDATE mask_heads SET version_id=?,reviewed=0 WHERE frame_id=?').run(parent.id,frameId);
    db.query('UPDATE frames SET processed_path=? WHERE id=?').run(parent.rgba_path,frameId);
  })(); invalidateProjectUndo(frame.project_id); broadcast('frame_updated',{id:frameId,projectId:frame.project_id,imageChanged:true}); return maskState(frameId);
}

export function reviewMask(frameId: string, versionId: string, revision: number) {
  // 审核、项目修订与批次状态必须一起提交，避免已保存审核却向界面返回错误。
  const result=db.transaction(()=>{
    const state=maskState(frameId), frame=getFrame(frameId)!;
    if (state.version_id !== versionId || state.revision !== revision) throw new PipelineError('REVISION_CONFLICT','遮罩已更新',409);
    if (!frame.raw_path || hash(frame.raw_path) !== state.current?.raw_sha256) throw new PipelineError('SOURCE_CHANGED','原图已修改，请重新生成抠图',409);
    if (JSON.parse(state.current.info).reasons.some((reason:string)=>['EMPTY_MASK','LOW_CONFIDENCE'].includes(reason))) throw new PipelineError('MATTE_NO_FOREGROUND','没有可见前景，请先恢复角色或重新生成，不能确认空遮罩',422);
    db.query('UPDATE mask_heads SET reviewed=1 WHERE frame_id=?').run(frameId);
    db.query('UPDATE projects SET revision=revision+1 WHERE id=?').run(frame.project_id);
    const jobs=db.query("SELECT id,payload FROM jobs WHERE project_id=? AND status='waiting_user'").all(frame.project_id) as {id:string;payload:string}[];
    const settled:{id:string;status:'cancelled'|'done';progress:string}[]=[];
    for (const job of jobs) {
      const ids:string[]=JSON.parse(job.payload).sceneMatting?.frame_ids ?? [];
      if (!ids.length) continue;
      // 旧批次引用已删或已移出项目的帧时失效，保留原任务及产物，不冒充审核通过。
      if (ids.some(id=>getFrame(id)?.project_id !== frame.project_id)) {
        const progress='帧已移除，旧抠图审核任务已失效';
        db.query("UPDATE jobs SET status='cancelled',requires_user_action=0,progress=?,updated_at=? WHERE id=?").run(progress,Date.now(),job.id);
        settled.push({id:job.id,status:'cancelled',progress});
      } else if (ids.every(id=>maskState(id).reviewed)) {
        db.query("UPDATE jobs SET status='done',requires_user_action=0,progress='人工检查完成',updated_at=? WHERE id=?").run(Date.now(),job.id);
        settled.push({id:job.id,status:'done',progress:'人工检查完成'});
      }
    }
    return {projectId:frame.project_id,state:maskState(frameId),settled};
  })();
  for (const job of result.settled) broadcast(job.status==='done'?'job_done':'job_cancelled',{...job,projectId:result.projectId,type:'matting'});
  broadcast('frames_changed',{projectId:result.projectId});
  return result.state;
}
