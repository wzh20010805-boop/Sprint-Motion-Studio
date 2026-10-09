import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { SourceTiming, VideoProbe } from "@framebaker/shared";
import { db, STORAGE_ROOT, uid } from "../db";
import { invalidateProjectUndo } from "../undo";
import { broadcast } from "../ws";
import { JobCancelledError } from "../jobs/run";
import { probeVideo } from "./probe";
import { extractAll, validateSourceArtifacts } from "./extractAll";

export class PipelineError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); this.name = "PipelineError"; }
}

interface ProjectRecord { id: string; name: string; revision: number; created_at: number; }
interface SourceRow { id: string; project_id: string; original_name: string; original_path: string; sha256: string; byte_size: number; probe_json: string; status: string; created_at: number; }
interface ClipRecord { id: string; project_id: string; source_id: string; axis_id: string; track_id: string; status: string; name: string; revision: number; fps: number; }
export interface SourceExtractPayload { projectId: string; sourceId: string; clipId: string; baseRevision: number; }

export function validateId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new PipelineError("INVALID_ID", "项目或素材 ID 无效");
}

export function getProject(projectId: string): ProjectRecord {
  validateId(projectId);
  const project = db.query("SELECT * FROM projects WHERE id=?").get(projectId) as ProjectRecord | null;
  if (!project) throw new PipelineError("PROJECT_NOT_FOUND", "项目不存在", 404);
  return project;
}

function sourceRecord(row: SourceRow) { const { probe_json, ...source } = row; return { ...source, probe: JSON.parse(probe_json) as VideoProbe }; }
export function getSource(projectId: string, sourceId: string) {
  getProject(projectId); validateId(sourceId);
  const row = db.query("SELECT * FROM sources WHERE id=?").get(sourceId) as SourceRow | null;
  if (!row) throw new PipelineError("SOURCE_NOT_FOUND", "源素材不存在", 404);
  if (row.project_id !== projectId) throw new PipelineError("SOURCE_PROJECT_MISMATCH", "源素材不属于项目", 409);
  return sourceRecord(row);
}

export function createProject(name: string) {
  if (!name.trim()) throw new PipelineError("INVALID_NAME", "项目名称不能为空");
  const id = uid();
  db.query("INSERT INTO projects(id,name,kind,created_at) VALUES(?,?,'frame',?)").run(id, name.trim().slice(0, 200), Date.now());
  mkdirSync(join(STORAGE_ROOT, "projects", id, "raw"), { recursive: true });
  mkdirSync(join(STORAGE_ROOT, "projects", id, "processed"), { recursive: true });
  return getProject(id);
}

export function inspectProject(projectId: string) {
  const project = getProject(projectId);
  const sources = (db.query("SELECT * FROM sources WHERE project_id=? ORDER BY created_at,id").all(projectId) as SourceRow[]).map(sourceRecord);
  const clips = db.query(`SELECT c.*,a.name,a.fps,p.revision FROM clips c JOIN animation_axes a ON a.id=c.axis_id JOIN projects p ON p.id=c.project_id WHERE c.project_id=? ORDER BY c.created_at,c.id`).all(projectId) as ClipRecord[];
  return { project, sources, clips };
}

/** 原视频只写入新的来源目录一次；格式由文件内容和 ffprobe 确认。 */
export async function importVideo(projectId: string, input: string | { name: string; bytes: Uint8Array }) {
  getProject(projectId);
  const bytes = typeof input === "string" ? readFileSync(input) : input.bytes;
  const originalName = basename((typeof input === "string" ? input : input.name).replaceAll("\\", "/"));
  if (!bytes.length) throw new PipelineError("INVALID_VIDEO", "视频文件为空");
  const capacity = statfsSync(STORAGE_ROOT);
  if (Number(capacity.bavail) * Number(capacity.bsize) < bytes.byteLength * 2) throw new PipelineError("INSUFFICIENT_DISK", "工作区可用空间不足");
  const magic = Buffer.from(bytes.subarray(0, 16));
  const ext = magic.subarray(4, 8).toString("ascii") === "ftyp" ? "mp4" : magic.length >= 4 && magic.readUInt32BE(0) === 0x1a45dfa3 ? "webm" : "bin";
  const id = uid(); const sourceDirectory = join(STORAGE_ROOT, "sources", id);
  mkdirSync(sourceDirectory, { recursive: true });
  const originalPath = join(sourceDirectory, `original.${ext}`);
  writeFileSync(originalPath, bytes, { flag: "wx" });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let probe: VideoProbe;
  try { probe = await probeVideo(originalPath); }
  catch (error) {
    writeFileSync(join(sourceDirectory, "source.json"), JSON.stringify({ schema_version: "1.0", source_id: id, original_name: originalName, sha256, validation: "rejected", error: (error as Error).message }, null, 2), { flag: "wx" });
    const missing = (error as {code?:string}).code === "DEPENDENCY_MISSING";
    throw new PipelineError(missing ? "DEPENDENCY_MISSING" : "INVALID_VIDEO", (error as Error).message, missing ? 503 : 400);
  }
  getProject(projectId);
  const createdAt = Date.now();
  writeFileSync(join(sourceDirectory, "source.json"), JSON.stringify({ schema_version: "1.0", source_id: id, project_id: projectId, original_name: originalName, original_path: originalPath, sha256, byte_size: bytes.byteLength, probe, created_at: createdAt }, null, 2), { flag: "wx" });
  db.transaction(() => {
    getProject(projectId);
    db.query("INSERT INTO sources(id,project_id,original_name,original_path,sha256,byte_size,probe_json,status,created_at) VALUES(?,?,?,?,?,?,?,'imported',?)").run(id, projectId, originalName, originalPath, sha256, bytes.byteLength, JSON.stringify(probe), createdAt);
    db.query("UPDATE projects SET revision=revision+1 WHERE id=?").run(projectId);
  })();
  return getSource(projectId, id);
}

