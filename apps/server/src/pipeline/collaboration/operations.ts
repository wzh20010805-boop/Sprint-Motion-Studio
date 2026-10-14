import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { canonicalizeJson, contentTokenSchema, requestIdentitySchema, validateBoundedJsonValue } from '@framebaker/shared';
import type { ActorContext, ContentToken, JsonValue, OperationRecord, RequestIdentity } from '@framebaker/shared';
import { db, uid } from '../../db';
import { PipelineError, validateId } from '../service';

const ajv = new Ajv({ strict: true, allErrors: true });
const validRequest = ajv.compile<RequestIdentity>(requestIdentitySchema);
const validContent = ajv.compile<ContentToken>(contentTokenSchema);

/** 拒绝 JSON 会静默丢弃的值，再使用已有 RFC8785 规范编码。 */
export function operationJson(value: unknown): string {
  if (validateBoundedJsonValue(value).length) throw new PipelineError('INVALID_PAYLOAD', '操作数据必须是有限、无循环的 JSON');
  return new TextDecoder().decode(canonicalizeJson(value as JsonValue));
}

export function collaborationHash(value: unknown): string {
  return createHash('sha256').update(operationJson(value)).digest('hex');
}

interface OperationRow {
  id: string; request_key: string; payload_hash: string; base_content_json: string | null; kind: string;
  state: OperationRecord['state']; attempt_job_ids_json: string; result_json: string | null; checkpoint_json: string | null;
}
function parsePersistedJson(value:string):any {try{return JSON.parse(value);}catch{throw new PipelineError('RECOVERY_IDENTITY_CONFLICT','持久JSON证据无法解析，已保留原字节',409);}}
function record(row: OperationRow): OperationRecord {
  return { id: row.id, request_key: row.request_key, payload_hash: row.payload_hash,
    base_content: row.base_content_json === null ? null : parsePersistedJson(row.base_content_json), kind: row.kind, state: row.state,
    attempt_job_ids: parsePersistedJson(row.attempt_job_ids_json), result: row.result_json === null ? null : parsePersistedJson(row.result_json),
    checkpoint: row.checkpoint_json === null ? null : parsePersistedJson(row.checkpoint_json) };
}

export function readOperation(id: string): OperationRecord {
  validateId(id);
  const row = db.query('SELECT * FROM collab_operations WHERE id=?').get(id) as OperationRow | null;
  if (!row) throw new PipelineError('OPERATION_NOT_FOUND', '操作记录不存在', 404);
  return record(row);
}

/** 恢复必须使用持久原负载；不能从当前草稿重建请求。 */
export function readOperationInput(id:string,kind:string):unknown {
  const op=readOperation(id);
  const row=db.query('SELECT payload_json FROM collab_operations WHERE id=?').get(id) as {payload_json:string};
  const input=parsePersistedJson(row.payload_json);
  if(op.kind!==kind||collaborationHash(input)!==op.payload_hash)throw new PipelineError('OPERATION_INPUT_MISMATCH','持久操作负载身份不符',409);
  const base = input && typeof input==='object' && !Array.isArray(input) ? input.base_content ?? null : null;
  if(operationJson(base)!==operationJson(op.base_content))throw new PipelineError('RECOVERY_IDENTITY_CONFLICT','原操作基础身份不符',409);
  const seen=new Set<string>();
  for(const [index,jobId] of op.attempt_job_ids.entries()){
    const job=db.query('SELECT operation_id,attempt_number FROM jobs WHERE id=?').get(jobId) as {operation_id:string;attempt_number:number}|null;
    if(seen.has(jobId)||!job||job.operation_id!==id||job.attempt_number!==index+1)throw new PipelineError('RECOVERY_IDENTITY_CONFLICT','操作尝试历史归属不符',409);seen.add(jobId);
  }
  return input;
}

export function claimOperation(kind: string, request: RequestIdentity, payload: unknown): OperationRecord {
  if (request?.request_key?.startsWith('server:')) throw new PipelineError('RESERVED_REQUEST_KEY', '服务端操作标识不能由客户端使用');
  return claim(kind,request,payload);
}

/** 服务端独占命名空间，加随机后缀防碰撞；唯一有效引用在审核事务中登记。 */
export function claimDeliveryOperation(payload: unknown): OperationRecord {
  return claim('deliver_candidate',{request_key:`server:delivery:${uid()}`},payload);
}

