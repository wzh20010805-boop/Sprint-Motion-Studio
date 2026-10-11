import { Elysia,t } from 'elysia';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AlignmentConfig } from '@framebaker/shared';
import { getFrame } from '../db';
import { createExportJob,resumeJob } from '../queue';
import { PipelineError,validateId } from './service';
import { alignmentState,saveAlignment,checkAlignment,approveAlignment,previewFrame } from './alignment';
import { exportRecord } from './export';
import { pipelineEnvelope,pipelineErrorResponse } from './api';
import { submitRecipe } from './recipe';
import { importImages } from './images';

const context={project_id:t.String(),axis_id:t.String()};
const guarded=async(fn:()=>unknown)=>{try{return pipelineEnvelope(await fn());}catch(e){return pipelineErrorResponse(e);}};
export const productionApi=new Elysia({prefix:'/api/v1'})
 .post('/images/import',async({body})=>guarded(async()=>importImages(body.projectId,await Promise.all(body.files.map(async f=>({name:f.name,bytes:new Uint8Array(await f.arrayBuffer())}))),body.name)),{body:t.Object({projectId:t.String(),files:t.Files({minItems:1,maxItems:2000}),name:t.Optional(t.String())})})
 .post('/pipeline',({body})=>{try{const result=submitRecipe(body.project_id,body.axis_id,body.recipe,body.clip_id);return pipelineEnvelope(result,{status:'accepted',jobId:result.job_id,projectId:body.project_id});}catch(e){return pipelineErrorResponse(e);}},{body:t.Object({...context,clip_id:t.Optional(t.String()),recipe:t.Any()})})
 .onError(({error})=>pipelineErrorResponse(new PipelineError('INVALID_INPUT',error instanceof Error?error.message:String(error))))
 .get('/alignment',({query})=>guarded(()=>alignmentState(query.project_id,query.axis_id)),{query:t.Object(context)})
 .post('/alignment',({body})=>guarded(()=>saveAlignment(body.project_id,body.axis_id,body.config as AlignmentConfig,body.base_revision)),{body:t.Object({...context,config:t.Any(),base_revision:t.Integer({minimum:0})})})
 .post('/alignment/check',({body})=>guarded(()=>checkAlignment(body.project_id,body.axis_id)),{body:t.Object(context)})
 .post('/review/apply',({body})=>guarded(()=>approveAlignment(body.project_id,body.axis_id,body.base_revision,body.confirmation,body.source)),{body:t.Object({...context,base_revision:t.Integer({minimum:0}),confirmation:t.String({minLength:1}),source:t.String({minLength:1})})})
 .get('/preview/:id',async({params,query})=>{try{const frame=getFrame(params.id);if(!frame)throw new PipelineError('FRAME_NOT_FOUND','帧不存在',404);const path=await previewFrame(frame.project_id,query.axis_id,params.id);return new Response(Bun.file(path),{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});}catch(e){return pipelineErrorResponse(e);}},{query:t.Object({axis_id:t.String()})})
 .post('/export',({body})=>{try{return pipelineEnvelope({}, {status:'accepted',projectId:body.project_id,jobId:createExportJob(body)});}catch(e){return pipelineErrorResponse(e);}},{body:t.Object({...context,draft:t.Optional(t.Boolean()),base_revision:t.Optional(t.Integer({minimum:0})),max_texture:t.Optional(t.Integer()),gap:t.Optional(t.Integer()),margin:t.Optional(t.Integer()),timing:t.Optional(t.Union([t.Literal('source_pts'),t.Literal('constant')]))})})
 .post('/jobs/:id/resume',({params})=>{try{validateId(params.id);return pipelineEnvelope({}, {status:'accepted',jobId:resumeJob(params.id)});}catch(e){return pipelineErrorResponse(e);}})
 .get('/exports/:id/file',({params,query})=>{try{validateId(params.id);if(!/^(assets\.zip|manifest\.json|quality-report\.json|checksums\.json|README_COCOS_3\.8\.8\.md|frames\/frame_\d{6}\.png|sheets\/page_\d{3}\.png|previews\/(contact-sheet\.png|preview-on-background\.mp4))$/.test(query.path))throw new PipelineError('INVALID_PATH','导出文件路径无效');const record=exportRecord(params.id),path=join(record.directory,query.path);if(!existsSync(path))throw new PipelineError('EXPORT_NOT_FOUND','导出文件已丢失',404);return new Response(Bun.file(path));}catch(e){return pipelineErrorResponse(e);}},{query:t.Object({path:t.String()})});
