import { Elysia, t } from 'elysia';
import type {WholeCandidateReviewPatch} from '@framebaker/shared';
import {applyWholeCandidateReview} from './collaboration/reviews';
import type { TaskBrief, SampleObservation, ReviewContext, FrameReviewPatch, PlaybackReviewPatch, IssuePatch, IssueRepairPatch, SourceDefectPatch, CandidateSelectionRequest } from '@framebaker/shared';
import { getRequestActor, requireRole, LocalAuthError } from '../localSessions';
import { createSceneMattingJob } from '../queue';
import { createCollaborationTask, readDraftContent, setOutputTiming, startRework } from './collaboration/drafts';
import { readTaskRecord } from './collaboration/store';
import { importImageSequence } from './images';
import { pipelineEnvelope, pipelineErrorResponse } from './api';
import {getCandidateSamplingPlan,recordSampleObservations,readCandidateSelfCheck} from './collaboration/samplingStore';

import {readReviewState,applyFrameReview,applyPlaybackReview,applyIssue,recordIssueRepair,acceptSourceDefect,applyFrameInheritance,selectCandidate} from './collaboration/reviews';
import {runMakerTool,imageImportOptionsSchema} from '../mcp/makerTools';
import {inspectTask,listCandidateFrames,listReviewIssues,immutableCandidateFile} from './collaboration/pages';
import {readDelivery,deliveryFilePath,resolveActionExport} from './collaboration/delivery';
import {PipelineError} from './service';
const maker=async(name:string,input:unknown,request:Request)=>{try{const data:any=await runMakerTool(name,input,getRequestActor(request));return pipelineEnvelope(data,{status:data?.status??data?.state??'succeeded',jobId:data?.job_id});}catch(e){return error(e);}};
const scoped=(id:string,body:any,kind:'candidate_id'|'issue_id'|'task_id')=>{const actual=kind==='issue_id'?body.patch?.issue_id:body.context?.[kind]??body[kind];if(actual!==id)throw new PipelineError('REVIEW_CONTEXT_MISMATCH','路径与审核上下文不一致',409);};