function claim(kind: string, request: RequestIdentity, payload: unknown): OperationRecord {
  if (!validRequest(request) || typeof kind !== 'string' || !kind.trim() || kind.length > 128) throw new PipelineError('INVALID_REQUEST', '操作类型或幂等标识无效');
  const payloadJson = operationJson(payload);
  const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
  const base = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>).base_content : undefined;
  if (base !== undefined && !validContent(base)) throw new PipelineError('INVALID_PAYLOAD', '原内容身份无效');
  return db.transaction(() => {
    const previous = db.query('SELECT * FROM collab_operations WHERE request_key=?').get(request.request_key) as OperationRow | null;
    if (previous) {
      if (previous.kind !== kind || previous.payload_hash !== payloadHash) throw new PipelineError('REQUEST_CONFLICT', 'REQUEST_CONFLICT: 幂等标识已用于不同操作内容', 409);
      return record(previous);
    }
    const id = uid(), now = Date.now();
    db.query(`INSERT INTO collab_operations(id,request_key,payload_hash,payload_json,base_content_json,kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, request.request_key, payloadHash, payloadJson, base === undefined ? null : operationJson(base), kind, now, now);
    return readOperation(id);
  }).immediate();
}

export function writeOperationCheckpoint(id: string, checkpoint: unknown): void {
  const json = operationJson(checkpoint);
  db.transaction(() => {
    const current=readOperation(id);
    if(current.state==='succeeded'&&operationJson(current.checkpoint)!==json)throw new PipelineError('OPERATION_ALREADY_COMMITTED','已提交检查点不可覆盖',409);
    if(current.state==='cancelled')throw new PipelineError('OPERATION_CANCELLED','操作已持久取消',409);
    const old=current.checkpoint as any,next=checkpoint as any;
    if(old?.operation_id&&(!next||next.operation_id!==id||next.attempt_id!==old.attempt_id))throw new PipelineError('RECOVERY_IDENTITY_CONFLICT','检查点尝试归属不符',409);
    db.query('UPDATE collab_operations SET checkpoint_json=?,updated_at=? WHERE id=?').run(json, Date.now(), id);
  }).immediate();
}

/** 队列注入恢复调度，工作模块不反向导入队列。 */
type RecoveryScheduler=(id:string,explicit?:boolean)=>Promise<OperationRecord>;
let recoveryScheduler:RecoveryScheduler|undefined;
export function setOperationRecoveryScheduler(schedule:RecoveryScheduler):void {recoveryScheduler=schedule;}
export async function resumeCollaborationOperation(id:string,actor:ActorContext):Promise<OperationRecord> {
 const {requireCurrentMaker}=await import('../../localSessions');requireCurrentMaker(actor);
 if(!recoveryScheduler)throw new PipelineError('RECOVERY_QUEUE_UNAVAILABLE','恢复队列尚未初始化',503);
 return recoveryScheduler(id,true);
}
/** 启动只协调已经持久登记的操作，不签发或重放审核身份。 */
export async function reconcileCollaborationOperations():Promise<void> {
 if(!recoveryScheduler)throw new PipelineError('RECOVERY_QUEUE_UNAVAILABLE','恢复队列尚未初始化',503);
 const rows=db.query("SELECT id FROM collab_operations WHERE state IN ('claimed','queued','running','interrupted','succeeded') AND (kind IN ('build_candidate','deliver_candidate','extract_source') OR state!='succeeded') ORDER BY created_at,id").all() as {id:string}[];
 for(const row of rows){try{await recoveryScheduler(row.id,false);}catch(error){
  if(error&&typeof error==='object'&&'code' in error&&String(error.code).startsWith('SQLITE'))throw error;
  if(!(error instanceof PipelineError))throw error;
  db.query("UPDATE collab_operations SET state='needs_input',updated_at=? WHERE id=? AND state NOT IN ('succeeded','cancelled')").run(Date.now(),row.id);
  // 历史提交损坏仍保留提交身份；普通文件适配继续拒绝损坏字节。
  db.query('UPDATE jobs SET error_code=?,error=?,updated_at=? WHERE operation_id=?').run(error.code,error.message,Date.now(),row.id);
 }}
}