function previewFps(probe: VideoProbe): number {
  const rate = probe.nominalFrameRate ?? probe.averageFrameRate;
  return rate && rate.num > 0 ? Math.max(1, Math.min(1000, Math.round(rate.num / rate.den))) : 24;
}

export function createClip(projectId: string, sourceId: string, name: string) {
  const source = getSource(projectId, sourceId);
  if (!name.trim()) throw new PipelineError("INVALID_NAME", "动作名称不能为空");
  const clipId = uid(); const fps = previewFps(source.probe);
  db.transaction(() => {
    getSource(projectId, sourceId);
    let axis = db.query(`SELECT a.id FROM animation_axes a WHERE a.project_id=? AND NOT EXISTS(SELECT 1 FROM clips c WHERE c.axis_id=a.id) AND NOT EXISTS(SELECT 1 FROM animation_steps s WHERE s.axis_id=a.id) AND NOT EXISTS(SELECT 1 FROM frames f JOIN animation_tracks t ON t.id=f.track_id WHERE t.axis_id=a.id) ORDER BY a.idx LIMIT 1`).get(projectId) as { id: string } | null;
    if (!axis) {
      axis = { id: uid() };
      const idx = (db.query("SELECT COALESCE(MAX(idx),-1)+1 AS next FROM animation_axes WHERE project_id=?").get(projectId) as { next: number }).next;
      db.query("INSERT INTO animation_axes(id,project_id,name,idx,fps,created_at) VALUES(?,?,?,?,?,?)").run(axis.id, projectId, name.trim(), idx, fps, Date.now());
    } else db.query("UPDATE animation_axes SET name=?,fps=? WHERE id=?").run(name.trim(), fps, axis.id);
    let track = db.query("SELECT id FROM animation_tracks WHERE axis_id=? AND is_primary=1 ORDER BY idx LIMIT 1").get(axis.id) as { id: string } | null;
    if (!track) {
      track = { id: uid() };
      const idx = (db.query("SELECT COALESCE(MAX(idx),-1)+1 AS next FROM animation_tracks WHERE axis_id=?").get(axis.id) as { next: number }).next;
      db.query("INSERT INTO animation_tracks(id,axis_id,name,idx,visible,locked,is_primary) VALUES(?,?,'Main',?,1,0,1)").run(track.id, axis.id, idx);
    }
    db.query("INSERT INTO clips(id,project_id,source_id,axis_id,track_id,created_at) VALUES(?,?,?,?,?,?)").run(clipId, projectId, sourceId, axis.id, track.id, Date.now());
  })();
  invalidateProjectUndo(projectId);
  broadcast("timeline_changed", { projectId });
  return getClip(projectId, clipId);
}

export function getClip(projectId: string, clipId: string): ClipRecord {
  getProject(projectId); validateId(clipId);
  const clip = db.query(`SELECT c.*,a.name,a.fps,p.revision FROM clips c JOIN animation_axes a ON a.id=c.axis_id JOIN projects p ON p.id=c.project_id WHERE c.id=?`).get(clipId) as ClipRecord | null;
  if (!clip) throw new PipelineError("CLIP_NOT_FOUND", "动作不存在", 404);
  if (clip.project_id !== projectId) throw new PipelineError("CLIP_PROJECT_MISMATCH", "动作不属于项目", 409);
  return clip;
}

export function prepareSourceExtraction(projectId: string, clipId: string, baseRevision?: number): SourceExtractPayload {
  const clip = getClip(projectId, clipId);
  if (clip.status === "extracted") throw new PipelineError("CLIP_ALREADY_EXTRACTED", "动作已完成抽帧，请创建新动作引用源素材", 409);
  const expected = baseRevision ?? clip.revision;
  if (!Number.isSafeInteger(expected) || expected < 0) throw new PipelineError("INVALID_REVISION", "基础修订号无效");
  if (clip.revision !== expected) throw new PipelineError("REVISION_CONFLICT", "项目修订已变化", 409);
  return { projectId, sourceId: clip.source_id, clipId, baseRevision: expected };
}