const review=t.Object({task_id:t.String(),candidate_id:t.String(),base_review_revision:t.Integer({minimum:0}),request_key:t.String()},{additionalProperties:false});
const reviewBody=t.Object({context:review,patch:t.Unknown()},{additionalProperties:false});
const context=t.Object({project_id:t.String(),axis_id:t.String()});
const base=t.Object({revision:t.Integer({minimum:0}),hash:t.String({pattern:'^[a-f0-9]{64}$'})});
const error=(e:unknown)=>e instanceof LocalAuthError?Response.json({ok:false,error:{code:e.code,message:e.message}},{status:e.status}):pipelineErrorResponse(e);
/** HTTP只负责传输与服务绑定身份；要求、时序和幂等规则在共用服务层。 */
export const collaborationApi=new Elysia({prefix:'/api/v1/collaboration'})
 .onError(({error:e})=>error(new PipelineError('INVALID_INPUT',e instanceof Error?e.message:String(e))))
 .post('/maker/:name',({params,body,request})=>maker(params.name,body,request),{body:t.Unknown()})
 .get('/action',({query,request})=>maker('inspect_action_collaboration',query,request),{query:context})
 .get('/tasks/:id',({params,request})=>maker('inspect_task',{task_id:params.id},request))
 .post('/tasks/:id/candidates',({params,body,request})=>maker('create_candidate',{...(body as object),task_id:params.id},request),{body:t.Unknown()})
 .get('/candidates/:id',({params,request})=>maker('inspect_candidate',{candidate_id:params.id},request))
 .get('/frames',({query,request})=>maker('list_frames',{...query,...(query.limit?{limit:Number(query.limit)}:{})},request),{query:t.Object({project_id:t.String(),axis_id:t.String(),cursor:t.Optional(t.String()),limit:t.Optional(t.String())})})
 .get('/candidates/:id/frames',({params,query,request})=>maker('inspect_candidate',{candidate_id:params.id,...query,limit:query.limit?Number(query.limit):32},request),{query:t.Object({cursor:t.Optional(t.String()),limit:t.Optional(t.String())})})
 .get('/candidates/:id/samples',({params,query,request})=>maker('get_candidate_samples',{candidate_id:params.id,...(query.limit?{limit:Number(query.limit)}:{})},request),{query:t.Object({limit:t.Optional(t.String())})})
 .post('/candidates/:id/submit',({params,body,request})=>maker('submit_candidate',{...(body as object),candidate_id:params.id},request),{body:t.Unknown()})
 .get('/candidates/:id/issues',({params,query,request})=>maker('list_review_issues',{candidate_id:params.id,...query,...(query.limit?{limit:Number(query.limit)}:{})},request),{query:t.Object({cursor:t.Optional(t.String()),limit:t.Optional(t.String())})})
 .get('/candidates/:id/review-state',({params,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(readReviewState(params.id));}catch(e){return error(e);}})
 .get('/candidates/:id/file',({params,query,request})=>{try{requireRole(getRequestActor(request),'maker');return new Response(Bun.file(immutableCandidateFile(params.id,query.path)),{headers:{'Cache-Control':'no-store'}});}catch(e){return error(e);}},{query:t.Object({path:t.String({maxLength:1024})})})
 .post('/candidates/:id/reviews/frame',({params,body,request})=>{try{scoped(params.id,body,'candidate_id');return pipelineEnvelope(applyFrameReview(body.context,body.patch as FrameReviewPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/candidates/:id/reviews/playback',({params,body,request})=>{try{scoped(params.id,body,'candidate_id');return pipelineEnvelope(applyPlaybackReview(body.context,body.patch as PlaybackReviewPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/candidates/:id/reviews/whole',({params,body,request})=>{try{scoped(params.id,body,'candidate_id');return pipelineEnvelope(applyWholeCandidateReview(body.context,body.patch as WholeCandidateReviewPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/candidates/:id/issues',({params,body,request})=>{try{scoped(params.id,body,'candidate_id');return pipelineEnvelope(applyIssue(body.context,body.patch as IssuePatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/issues/:id/repair',({params,body,request})=>{try{scoped(params.id,body,'issue_id');return pipelineEnvelope(recordIssueRepair(body.context,body.patch as IssueRepairPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/issues/:id/accept-source-defect',({params,body,request})=>{try{scoped(params.id,body,'issue_id');return pipelineEnvelope(acceptSourceDefect(body.context,body.patch as SourceDefectPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/candidates/:id/reviews/inherit',({params,body,request})=>{try{scoped(params.id,body,'candidate_id');return pipelineEnvelope(applyFrameInheritance(body.context,body.parent_candidate_id,getRequestActor(request)));}catch(e){return error(e);}},{body:t.Object({context:review,parent_candidate_id:t.String()},{additionalProperties:false})})
 .post('/tasks/:id/selection',({params,body,request})=>{try{scoped(params.id,body,'task_id');return pipelineEnvelope(selectCandidate(body as CandidateSelectionRequest,getRequestActor(request)));}catch(e){return error(e);}},{body:t.Unknown()})
 .get('/operations/:id',({params,request})=>maker('inspect_operation',{operation_id:params.id},request))
 .post('/operations/:id/resume',({params,request})=>maker('resume_operation',{operation_id:params.id},request))
 .post('/operations/:id/cancel',({params,request})=>maker('cancel_operation',{operation_id:params.id},request))
 .post('/tasks/:id/cancel',({params,body,request})=>maker('cancel_task',{...(body as object),task_id:params.id},request),{body:t.Unknown()})
 .post('/action-export/resolve',async({body,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(await resolveActionExport(body,body.format));}catch(e){return error(e);}},{body:t.Object({project_id:t.String(),axis_id:t.String(),format:t.String(),task_id:t.Optional(t.String())})})
 .get('/deliveries/:id',({params,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(readDelivery(params.id));}catch(e){return error(e);}})
 .get('/deliveries/:id/file',({params,query,request})=>{try{requireRole(getRequestActor(request),'maker');const result=readDelivery(params.id);return new Response(Bun.file(deliveryFilePath(params.id,query.path)),{headers:{'X-Approval-Status':result.approval_status,'Cache-Control':'no-store'}});}catch(e){return error(e);}},{query:t.Object({path:t.String({maxLength:1024})})})
 .get('/candidates/:id/reviews',({params,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(readReviewState(params.id));}catch(e){return error(e);}})
 .post('/reviews/frame',({body,request})=>{try{return pipelineEnvelope(applyFrameReview(body.context,body.patch as FrameReviewPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/reviews/playback',({body,request})=>{try{return pipelineEnvelope(applyPlaybackReview(body.context,body.patch as PlaybackReviewPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/reviews/issue',({body,request})=>{try{return pipelineEnvelope(applyIssue(body.context,body.patch as IssuePatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/reviews/repair',({body,request})=>{try{return pipelineEnvelope(recordIssueRepair(body.context,body.patch as IssueRepairPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/reviews/source-exception',({body,request})=>{try{return pipelineEnvelope(acceptSourceDefect(body.context,body.patch as SourceDefectPatch,getRequestActor(request)));}catch(e){return error(e);}},{body:reviewBody})
 .post('/reviews/inheritance',({body,request})=>{try{return pipelineEnvelope(applyFrameInheritance(body.context,body.parent_candidate_id,getRequestActor(request)));}catch(e){return error(e);}},{body:t.Object({context:review,parent_candidate_id:t.String()},{additionalProperties:false})})
 .post('/reviews/selection',({body,request})=>{try{return pipelineEnvelope(selectCandidate(body as CandidateSelectionRequest,getRequestActor(request)));}catch(e){return error(e);}},{body:t.Unknown()})
 .get('/candidates/:id/sampling',({params,query,request})=>{try{return pipelineEnvelope(getCandidateSamplingPlan(params.id,getRequestActor(request),query.limit===undefined?12:Number(query.limit)));}catch(e){return error(e);}}, {query:t.Object({limit:t.Optional(t.String())})})
 .post('/candidates/:id/observations',({params,body,request})=>{try{recordSampleObservations(params.id,body.plan_hash,body.observations as SampleObservation[],getRequestActor(request));return pipelineEnvelope(readCandidateSelfCheck(params.id));}catch(e){return error(e);}}, {body:t.Object({plan_hash:t.String(),observations:t.Array(t.Unknown(),{maxItems:12})})})
 .get('/candidates/:id/selfcheck',({params,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(readCandidateSelfCheck(params.id));}catch(e){return error(e);}})
 .post('/tasks',({body,request})=>maker('create_task',body,request), {body:t.Object({brief:t.Unknown(),request_key:t.String()})})
 .get('/draft',({query,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(readDraftContent(query));}catch(e){return error(e);}}, {query:context})
 .post('/timing',({body,request})=>{try{requireRole(getRequestActor(request),'maker');return pipelineEnvelope(setOutputTiming(body.context,body.timing as TaskBrief['timing'],body.base_content,{request_key:body.request_key}));}catch(e){return error(e);}}, {body:t.Object({context,timing:t.Unknown(),base_content:base,request_key:t.String()})})
 .post('/images',async({body,request})=>{try{
   requireRole(getRequestActor(request),'maker');
   // Elysia会预解析部分multipart JSON字段；文本与对象走同一严格选项验证。
   let input:unknown=body.options;
   if(typeof input==='string'){try{input=JSON.parse(input);}catch{throw new PipelineError('INVALID_INPUT','PNG序列选项必须为JSON对象');}}
   const parsed=imageImportOptionsSchema.safeParse(input);
   if(!parsed.success)throw new PipelineError('INVALID_INPUT','PNG序列选项无效');
   const options=parsed.data as Parameters<typeof importImageSequence>[2];
   const files=await Promise.all(body.files.map(async f=>({name:f.name,bytes:new Uint8Array(await f.arrayBuffer())})));
   return pipelineEnvelope(await importImageSequence({project_id:body.project_id,axis_id:body.axis_id},files,options));
 }catch(e){return error(e);}}, {body:t.Object({project_id:t.String(),axis_id:t.String(),files:t.Files({minItems:1,maxItems:2000}),options:t.Unknown()})})
 .post('/tasks/:id/rework',({params,body,request})=>{try{return pipelineEnvelope(startRework(params.id,body.parent_candidate_id,body.base_content,{request_key:body.request_key},getRequestActor(request)));}catch(e){return error(e);}}, {body:t.Object({parent_candidate_id:t.String(),base_content:base,request_key:t.String()})})
 .post('/tasks/:id/matte',({params,body,request})=>{try{
   requireRole(getRequestActor(request),'maker');const task=readTaskRecord(params.id);
   const jobId=createSceneMattingJob({project_id:task.context.project_id,frame_ids:body.frame_ids,base_revision:body.base_revision,region:body.region,collaboration:{task_id:task.id,axis_id:task.context.axis_id}});
   return pipelineEnvelope({resume_supported:false,resume_error:'RECOVERY_UNSUPPORTED'}, {status:'accepted',projectId:task.context.project_id,jobId});
 }catch(e){return error(e);}}, {body:t.Object({frame_ids:t.Array(t.String(),{minItems:1,maxItems:2000}),base_revision:t.Optional(t.Integer({minimum:0})),region:t.Optional(t.Tuple([t.Integer({minimum:0}),t.Integer({minimum:0}),t.Integer({minimum:1}),t.Integer({minimum:1})]))})});
