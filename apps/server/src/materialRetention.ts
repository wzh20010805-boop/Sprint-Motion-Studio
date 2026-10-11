import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SourceTiming, VideoProbe } from '@framebaker/shared';
import { db, getMaterial, STORAGE_ROOT, uid } from './db';
import { broadcast } from './ws';
import { extractAll, validateSourceArtifacts } from './pipeline/extractAll';
import { probeVideo } from './pipeline/probe';
import { JobCancelledError } from './jobs/run';

interface RetainedInput {
  key: string; name: string; rawPath: string; source: string;
  processedPath?: string | null; folderId?: string | null; metadata?: Record<string, unknown>;
}

/** 固定谱系 ID 防止重试重复入库；独立副本不受项目改图、撤销或删除影响。 */
export function retainImportedMaterial(input: RetainedInput): string {
  const id = 'import-' + createHash('sha256').update(input.key).digest('hex');
  if (getMaterial(id)) return id;
  const dir = join(STORAGE_ROOT, 'materials', id);
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, 'raw' + (extname(input.rawPath) || '.png'));
  // 未提交的旧副本仍保留；重试使用独立文件，绝不覆盖原始资料。
  const rawPath = existsSync(raw) ? join(dir, uid() + extname(raw)) : raw;
  copyFileSync(input.rawPath, rawPath, constants.COPYFILE_EXCL);
  let processedPath: string | null = null;
  if (input.processedPath && existsSync(input.processedPath)) {
    processedPath = join(dir, 'processed-' + uid() + '.png');
    copyFileSync(input.processedPath, processedPath, constants.COPYFILE_EXCL);
  }
  db.query('INSERT INTO materials(id,name,raw_path,processed_path,status,source,folder_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, input.name, rawPath, processedPath, processedPath ? 'matted' : 'raw', input.source, input.folderId ?? null, JSON.stringify(input.metadata ?? {}), Date.now());
  return id;
}

export function retainSourceOriginal(source: { id: string; original_name: string; original_path: string; sha256: string; probe: VideoProbe }) {
  return retainImportedMaterial({ key: 'source:' + source.id, name: basename(source.original_name).replace(/\.[^.]+$/, ''), rawPath: source.original_path, source: 'extract', metadata: { source_id: source.id, sha256: source.sha256, probe: source.probe } });
}

export function retainSourceFrames(sourceId: string, directory: string, timing: SourceTiming, name: string, folderId: string | null = null) {
  return timing.frames.map(frame => {
    if (!/^raw\/frame_\d{6}\.png$/.test(frame.file) || frame.source_frame_id !== `${sourceId}:${String(frame.source_index).padStart(6, '0')}`) throw new Error('源帧谱系或文件路径无效');
    return retainImportedMaterial({ key: 'source-frame:' + frame.source_frame_id, name: `${name} #${frame.source_index + 1}`, rawPath: join(directory, frame.file), source: 'extract', folderId, metadata: { source_id: sourceId, source_frame_id: frame.source_frame_id, source_index: frame.source_index, timing: frame } });
  });
}

/** 库中原视频先验证再登记；即使验证失败也保留原文件供诊断。 */
export async function uploadLibraryVideo(name: string, bytes: Uint8Array, folderId: string | null) {
  const id = uid(), dir = join(STORAGE_ROOT, 'materials', id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'raw' + extname(name).toLowerCase());
  writeFileSync(path, bytes, { flag: 'wx' });
  const probe = await probeVideo(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  db.query("INSERT INTO materials(id,name,raw_path,status,source,folder_id,metadata,created_at) VALUES(?,?,?,'raw','extract',?,?,?)")
    .run(id, name.replace(/\.[^.]+$/, ''), path, folderId, JSON.stringify({ source_id: id, sha256, probe }), Date.now());
  broadcast('materials_changed', {});
  return id;
}

/** 与项目共用完整抽帧校验和整数时序，不建立隐藏项目或使用 FPS 采样。 */
export async function extractLibraryVideo(id: string, progress: (text: string) => void, signal?: AbortSignal) {
  const material = getMaterial(id);
  if (!material?.raw_path || !existsSync(material.raw_path)) throw new Error('素材原文件缺失');
  const metadata = JSON.parse(material.metadata || '{}') as Record<string, unknown>;
  const sourceId = typeof metadata.source_id === 'string' ? metadata.source_id : id;
  if (metadata.sha256 && createHash('sha256').update(readFileSync(material.raw_path)).digest('hex') !== metadata.sha256) throw new Error('素材原文件校验和已变化');
  const directory = join(STORAGE_ROOT, 'materials', id, 'extraction');
  mkdirSync(directory, { recursive: true });
  let timing: SourceTiming;
  if (existsSync(join(directory, 'timing.json'))) timing = await validateSourceArtifacts(directory, sourceId, await probeVideo(material.raw_path, { signal }), signal);
  else timing = (await extractAll(material.raw_path, directory, { sourceId, signal, onProgress: progress })).timing;
  if (signal?.aborted) throw new JobCancelledError();
  const materialIds = db.transaction(() => retainSourceFrames(sourceId, directory, timing, material.name, material.folder_id))();
  broadcast('materials_changed', {});
  return { frame_count: timing.frames.length, material_ids: materialIds, source_duration: timing.duration, warnings: timing.warnings };
}

/** 一次性补登记旧项目导入的资料；标记防止用户删除库素材后又被重新添加。 */
export function retainExistingImports() {
  if (db.query("SELECT 1 FROM settings WHERE key='materialRetentionV1'").get()) return;
  db.transaction(() => {
    const sources = db.query('SELECT * FROM sources').all() as Array<{ id: string; original_name: string; original_path: string; sha256: string; probe_json: string }>;
    for (const source of sources) {
      if (!existsSync(source.original_path)) continue;
      retainSourceOriginal({ ...source, probe: JSON.parse(source.probe_json) });
      const timing = join(STORAGE_ROOT, 'sources', source.id, 'timing.json');
      if (existsSync(timing)) retainSourceFrames(source.id, join(STORAGE_ROOT, 'sources', source.id), JSON.parse(readFileSync(timing, 'utf8')), source.original_name.replace(/\.[^.]+$/, ''));
    }
    const frames = db.query("SELECT f.id,f.raw_path,f.processed_path,f.source,f.metadata,p.name FROM frames f JOIN projects p ON p.id=f.project_id WHERE f.source IN ('image','extract')").all() as Array<{ id: string; raw_path: string | null; processed_path: string | null; source: string; metadata: string; name: string }>;
    for (const frame of frames) {
      const meta = JSON.parse(frame.metadata || '{}');
      if (meta.source_frame_id || meta.fromMaterial || !frame.raw_path || !existsSync(frame.raw_path)) continue;
      retainImportedMaterial({ key: 'frame:' + frame.id, name: `${frame.name} ${basename(frame.raw_path)}`, rawPath: frame.raw_path, processedPath: frame.processed_path, source: frame.source, metadata: { fromFrame: frame.id } });
    }
    db.query("INSERT INTO settings(key,value,updated_at) VALUES('materialRetentionV1','true',?)").run(Date.now());
  })();
}
