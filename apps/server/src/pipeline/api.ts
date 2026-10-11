import { Elysia, t } from "elysia";
import { db } from "../db";
import { cancelJob, createSourceExtractionJob, getPersistedJob } from "../queue";
import { createClip, createProject, getProject, importVideo, inspectProject, PipelineError, validateId } from "./service";

export function pipelineEnvelope(data: unknown = {}, options: { status?: string; projectId?: string; jobId?: string; warnings?: string[]; artifacts?: unknown[]; ok?: boolean; error?: { code: string; message: string } | null } = {}) {
  return { schema_version: "1.0", ok: options.ok ?? true, status: options.status ?? "succeeded", ...(options.jobId ? { job_id: options.jobId } : {}), project_id: options.projectId ?? null, requires_user_action: options.status === 'waiting_user', data, artifacts: options.artifacts ?? [], warnings: options.warnings ?? [], error: options.error ?? null };
}

export function pipelineErrorResponse(error: unknown, projectId?: string) {
  const failure = error instanceof PipelineError ? error : new PipelineError("EXECUTION_ERROR", error instanceof Error ? error.message : String(error), 500);
  return Response.json(pipelineEnvelope({}, { ok: false, status: "failed", projectId, error: { code: failure.code, message: failure.message } }), { status: failure.httpStatus });
}

const mappedStatus = (status: unknown) => status === "done" ? "succeeded" : status === "error" ? "failed" : String(status);

export const pipelineApi = new Elysia({ prefix: "/api/v1" })
  .onError(({ error, code }) => pipelineErrorResponse(new PipelineError(code === "VALIDATION" ? "INVALID_INPUT" : "EXECUTION_ERROR", error instanceof Error ? error.message : String(error), code === "VALIDATION" ? 400 : 500)))
  .get("/projects", () => pipelineEnvelope({ projects: db.query("SELECT * FROM projects ORDER BY created_at DESC,id").all() }))
  .post("/projects", ({ body }) => {
    try { const project = createProject(body.name); return pipelineEnvelope({ project }, { projectId: project.id }); }
    catch (error) { return pipelineErrorResponse(error); }
  }, { body: t.Object({ name: t.String() }) })
  .get("/projects/:id", ({ params }) => {
    try { return pipelineEnvelope(inspectProject(params.id), { projectId: params.id }); }
    catch (error) { return pipelineErrorResponse(error, params.id); }
  })
  .post("/sources/import", async ({ body }) => {
    try {
      const source = await importVideo(body.projectId, { name: body.file.name, bytes: new Uint8Array(await body.file.arrayBuffer()) });
      return pipelineEnvelope({ source_id: source.id, source }, { projectId: body.projectId, warnings: source.probe.warnings });
    } catch (error) { return pipelineErrorResponse(error, body.projectId); }
  }, { body: t.Object({ projectId: t.String(), file: t.File() }) })
  .post("/clips", ({ body }) => {
    try { const clip = createClip(body.project_id, body.source_id, body.name); return pipelineEnvelope({ clip_id: clip.id, clip }, { projectId: body.project_id }); }
    catch (error) { return pipelineErrorResponse(error, body.project_id); }
  }, { body: t.Object({ project_id: t.String(), source_id: t.String(), name: t.String() }) })
  .post("/extract", ({ body }) => {
    try {
      const jobId = createSourceExtractionJob(body.project_id, body.clip_id, body.base_revision);
      return pipelineEnvelope({}, { status: "accepted", projectId: body.project_id, jobId });
    } catch (error) { return pipelineErrorResponse(error, body.project_id); }
  }, { body: t.Object({ project_id: t.String(), clip_id: t.String(), mode: t.Literal("all"), base_revision: t.Optional(t.Integer({ minimum: 0 })) }) })
  .get("/jobs/:id", ({ params }) => {
    try {
      validateId(params.id);
      const job = getPersistedJob(params.id);
      if (!job) throw new PipelineError("JOB_NOT_FOUND", "任务不存在", 404);
      const result = job.result as { warnings?: string[]; artifacts?: unknown[] } | null;
      return pipelineEnvelope({ job }, { status: mappedStatus(job.status), projectId: String(job.project_id), jobId: params.id, warnings: result?.warnings, artifacts: result?.artifacts, error: job.error ? { code: String(job.error_code ?? "JOB_FAILED"), message: String(job.error) } : null });
    } catch (error) { return pipelineErrorResponse(error); }
  })
  .post("/jobs/:id/cancel", ({ params }) => {
    try {
      validateId(params.id);
      const job = getPersistedJob(params.id);
      if (!job) throw new PipelineError("JOB_NOT_FOUND", "任务不存在", 404);
      if (!cancelJob(params.id)) throw new PipelineError("JOB_NOT_CANCELLABLE", "任务已结束，无法取消", 409);
      return pipelineEnvelope({ job: getPersistedJob(params.id) }, { status: "accepted", projectId: String(job.project_id), jobId: params.id });
    } catch (error) { return pipelineErrorResponse(error); }
  });
