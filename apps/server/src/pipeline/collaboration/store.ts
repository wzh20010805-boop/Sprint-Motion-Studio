import { Ajv } from 'ajv';
import { taskBriefSchema } from '@framebaker/shared';
import type { CollaborationTask, RequestIdentity, TaskBrief, WorkContext } from '@framebaker/shared';
import { db, uid } from '../../db';
import { getProject, getSource, PipelineError, validateId } from '../service';
import { claimOperation, collaborationHash, operationJson } from './operations';
import {verifiedTaskBrief} from './brief';

const validBrief = new Ajv({ strict: true, allErrors: true }).compile<TaskBrief>(taskBriefSchema);

function validateContext(context: WorkContext): void {
  getProject(context.project_id); validateId(context.axis_id);
  if (!db.query('SELECT id FROM animation_axes WHERE id=? AND project_id=?').get(context.axis_id, context.project_id)) throw new PipelineError('AXIS_NOT_FOUND', '动作不属于当前项目', 404);
}

export function setAxisWorkflowMode(context: WorkContext, mode: 'collaboration'): void {
  validateContext(context);
  if (mode !== 'collaboration') throw new PipelineError('INVALID_WORKFLOW_MODE', '进入协作流程后不能降级');
  db.query('INSERT OR IGNORE INTO axis_workflow_modes(project_id,axis_id,mode,created_at) VALUES(?,?,?,?)').run(context.project_id, context.axis_id, mode, Date.now());
}

export function axisWorkflowMode(context: WorkContext): 'legacy' | 'collaboration' {
  validateContext(context);
  return db.query('SELECT 1 FROM axis_workflow_modes WHERE project_id=? AND axis_id=?').get(context.project_id, context.axis_id) ? 'collaboration' : 'legacy';
}

interface TaskRow {
  id: string; project_id: string; axis_id: string; brief_version: number; content_revision: number; content_hash: string;
  state: CollaborationTask['state']; selected_candidate_id: string | null; acceptance_epoch: number; operation_ids_json: string;
}
export function readTaskRecord(id: string): CollaborationTask {
  validateId(id);
  const row = db.query('SELECT * FROM collab_tasks WHERE id=?').get(id) as TaskRow | null;
  if (!row) throw new PipelineError('TASK_NOT_FOUND', '协作任务不存在', 404);
  return { id: row.id, context: { project_id: row.project_id, axis_id: row.axis_id }, brief_version: row.brief_version,
    content_token: { revision: row.content_revision, hash: row.content_hash }, state: row.state,
    selected_candidate_id: row.selected_candidate_id, acceptance_epoch: row.acceptance_epoch, operation_ids: JSON.parse(row.operation_ids_json) };
}

export function createTaskRecord(brief: TaskBrief, request: RequestIdentity): CollaborationTask {
  brief=verifiedTaskBrief(brief);
  if (!validBrief(brief)) throw new PipelineError('INVALID_TASK_BRIEF', `任务要求无效: ${JSON.stringify(validBrief.errors)}`);
  return db.transaction(() => {
    const operation = claimOperation('create_task', request, brief);
    if (operation.state === 'succeeded' && operation.result && typeof operation.result === 'object' && !Array.isArray(operation.result) && typeof operation.result.task_id === 'string') return readTaskRecord(operation.result.task_id);
    validateContext(brief.context); getSource(brief.context.project_id, brief.source_id);
    const id = uid(), now = Date.now();
    const revision = (db.query('SELECT content_revision FROM projects WHERE id=?').get(brief.context.project_id) as { content_revision: number }).content_revision;
    const briefJson = operationJson(brief), briefHash = collaborationHash(brief);
    // preparing 身份绑定要求与制作修订；实际字节身份由后续制作快照建立。
    const contentHash = collaborationHash({ brief_hash: briefHash, content_revision: revision, context: brief.context });
    db.query(`INSERT INTO collab_tasks(id,project_id,axis_id,request_key,content_revision,content_hash,operation_ids_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, brief.context.project_id, brief.context.axis_id, request.request_key, revision, contentHash, JSON.stringify([operation.id]), now, now);
    db.query('INSERT INTO task_briefs(task_id,version,brief_json,brief_hash,created_at) VALUES(?,1,?,?,?)').run(id, briefJson, briefHash, now);
    setAxisWorkflowMode(brief.context, 'collaboration');
    db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson({ task_id: id }), now, operation.id);
    return readTaskRecord(id);
  }).immediate();
}