/** queue → service 单向调用；产物先完整验证，再在单个事务内投影到上游主轨。 */
export async function extractSource(payload: SourceExtractPayload, progress: (text: string) => void = () => {}, signal?: AbortSignal) {
  if (signal?.aborted) throw new JobCancelledError();
  const clip = getClip(payload.projectId, payload.clipId);
  if (clip.source_id !== payload.sourceId) throw new PipelineError("SOURCE_CLIP_MISMATCH", "动作源素材不匹配", 409);
  if (clip.revision !== payload.baseRevision) throw new PipelineError("STALE_JOB_RESULT", "项目修订已变化，旧任务不能覆盖当前项目", 409);
  const source = getSource(payload.projectId, payload.sourceId);
  const directory = join(STORAGE_ROOT, "sources", source.id);
  if (createHash("sha256").update(readFileSync(source.original_path)).digest("hex") !== source.sha256) throw new PipelineError("SOURCE_FINGERPRINT_MISMATCH", "原视频校验和已变化");
  let timing: SourceTiming; let warnings: string[];
  if (existsSync(join(directory, "timing.json")) && existsSync(join(directory, "raw"))) {
    timing = await validateSourceArtifacts(directory, source.id, source.probe, signal); warnings = [...timing.warnings];
  } else {
    const extracted = await extractAll(source.original_path, directory, { sourceId: source.id, signal, onProgress: progress });
    timing = extracted.timing; warnings = [...extracted.warnings];
  }
  if (!timing.frames.length || timing.source_id !== source.id) throw new PipelineError("INVALID_TIMING", "源时间清单无效");
  if (signal?.aborted) throw new JobCancelledError();
  const copies = join(STORAGE_ROOT, "projects", payload.projectId, "raw", clip.id, uid());
  mkdirSync(copies, { recursive: true });
  const cells = timing.frames.map((frame, index) => {
    if (signal?.aborted) throw new JobCancelledError();
    if (frame.source_index !== index || !/^raw\/frame_\d{6}\.png$/.test(frame.file)) throw new PipelineError("INVALID_TIMING", "源帧索引或文件路径无效");
    const path = join(copies, basename(frame.file));
    copyFileSync(join(directory, frame.file), path, constants.COPYFILE_EXCL);
    const seconds = frame.display_duration.num / frame.display_duration.den;
    const ticks = Math.max(1, Math.round(seconds * clip.fps));
    if (Math.abs(ticks / clip.fps - seconds) > 1e-9 && !warnings.includes("PREVIEW_TIMING_QUANTIZED")) warnings.push("PREVIEW_TIMING_QUANTIZED");
    return { frame, path, ticks, frameId: uid(), stepId: uid() };
  });
  if (signal?.aborted) throw new JobCancelledError();
  db.transaction(() => {
    const current = getClip(payload.projectId, payload.clipId);
    if (current.revision !== payload.baseRevision) throw new PipelineError("STALE_JOB_RESULT", "项目修订已变化，旧产物已保留但未提交", 409);
    if (current.status === "extracted" || db.query("SELECT 1 FROM animation_steps WHERE axis_id=? LIMIT 1").get(clip.axis_id)) throw new PipelineError("CLIP_NOT_EMPTY", "动作已有编辑数据，不能覆盖", 409);
    for (const cell of cells) {
      const f = cell.frame;
      db.query(`INSERT OR IGNORE INTO source_frames(source_frame_id,source_id,source_index,file,pts,time_base_num,time_base_den,presentation_num,presentation_den,duration_num,duration_den,duration_origin,decode_status,timing_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.source_frame_id, source.id, f.source_index, f.file, f.pts, f.time_base.num, f.time_base.den, f.presentation_time.num, f.presentation_time.den, f.display_duration.num, f.display_duration.den, f.duration_origin, f.decode_status, JSON.stringify(f));
      db.query("INSERT INTO animation_steps(id,axis_id,idx,duration) VALUES(?,?,?,?)").run(cell.stepId, clip.axis_id, f.source_index, cell.ticks);
      db.query(`INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,status,duration,source,metadata) VALUES(?,?,?,?,?,?,'ready',?,'extract',?)`).run(cell.frameId, payload.projectId, clip.track_id, cell.stepId, f.source_index, cell.path, cell.ticks, JSON.stringify({ source_id: source.id, source_frame_id: f.source_frame_id, source_index: f.source_index, timing: f }));
    }
    db.query("UPDATE sources SET status='extracted' WHERE id=?").run(source.id);
    db.query("UPDATE clips SET status='extracted' WHERE id=?").run(clip.id);
  })();
  invalidateProjectUndo(payload.projectId);
  broadcast("timeline_changed", { projectId: payload.projectId });
  broadcast("frames_changed", { projectId: payload.projectId });
  return { source_id: source.id, clip_id: clip.id, frame_count: cells.length, revision: getProject(payload.projectId).revision, source_duration: timing.duration, preview_duration_seconds: cells.reduce((sum, cell) => sum + cell.ticks / clip.fps, 0), warnings, artifacts: [{ kind: "source_timing", path: join(directory, "timing.json") }, { kind: "source_frames", path: join(directory, "raw") }] };
}
