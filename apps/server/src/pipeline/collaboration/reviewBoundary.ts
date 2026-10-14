import type {AcceptanceCheckpoint,AcceptanceRevocation,DeliveryRequest,JsonValue} from '@framebaker/shared';
import {db} from '../../db';
import {operationJson,readOperation} from './operations';

/** 审核、选择、取消及最终发布共用同步 SQLite 写入边界；禁止在 callback 内执行异步打包。 */
export function reviewTransaction<T>(work:()=>T):T {return db.transaction(()=>{
  const result=work();
  if(result&&typeof (result as {then?:unknown}).then==='function')throw new Error('ASYNC_REVIEW_TRANSACTION');
  return result;
}).immediate();}
export function activeAcceptance(taskId:string):DeliveryRequest|null {
  const row=db.query("SELECT json_extract(recovery_json,'$.acceptance') AS value FROM collab_tasks WHERE id=?").get(taskId) as {value:string|null}|null;
  return row?.value?JSON.parse(row.value):null;
}
/** 撤销永久附着于原操作，保留原负载、结果和文件；后续任务可追加发布字段。 */
export function invalidateAcceptance(taskId:string,reason:string,reviewRevision:number|null=null):void {
  reviewTransaction(()=>invalidateInTransaction(taskId,reason,reviewRevision));
}
function invalidateInTransaction(taskId:string,reason:string,reviewRevision:number|null):void {
  const active=activeAcceptance(taskId);if(!active)return;
  const op=readOperation(active.operation_id),checkpoint=op.checkpoint as unknown as AcceptanceCheckpoint;
  const revocation:AcceptanceRevocation={reason,at:Date.now(),review_revision:reviewRevision};
  db.query('UPDATE collab_operations SET checkpoint_json=?,updated_at=? WHERE id=?').run(operationJson({...checkpoint,revocation:checkpoint?.revocation??revocation}),Date.now(),op.id);
  if(op.state==='succeeded'&&op.result&&typeof op.result==='object'&&!Array.isArray(op.result)){
    const result:Record<string,JsonValue>={...op.result,approval_status:'withdrawn'};
    db.query('UPDATE collab_operations SET result_json=?,updated_at=? WHERE id=?').run(operationJson(result),Date.now(),op.id);
  }
  db.query("UPDATE collab_tasks SET recovery_json=json_remove(COALESCE(recovery_json,'{}'),'$.acceptance'),state=CASE WHEN state IN ('accepted','packaging','delivered') THEN 'awaiting_review' ELSE state END,updated_at=? WHERE id=?").run(Date.now(),taskId);
}
