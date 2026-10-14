import type {ActionCollaborationState,CollaborationTask,TaskBrief,CandidateRecord,CandidateManifest,CandidateCheckReport,CandidateSelfCheck,ReviewState,ReviewResult,ReviewContext,FrameReviewPatch,PlaybackReviewPatch,IssuePatch,IssueRepairPatch,SourceDefectPatch,CandidateSelectionRequest,ReviewIssuePage,ReviewIssueState,Page,CandidateFrame,ImpactReport,ContentToken,WorkContext,DraftContent,OperationRecord,DeliveryResult} from '@framebaker/shared';
export interface TaskInspection{task:CollaborationTask;brief:TaskBrief;candidate_ids:string[]}
export interface CandidateInspection{record:CandidateRecord;manifest:CandidateManifest;technical_check:CandidateCheckReport|null;self_check:CandidateSelfCheck|null}
export class CandidateApiError extends Error{constructor(readonly code:string,message:string,readonly status:number){super(message);}}
/** 仅缓存操作的不可变种类；交付状态始终从服务读取，新 ID 必须分类。实例属于一个工作台。 */
export class CandidateOperationReader{
 private kinds=new Map<string,string>();
 constructor(private inspect:(id:string,signal?:AbortSignal)=>Promise<OperationRecord>){}
 async read(ids:string[],signal?:AbortSignal){
  const records=await Promise.all(ids.filter(id=>!this.kinds.has(id)||this.kinds.get(id)==='deliver_candidate').map(async id=>{const record=await this.inspect(id,signal);this.kinds.set(id,record.kind);return record;}));
  return records.filter(record=>record.kind==='deliver_candidate');
 }
}
const base='/api/v1/collaboration',id=encodeURIComponent;
async function call<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
 const result=await response.json() as {ok:boolean;data:T;error?:{code:string;message:string}};
 if(!response.ok||!result.ok)throw new CandidateApiError(result.error?.code??'REQUEST_FAILED',result.error?.message??String(response.status),response.status);
 return result.data;
}
const review=<P,>(path:string,context:ReviewContext,patch:P)=>call<ReviewResult>(path,{context,patch});
/** Cookie 由桌面宿主安装；JS 不读取凭据、不声明审核角色。 */
export const candidateReviewApi={
 action:(context:WorkContext,signal?:AbortSignal)=>call<ActionCollaborationState>(`/action?project_id=${id(context.project_id)}&axis_id=${id(context.axis_id)}`,undefined,signal),
 timing:(context:WorkContext,timing:TaskBrief['timing'],base_content:ContentToken,request_key:string)=>call<ContentToken>('/timing',{context,timing,base_content,request_key}),
 task:(taskId:string,signal?:AbortSignal)=>call<TaskInspection>(`/tasks/${id(taskId)}`,undefined,signal),
 candidate:(candidateId:string,signal?:AbortSignal)=>call<CandidateInspection>(`/candidates/${id(candidateId)}`,undefined,signal),
 state:(candidateId:string,signal?:AbortSignal)=>call<ReviewState>(`/candidates/${id(candidateId)}/review-state`,undefined,signal),
 file:(candidateId:string,path:string)=>`${base}/candidates/${id(candidateId)}/file?path=${id(path)}`,
 frames:async(candidateId:string,signal?:AbortSignal)=>{
  const items:CandidateFrame[]=[];let cursor:string|null=null,hash:string|null=null;const seen=new Set<string>();
  do{const page:Page<CandidateFrame>=await call(`/candidates/${id(candidateId)}/frames?limit=300${cursor?'&cursor='+id(cursor):''}`,undefined,signal);
   if(hash&&hash!==page.content_token.hash)throw new CandidateApiError('PAGE_CONFLICT','PAGE_CONFLICT',409);hash=page.content_token.hash;items.push(...page.items);
   if(page.complete){if(items.length!==page.total)throw Error('INCOMPLETE_FRAME_PAGE');return items;}
   cursor=page.next_cursor;if(!cursor||seen.has(cursor))throw Error('INCOMPLETE_FRAME_PAGE');seen.add(cursor);
  }while(true);
 },
 issues:async(candidateId:string,signal?:AbortSignal)=>{
  const items:ReviewIssueState[]=[];let cursor:string|null=null,revision:number|null=null;const seen=new Set<string>();
  do{const page:ReviewIssuePage=await call(`/candidates/${id(candidateId)}/issues?limit=300${cursor?'&cursor='+id(cursor):''}`,undefined,signal);
   if(revision!==null&&revision!==page.review_revision)throw new CandidateApiError('PAGE_CONFLICT','PAGE_CONFLICT',409);revision=page.review_revision;items.push(...page.items);
   if(page.complete){if(items.length!==page.total)throw Error('INCOMPLETE_ISSUE_PAGE');return {items,review_revision:revision};}
   cursor=page.next_cursor;if(!cursor||seen.has(cursor))throw Error('INCOMPLETE_ISSUE_PAGE');seen.add(cursor);
  }while(true);
 },
 frame:(context:ReviewContext,patch:FrameReviewPatch)=>review(`/candidates/${id(context.candidate_id)}/reviews/frame`,context,patch),
 playback:(context:ReviewContext,patch:PlaybackReviewPatch)=>review(`/candidates/${id(context.candidate_id)}/reviews/playback`,context,patch),
 whole:(context:ReviewContext,patch:import('@framebaker/shared').WholeCandidateReviewPatch)=>review(`/candidates/${id(context.candidate_id)}/reviews/whole`,context,patch),
 issue:(context:ReviewContext,patch:IssuePatch)=>review(`/candidates/${id(context.candidate_id)}/issues`,context,patch),
 repair:(context:ReviewContext,patch:IssueRepairPatch)=>review(`/issues/${id(patch.issue_id)}/repair`,context,patch),
 exception:(context:ReviewContext,patch:SourceDefectPatch)=>review(`/issues/${id(patch.issue_id)}/accept-source-defect`,context,patch),
 inherit:(context:ReviewContext,parent_candidate_id:string)=>call<ReviewResult>(`/candidates/${id(context.candidate_id)}/reviews/inherit`,{context,parent_candidate_id}),
 select:(request:CandidateSelectionRequest)=>call<ReviewResult>(`/tasks/${id(request.task_id)}/selection`,request),
 compare:(parent_candidate_id:string,candidate_id:string,signal?:AbortSignal)=>call<ImpactReport>('/maker/compare_candidates',{parent_candidate_id,candidate_id},signal),
 draft:(context:WorkContext,signal?:AbortSignal)=>call<DraftContent>(`/draft?project_id=${id(context.project_id)}&axis_id=${id(context.axis_id)}`,undefined,signal),
 rework:(taskId:string,parent_candidate_id:string,base_content:ContentToken,request_key:string)=>call<{task:CollaborationTask;content_token:ContentToken}>(`/tasks/${id(taskId)}/rework`,{parent_candidate_id,base_content,request_key}),
 operation:(operationId:string,signal?:AbortSignal)=>call<OperationRecord>(`/operations/${id(operationId)}`,undefined,signal),
 delivery:(operationId:string,signal?:AbortSignal)=>call<DeliveryResult>(`/deliveries/${id(operationId)}`,undefined,signal),
 deliveryFile:(operationId:string,path:string)=>`${base}/deliveries/${id(operationId)}/file?path=${id(path)}`,
};
