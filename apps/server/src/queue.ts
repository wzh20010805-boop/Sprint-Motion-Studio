import type { JobType } from "@framebaker/shared";
import { db, uid } from "./db";
import { broadcast } from "./ws";
import { buildGeneratedFollowUp, extractFrames, generateFrames, type ExtractPayload, type GeneratePayload } from "./jobs/extract";
import { getSettingJson } from "./provider";
import { matte } from "./jobs/matting";
import { JobCancelledError } from "./jobs/run";
import { splitImageLayers, type ImageLayersPayload } from "./jobs/imageLayers";
import { extractSource, getSource, PipelineError, prepareSourceExtraction, type SourceExtractPayload } from "./pipeline/service";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STORAGE_ROOT } from "./db";
import { matteBatch, prepareMatte } from './pipeline/masks';
import type { MatteRequest } from '@framebaker/shared';
import type { ExportRequest } from '@framebaker/shared';
import { exportAssets,prepareExport,type ExportPayload } from './pipeline/export';

export interface JobPayload {
  productionExport?: ExportPayload;
  extract?: ExtractPayload;
  generate?: GeneratePayload;
  matting?: { target: "frame" | "material"; id: string };
  imageLayers?: ImageLayersPayload;
  sourceExtract?: SourceExtractPayload;
  sceneMatting?: MatteRequest & { base_revision: number };
}

// 内存缓存仅服务本次队列；完整参数与结果持久化，重启后明确标记 interrupted。
const payloads = new Map<string, JobPayload>();
const controllers = new Map<string, AbortController>();
const waiting: string[] = [];
let running = 0;

/**
 * 任务队列并发数：settings.queueConcurrency 优先（clamp 1~16），env FRAMEBAKER_QUEUE_CONCURRENCY 兜底，默认 2。
 * 每次实时读取，设置页改动即时生效（pump 频率低，单次轻量 DB 查询开销可忽略）。
 */
export function getQueueConcurrency(): number {
  const clamp = (n: number) => Math.max(1, Math.min(16, Math.floor(n)));
  const saved = getSettingJson<number>("queueConcurrency");
  if (typeof saved === "number" && saved >= 1) return clamp(saved);
  const env = Number(process.env.FRAMEBAKER_QUEUE_CONCURRENCY);
  if (Number.isFinite(env) && env >= 1) return clamp(env);
  return 2;
}

// 启动时把上次进程遗留的 queued/running 任务标记为中断（负载随内存丢失，不可能再继续）
db.query("UPDATE jobs SET status = 'interrupted', error = '服务重启，任务中断；请从抽帧阶段重新开始', error_code='SERVICE_RESTARTED', updated_at=? WHERE status IN ('queued', 'running')").run(Date.now());

export function createJob(projectId: string, type: JobType, payload: JobPayload): string {
  const id = uid();
  const directory = join(STORAGE_ROOT, "jobs", id);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "job.log");
  appendFileSync(logPath, `${new Date().toISOString()} queued\n`);
  const source = payload.sourceExtract ? getSource(projectId, payload.sourceExtract.sourceId) : null;
  db.query("INSERT INTO jobs (id, project_id, type, status, created_at, updated_at,payload,clip_id,base_revision,input_fingerprint,backend,log_path) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    projectId,
    type,
    Date.now(), Date.now(), JSON.stringify(payload), payload.sourceExtract?.clipId ?? null,
    payload.sourceExtract?.baseRevision ?? payload.sceneMatting?.base_revision ?? payload.productionExport?.revision ?? null, source?.sha256 ?? payload.productionExport?.fingerprint ?? null,
    payload.sourceExtract ? "ffmpeg-passthrough" : payload.sceneMatting ? 'rembg-cpu/u2netp' : payload.productionExport ? 'pillow-straight-alpha' : null, logPath
  );
  payloads.set(id, payload);
  waiting.push(id);
  broadcast("job_queued", { id, projectId, type });
  pump();
  return id;
}

export function createSourceExtractionJob(projectId: string, clipId: string, baseRevision?: number): string {
  const sourceExtract = prepareSourceExtraction(projectId, clipId, baseRevision);
  const active = db.query("SELECT id FROM jobs WHERE status IN ('queued','running') AND (clip_id=? OR json_extract(payload,'$.sourceExtract.sourceId')=?) LIMIT 1").get(clipId, sourceExtract.sourceId);
  if (active) throw new PipelineError("EXTRACTION_BUSY", "动作或源素材已有抽帧任务", 409);
  return createJob(projectId, "extract_frames", { sourceExtract });
}

