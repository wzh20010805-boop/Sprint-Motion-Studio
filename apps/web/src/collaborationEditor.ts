import type {ActionExportResolution,CollaborationTask,ContentToken,DraftEditContext,WorkContext} from '@framebaker/shared';
import {t} from './i18n';
/** 原有生产解析器保留无令牌旧动作；任何拒绝都必须原样阻断，不能回退导出。 */
export async function resolveAnimationExport(context:WorkContext,format:'sequence'|'spritesheet',taskId?:string):Promise<ActionExportResolution>{
 const query=new URLSearchParams({...context,format});if(taskId)query.set('task_id',taskId);
 const response=await fetch(`/api/v1/export/resolve?${query}`),envelope=await response.json();
 if(!response.ok||!envelope.ok)throw new Error(envelope.error?.message??t('export.resolveFailed'));
 const resolution=envelope.data as ActionExportResolution;
 if(resolution.mode==='ambiguous')throw new Error(t('export.ambiguousTask'));
 if(resolution.mode!=='legacy'&&resolution.mode!=='candidate')throw new Error(t('export.unknownMode'));
 return resolution;
}
export async function routeAlignmentExport(context:WorkContext,taskId:string|undefined,legacy:()=>Promise<unknown>,fixed:()=>Promise<unknown>){
 const resolution=await resolveAnimationExport(context,'sequence',taskId);
 await (resolution.mode==='legacy'?legacy():fixed());
}
/** 返工已由工作台提交；这里只校验回执，不发起第二次返工。 */
export function draftEditContext(taskId:string,parentId:string,result:{task:CollaborationTask;content_token:ContentToken}):DraftEditContext {
 if(result.task.id!==taskId||result.task.state!=='reworking')throw Error('REWORK_CONTEXT_MISMATCH');
 return {...result.task.context,task_id:taskId,parent_candidate_id:parentId,content_token:result.content_token};
}
