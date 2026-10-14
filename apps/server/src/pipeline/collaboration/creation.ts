import type {TaskBrief,ActorContext} from '@framebaker/shared';
import {createCollaborationTask,readDraftContent,sourceSelection} from './drafts';
import {getSource} from '../service';
import {draftState} from './timing';
import {PipelineError} from '../service';
import {db} from '../../db';
import {requireCurrentMaker} from '../../localSessions';
import {claimOperation,collaborationHash,readOperation,readOperationInput,writeOperationCheckpoint} from './operations';
import {verifiedTaskBrief} from './brief';
type CreationInput=Partial<TaskBrief>&Pick<TaskBrief,'context'|'source_id'>;
type CreationBinding={version:1;kind:'task_creation_request';supplied_input:CreationInput;supplied_input_hash:string;resolved_brief_hash:string};
const conflict=():never=>{throw new PipelineError('REQUEST_CONFLICT','REQUEST_CONFLICT: 幂等标识已用于不同操作内容',409);};
/** 确定性默认与集中缺项；外部 Codex 决定数值，不引入模型调用。 */
export function createTaskFromInput(input:CreationInput,request_key:string,actor:ActorContext){
 requireCurrentMaker(actor);
 if(!input||typeof input!=='object'||!input.context||typeof input.context.project_id!=='string'||typeof input.context.axis_id!=='string'||typeof input.source_id!=='string')throw new PipelineError('INVALID_INPUT','brief需要动作上下文及source_id');
 if(typeof request_key!=='string'||!request_key.length||request_key.length>256)throw new PipelineError('INVALID_REQUEST','操作幂等标识无效');
 if(request_key.startsWith('server:'))throw new PipelineError('RESERVED_REQUEST_KEY','服务端操作标识不能由客户端使用');
 const inputHash=collaborationHash(input);
 return db.transaction(()=>{
 const previous=db.query('SELECT id FROM collab_operations WHERE request_key=?').get(request_key) as {id:string}|null;
 if(previous){
  const op=readOperation(previous.id);if(op.kind!=='create_task')conflict();
  if(op.checkpoint!==null){
   const binding=op.checkpoint as unknown as CreationBinding,original=readOperationInput(op.id,'create_task') as TaskBrief;
   if(binding.version!==1||binding.kind!=='task_creation_request'||!binding.supplied_input||collaborationHash(binding.supplied_input)!==binding.supplied_input_hash||binding.resolved_brief_hash!==op.payload_hash||op.state!=='succeeded'||!op.result||typeof op.result!=='object'||Array.isArray(op.result)||typeof op.result.task_id!=='string')throw new PipelineError('RECOVERY_IDENTITY_CONFLICT','任务创建的原始输入绑定无效',409);
   if(inputHash!==binding.supplied_input_hash)conflict();
   // 原 resolved brief 仍经核心验证实际来源字节；不读取或重新应用当前草稿默认值。
   return createCollaborationTask(original,{request_key},actor);
  }
  // 旧核心记录没有 supplied-input 证据；保持其原负载匹配，不补写推测的历史输入。
 }
 const draft=readDraftContent(input.context),source=getSource(input.context.project_id,input.source_id),missing:Array<{field:string;reason:string;recommendation:string;origin:'inferred'}>=[];
 const need=(field:string,reason:string,recommendation:string)=>missing.push({field,reason,recommendation,origin:'inferred'});
 if(!input.goal)need('goal','需要用户原话目标','保留原话，origin=user');
 const alignment=input.alignment??(draft.alignment?{value:draft.alignment,origin:'preset' as const}:undefined);
 if(!alignment)need('alignment','未配置必要画布与根位置','先用 save_alignment 保存用户或预设配置');
 const timing=input.timing??draftState(input.context)?.timing??(source.probe.kind!=='png_sequence'?{value:{mode:'source_pts' as const},origin:'inferred' as const}:undefined);
 if(!timing)need('timing','PNG 没有视频 PTS','一次确认 FPS 或完整有理数时长');
 if(missing.length)return {status:'needs_input',requires_user_action:true,missing,resume:{request_key,brief:input}};
 const brief:TaskBrief={...input,context:input.context,source_id:input.source_id,goal:input.goal,ordered_source_frame_ids:input.ordered_source_frame_ids??sourceSelection(input.context,input.source_id).map((f:any)=>f.source_frame_id),alignment:alignment!,timing:timing!,subject_region:input.subject_region??{value:null,origin:'inferred'},loop:input.loop??{value:false,origin:'inferred'},sampling_limit:input.sampling_limit??12,output:input.output??{value:{max_texture:1024,gap:0,margin:0,formats:['png_sequence','spritesheet','contact_sheet','zip']},origin:'inferred'}};
 if(!previous){
  const resolved=verifiedTaskBrief(brief),operation=claimOperation('create_task',{request_key},resolved);
  const binding:CreationBinding={version:1,kind:'task_creation_request',supplied_input:structuredClone(input),supplied_input_hash:inputHash,resolved_brief_hash:operation.payload_hash};
  // 绑定与核心 Task/brief/操作提交在同一事务内；needs_input 和失败不占用请求键。
  writeOperationCheckpoint(operation.id,binding);
  return createCollaborationTask(resolved,{request_key},actor);
 }
 return createCollaborationTask(brief,{request_key},actor);
 }).immediate();
}