export function createSceneMattingJob(request: MatteRequest): string {
  const prepared = prepareMatte(request);
  if (db.query("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(request.project_id)) throw new PipelineError('PROJECT_BUSY','项目已有任务，请完成或取消后再抠图',409);
  return createJob(request.project_id, 'matting', { sceneMatting: prepared });
}

export function createExportJob(request:ExportRequest):string {
 if(db.query("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')").get(request.project_id))throw new PipelineError('PROJECT_BUSY','项目已有任务，请完成或取消后导出',409);
 return createJob(request.project_id,'export_assets',{productionExport:prepareExport(request)});
}

export function resumeJob(id:string):string {
 const job=getPersistedJob(id);
 if(!job)throw new PipelineError('JOB_NOT_FOUND','任务不存在',404);
 if(!['interrupted','error','cancelled'].includes(String(job.status)))throw new PipelineError('JOB_NOT_RESUMABLE','只能恢复中断、失败或取消的任务',409);
 const p=job.payload;
 if(p.productionExport)return createExportJob({...p.productionExport.request,base_revision:undefined});
 if(p.sourceExtract)return createSourceExtractionJob(String(job.project_id),p.sourceExtract.clipId);
 if(p.sceneMatting)return createSceneMattingJob({...p.sceneMatting,base_revision:undefined});
 throw new PipelineError('JOB_NOT_RESUMABLE','此旧版任务没有受支持的恢复参数',409);
}

export function getPersistedJob(id: string): (Record<string, unknown> & { payload: JobPayload; result: unknown | null }) | null {
  const row = db.query("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return { ...row, payload: JSON.parse(String(row.payload ?? "{}")), result: row.result ? JSON.parse(String(row.result)) : null };
}

/** 图片批量生成拆成独立任务，由全局队列统一控制并发；视频仍只创建一个任务。 */
export function createGenerationJobs(projectId: string, generate: GeneratePayload): string[] {
  const count = generate.mediaKind === "video" ? 1 : generate.count;
  return Array.from({ length: count }, (_, batchIndex) =>
    createJob(projectId, "generate_frames", {
      generate: {
        ...generate,
        count: 1,
        batchCount: count,
        batchIndex,
      },
    })
  );
}

/**
 * 取消任务：queued 直接出队；running 触发 AbortSignal。
 * 返回 false 表示不存在或已结束不可取消。
 */
export function cancelJob(id: string): boolean {
  const job = db.query("SELECT id, project_id, type, status FROM jobs WHERE id = ?").get(id) as {
    id: string;
    project_id: string;
    type: string;
    status: string;
  } | null;
  if (!job) return false;
  if (job.status === "queued") {
    const idx = waiting.indexOf(id);
    if (idx >= 0) waiting.splice(idx, 1);
    setJob(id, "cancelled", "已取消", null);
    payloads.delete(id);
    broadcast("job_cancelled", { id, projectId: job.project_id, type: job.type });
    return true;
  }
  if (job.status === "running") {
    const c = controllers.get(id);
    if (c && !c.signal.aborted) c.abort();
    return true;
  }
  return false;
}

/** 同一 frame/material 是否已有排队或运行中的抠图任务 */
export function findActiveMattingJob(target: "frame" | "material", targetId: string): string | null {
  for (const [jobId, payload] of payloads) {
    const m = payload.matting;
    if (!m || m.target !== target || m.id !== targetId) continue;
    const row = db.query("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | null;
    if (row && (row.status === "queued" || row.status === "running")) return jobId;
  }
  return null;
}

/**
 * 入队抠图（同目标已有 queued/running 则拒绝，避免同一图无限重复抠）。
 * 返回 jobId，或已有任务 id（duplicate=true）。
 */
export function createMattingJob(
  projectId: string,
  target: "frame" | "material",
  targetId: string
): { jobId: string; duplicate: boolean } {
  const existing = findActiveMattingJob(target, targetId);
  if (existing) return { jobId: existing, duplicate: true };
  return { jobId: createJob(projectId, "matting", { matting: { target, id: targetId } }), duplicate: false };
}

function enqueueMatting(projectId: string, target: "frame" | "material", id: string) {
  createMattingJob(projectId, target, id); // 已有进行中任务则忽略（拆帧/生成后的自动抠图）
}

function enqueueGeneratedFollowUp(source: GeneratePayload, referenceMaterialId: string) {
  const material = db.query("SELECT raw_path FROM materials WHERE id = ?").get(referenceMaterialId) as { raw_path: string | null } | null;
  if (!material?.raw_path) throw new Error("完整角色已生成，但素材文件缺失，无法继续拆分");
  const followUp = buildGeneratedFollowUp(source, referenceMaterialId, material.raw_path);
  if (!followUp) return;
  if (source.characterPartSetId) {
    // 首次生成建立身份基准；已有基准不可被后续试生成静默覆盖。
    db.query("UPDATE character_part_sets SET reference_material_id = ?, updated_at = ? WHERE id = ? AND reference_material_id IS NULL")
      .run(referenceMaterialId, Date.now(), source.characterPartSetId);
  }
  createJob("", "generate_frames", { generate: followUp });
}

function pump() {
  while (running < getQueueConcurrency() && waiting.length > 0) {
    const id = waiting.shift()!;
    // 可能已被取消但尚未移出（竞态兜底）
    const row = db.query("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string } | null;
    if (!row || row.status === "cancelled") {
      payloads.delete(id);
      continue;
    }
    running++;
    runJob(id).finally(() => {
      running--;
      pump();
    });
  }
}

function setJob(id: string, status: string, progress?: string | null, error?: string | null) {
  db.query("UPDATE jobs SET status = ?, progress = COALESCE(?, progress), error = COALESCE(?, error),updated_at=? WHERE id = ?").run(
    status,
    progress ?? null,
    error ?? null,
    Date.now(), id
  );
  const row = db.query("SELECT log_path FROM jobs WHERE id=?").get(id) as { log_path: string | null } | null;
  if (row?.log_path) appendFileSync(row.log_path, `${new Date().toISOString()} ${status} ${error ?? progress ?? ""}\n`);
}

async function runJob(id: string) {
  const job = db.query("SELECT * FROM jobs WHERE id = ?").get(id) as {
    id: string;
    project_id: string;
    type: string;
  } | null;
  if (!job) return;
  const payload = payloads.get(id) ?? {};
  const ac = new AbortController();
  controllers.set(id, ac);
  const signal = ac.signal;
  let generatedReferenceId: string | undefined;
  let completionProgress = "完成";
  let result: unknown = null;
  // 相同 progress 文本去重（如视频轮询每 5s 的重复心跳），避免无谓 DB 写 + 全局广播
  let lastProgress = "";
  const report = (p: string) => {
    if (signal.aborted) return;
    if (p === lastProgress) return;
    lastProgress = p;
    setJob(id, "running", p);
    broadcast("job_progress", { id, projectId: job.project_id, progress: p });
  };
  setJob(id, "running", "开始处理");
  broadcast("job_running", { id, projectId: job.project_id });
  try {
    if (signal.aborted) throw new JobCancelledError();
    if (payload.productionExport) {
      result = await exportAssets(payload.productionExport,report,signal);
    } else if (job.type === "extract_frames" && payload.sourceExtract) {
      result = await extractSource(payload.sourceExtract, report, signal);
    } else if (job.type === "extract_frames" && payload.extract) {
      result = await extractFrames(payload.extract, report, enqueueMatting, signal);
    } else if (job.type === "generate_frames" && payload.generate) {
      const generated = await generateFrames(payload.generate, report, enqueueMatting, signal);
      result = generated;
      if (payload.generate.followUp && generated.artifacts[0]?.kind === "image") generatedReferenceId = generated.artifacts[0].id;
      if (generated.warning) completionProgress = `完成（${generated.warning}）`;
    } else if (job.type === "matting" && payload.sceneMatting) {
      result = await matteBatch(payload.sceneMatting, report, signal);
    } else if (job.type === "matting" && payload.matting) {
      if (signal.aborted) throw new JobCancelledError();
      const warn = await matte(payload.matting.target, payload.matting.id, signal);
      if (warn) report(warn); // 引擎缺失等警告写进 job.progress
    } else if (job.type === "image_layers" && payload.imageLayers) {
      await splitImageLayers(payload.imageLayers, report, signal);
    } else {
      throw new Error(`未知任务类型: ${job.type}`);
    }
    if (signal.aborted) throw new JobCancelledError();
    if (generatedReferenceId && payload.generate) enqueueGeneratedFollowUp(payload.generate, generatedReferenceId);
    db.query("UPDATE jobs SET result=?,checkpoint=? WHERE id=?").run(result === null ? null : JSON.stringify(result), JSON.stringify({ stage: "complete" }), id);
    const needsReview = !!payload.sceneMatting;
    db.query('UPDATE jobs SET requires_user_action=? WHERE id=?').run(needsReview ? 1 : 0,id);
    setJob(id, needsReview ? 'waiting_user' : 'done', needsReview ? '抠图初稿已生成，请检查武器与边缘' : completionProgress);
    broadcast("job_done", { id, projectId: job.project_id, type: job.type, status: needsReview ? 'waiting_user' : 'done', progress: needsReview ? '抠图初稿已生成，请检查武器与边缘' : completionProgress });
  } catch (err) {
    if (err instanceof JobCancelledError || signal.aborted) {
      setJob(id, "cancelled", "已取消", null);
      broadcast("job_cancelled", { id, projectId: job.project_id, type: job.type });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const taggedCode = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "JOB_FAILED";
      db.query("UPDATE jobs SET error_code=? WHERE id=?").run(err instanceof PipelineError ? err.code : taggedCode, id);
      console.error(`[job ${id}] ${job.type} 失败:`, msg);
      setJob(id, "error", null, msg);
      broadcast("job_error", { id, projectId: job.project_id, type: job.type, error: msg });
    }
  } finally {
    controllers.delete(id);
    payloads.delete(id);
  }
}
