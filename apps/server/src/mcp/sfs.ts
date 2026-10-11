import { createMcpHandler,McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { db } from '../db';
import { inspectProject,importVideo,PipelineError } from '../pipeline/service';
import { maskBackend } from '../pipeline/masks';
import { alignmentState,approveAlignment } from '../pipeline/alignment';
import { createExportJob,cancelJob,getPersistedJob } from '../queue';
import { submitRecipe } from '../pipeline/recipe';

const context={project_id:z.string(),axis_id:z.string()};
export const sfsMcpHandler=createMcpHandler(()=>{
 const server=new McpServer({name:'soldier-frame-studio',version:'1.0.0'});
 const register=(name:string,description:string,schema:any,fn:(input:any)=>unknown)=>server.registerTool(name,{description,inputSchema:z.object(schema),annotations:{destructiveHint:false}},async(input:any)=>{
  try{const value=await fn(input);return {content:[{type:'text',text:JSON.stringify(value)}]};}
  catch(e){const error=e as PipelineError;return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{code:error.code??'EXECUTION_ERROR',message:error.message}})}]};}
 });
 register('inspect_capabilities','读取本地能力，不触发模型下载',{},()=>({schema_version:'1.0',mask_backend:maskBackend(),export_formats:['png-sequence','grid-sheet','manifest'],pipeline_requires_review:true,import_transport:'authenticated HTTP multipart /api/v1/sources/import'}));
 register('inspect_project','读取项目与动作摘要',{project_id:z.string()},p=>{const v=inspectProject(p.project_id);return {...v,editor_frames:{count:v.editor_frames.length,sample:v.editor_frames.slice(0,8)}};});
 register('import_source','导入本地提供的视频字节；大视频使用CLI multipart，不接受服务器任意文件路径',{project_id:z.string(),filename:z.string().min(1).max(200),bytes_base64:z.string().min(1).max(24000000)},async p=>{if(!/^[A-Za-z0-9+/]+={0,2}$/.test(p.bytes_base64))throw new PipelineError('INVALID_INPUT','base64无效');const source=await importVideo(p.project_id,{name:p.filename,bytes:Buffer.from(p.bytes_base64,'base64')});return {source_id:source.id,probe:{width:source.probe.width,height:source.probe.height,frame_count:source.probe.frames.length}};});
 register('submit_pipeline','提交下一阶段，保留人工审核闸门',{...context,clip_id:z.string().optional(),recipe:z.unknown()},p=>submitRecipe(p.project_id,p.axis_id,p.recipe,p.clip_id));
 register('get_job','查询持久任务摘要',{job_id:z.string()},p=>{const j=getPersistedJob(p.job_id);if(!j)throw new PipelineError('JOB_NOT_FOUND','任务不存在',404);const r=j.result as any;return {...j,payload:undefined,result:r?{...r,artifacts:r.artifacts?.slice(0,8),abnormal_frames:r.abnormal_frames?.slice(0,32)}:null};});
 register('cancel_job','取消本工具拥有的任务',{job_id:z.string()},p=>({ok:cancelJob(p.job_id)}));
 register('get_review_artifacts','读取遮罩异常和本地预览路径',{...context},p=>({alignment:alignmentState(p.project_id,p.axis_id),masks:db.query(`SELECT f.id,v.preview_path,v.info,h.reviewed FROM frames f JOIN animation_tracks t ON t.id=f.track_id LEFT JOIN mask_heads h ON h.frame_id=f.id LEFT JOIN mask_versions v ON v.id=h.version_id WHERE f.project_id=? AND t.axis_id=? ORDER BY f.idx LIMIT 32`).all(p.project_id,p.axis_id)}));
 register('apply_review_patch','记录用户明确审核内容；要求当前基础修订，不能用于自动批准',{...context,base_revision:z.number().int().nonnegative(),confirmation:z.string().min(1),source:z.string().min(1)},p=>approveAlignment(p.project_id,p.axis_id,p.base_revision,p.confirmation,p.source));
 register('export_assets','提交相同的服务端导出任务',{...context,draft:z.boolean().optional(),base_revision:z.number().int().nonnegative().optional()},p=>({job_id:createExportJob(p),status:'accepted'}));
 return server;
});
