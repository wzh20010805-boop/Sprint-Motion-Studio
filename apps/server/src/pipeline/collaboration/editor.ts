import type {ActionCollaborationState,WorkContext} from '@framebaker/shared';
import {db} from '../../db';
import {axisWorkflowMode,readTaskRecord} from './store';
import {draftState} from './timing';
/** 完整列出已知任务；排序只用于显示，调用方必须明确选择歧义任务。 */
export function readActionCollaboration(context:WorkContext):ActionCollaborationState {
 const mode=axisWorkflowMode(context);
 const rows=db.query('SELECT id FROM collab_tasks WHERE project_id=? AND axis_id=? ORDER BY id').all(context.project_id,context.axis_id) as {id:string}[];
 return {mode,tasks:rows.map(row=>readTaskRecord(row.id)),timing:draftState(context)?.timing??null};
}
