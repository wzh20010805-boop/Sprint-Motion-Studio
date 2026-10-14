import type {ActorContext} from '@framebaker/shared';
import {db} from '../../db';
import {requireCurrentMaker} from '../../localSessions';
import {cancelJob} from '../../queue';
import {PipelineError} from '../service';
import {readTaskRecord} from './store';
import {claimOperation,readOperation,operationJson} from './operations';
import {activeAcceptance,invalidateAcceptance,reviewTransaction} from './reviewBoundary';
/** 仅停止原操作；已提交结果仍是历史事实。 */
export function cancelOperation(id:string,actor:ActorContext){requireCurrentMaker(actor);const op=readOperation(id);if(op.state==='succeeded'||op.state==='cancelled')return op;
 const job=op.attempt_job_ids.at(-1);if(job)cancelJob(job);
 else reviewTransaction(()=>{if(op.kind==='deliver_candidate'){const taskId=(op.checkpoint as any)?.snapshot?.task_id;if(taskId&&activeAcceptance(taskId)?.operation_id===op.id)invalidateAcceptance(taskId,'delivery_cancelled');}db.query("UPDATE collab_operations SET state='cancelled',updated_at=? WHERE id=? AND state!='succeeded'").run(Date.now(),id);});
 return readOperation(id);
}
/** 任务取消单独进行代次 CAS；协作模式与成功历史不删除。 */
export function cancelTask(id:string,expected:number,request_key:string,actor:ActorContext){requireCurrentMaker(actor);
 const task=reviewTransaction(()=>{const operation=claimOperation('cancel_task',{request_key},{task_id:id,expected_acceptance_epoch:expected});if(operation.state==='succeeded')return operation.result as unknown as ReturnType<typeof readTaskRecord>;
 const before=readTaskRecord(id);if(before.acceptance_epoch!==expected)throw new PipelineError('TASK_SELECTION_CONFLICT','任务验收代次已变化',409);invalidateAcceptance(id,'task_cancelled');db.query("UPDATE collab_tasks SET state='cancelled',acceptance_epoch=acceptance_epoch+1,operation_ids_json=?,updated_at=? WHERE id=?").run(operationJson([...before.operation_ids,operation.id]),Date.now(),id);
 const result=readTaskRecord(id);db.query("UPDATE collab_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(operationJson(result),Date.now(),operation.id);return result;});
 for(const op of task.operation_ids)cancelOperation(op,actor);return task;
}
