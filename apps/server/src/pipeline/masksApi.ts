import {getRequestActor,requireCurrentReviewer} from '../localSessions';
import { Elysia, t } from 'elysia';
import { existsSync } from 'node:fs';
import { createSceneMattingJob } from '../queue';
import { maskBackend, maskState, editMask, undoMask, reviewMask,maskInspectionInfo } from './masks';
import { pipelineEnvelope, pipelineErrorResponse } from './api';
import { PipelineError } from './service';
import { getProject } from './service';
import { db } from '../db';

const versionBody = { version_id: t.String(), revision:t.Integer({minimum:0}) };
export const masksApi = new Elysia({prefix:'/api/v1'})
 .onError(({error,code})=>pipelineErrorResponse(new PipelineError(code==='VALIDATION'?'INVALID_INPUT':'EXECUTION_ERROR',error instanceof Error?error.message:String(error),code==='VALIDATION'?400:500)))
 .get('/projects/:id/masks',({params})=>{try {getProject(params.id);const job=db.query("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running') AND json_extract(payload,'$.sceneMatting') IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(params.id) as {id:string}|null;return pipelineEnvelope({active_job:job?.id??null,frames:(db.query('SELECT f.id,h.version_id,h.reviewed,v.info,v.kind FROM frames f LEFT JOIN mask_heads h ON h.frame_id=f.id LEFT JOIN mask_versions v ON v.id=h.version_id WHERE f.project_id=?').all(params.id) as any[]).map(({kind,...frame})=>({...frame,info:maskInspectionInfo(kind,frame.info)}))});}catch(e){return pipelineErrorResponse(e);}})
 .get('/matte/backend',()=>pipelineEnvelope(maskBackend()))
 .post('/matte',({body})=>{try {const jobId=createSceneMattingJob(body); return pipelineEnvelope({}, {status:'accepted',projectId:body.project_id,jobId});}catch(e){return pipelineErrorResponse(e);}}, {body:t.Object({project_id:t.String(),frame_ids:t.Array(t.String(),{minItems:1,maxItems:2000}),base_revision:t.Optional(t.Integer({minimum:0})),background_points:t.Optional(t.Record(t.String(),t.Array(t.Tuple([t.Integer({minimum:0}),t.Integer({minimum:0})]),{maxItems:128}))),region:t.Optional(t.Tuple([t.Integer({minimum:0}),t.Integer({minimum:0}),t.Integer({minimum:1}),t.Integer({minimum:1})]))})})
 .get('/masks/:id',({params})=>{try{return pipelineEnvelope(maskState(params.id));}catch(e){return pipelineErrorResponse(e);}})
 .get('/masks/:id/image',({params,query})=>{
  try {const state=maskState(params.id); const version=query.version ? state.versions.find(v=>v.id===query.version) : state.current;
   const path=query.kind==='raw' ? state.raw_path : query.kind==='mask' ? version?.mask_path : query.kind==='preview' ? version?.preview_path : version?.rgba_path;
   if(!path || !existsSync(path)) throw new PipelineError('MASK_NOT_FOUND','图像不存在',404);
   return new Response(Bun.file(path),{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});
  } catch(e) {return pipelineErrorResponse(e);}
 },{query:t.Object({kind:t.Union([t.Literal('raw'),t.Literal('mask'),t.Literal('rgba'),t.Literal('preview')]),version:t.Optional(t.String())})})
 .post('/masks/:id/strokes',async({params,body})=>{try {return pipelineEnvelope(await editMask(params.id,body.version_id,body.strokes,body.revision));}catch(e){return pipelineErrorResponse(e);}}, {body:t.Object({...versionBody,strokes:t.Array(t.Object({mode:t.Union([t.Literal('erase'),t.Literal('restore')]),size:t.Number({minimum:1,maximum:512}),points:t.Array(t.Tuple([t.Number(),t.Number()]),{minItems:1,maxItems:20000})}),{minItems:1,maxItems:1000})})})
 .post('/masks/:id/undo',({params,body})=>{try{return pipelineEnvelope(undoMask(params.id,body.version_id,body.revision));}catch(e){return pipelineErrorResponse(e);}}, {body:t.Object(versionBody)})
 .post('/masks/:id/review',({params,body,request})=>{try{if(process.env.SFS_SERVICE_TOKEN)requireCurrentReviewer(getRequestActor(request));return pipelineEnvelope(reviewMask(params.id,body.version_id,body.revision));}catch(e){return pipelineErrorResponse(e);}}, {body:t.Object(versionBody)});
