import { recipeSchema } from '@framebaker/shared';
import { Ajv } from 'ajv';
import { db } from '../db';
import { axisFrames,saveAlignment } from './alignment';
import { createExportJob,createSceneMattingJob,createSourceExtractionJob } from '../queue';
import { getClip,getProject,PipelineError } from './service';

const validate=new Ajv({strict:false}).compile(recipeSchema);
/** 每次只提交下一个未完成阶段；遇人工闸门不伪造确认，可用相同recipe继续。 */
export function submitRecipe(project:string,axis:string,recipe:unknown,clip?:string) {
 if(!validate(recipe))throw new PipelineError('INVALID_SCHEMA',JSON.stringify(validate.errors));
 const r=recipe as any;
 if(r.extract){if(!clip)throw new PipelineError('INVALID_INPUT','包含extract的recipe需要clip_id');const c=getClip(project,clip);if(c.axis_id!==axis)throw new PipelineError('CLIP_PROJECT_MISMATCH','clip与axis不一致',409);if(c.status!=='extracted')return {job_id:createSourceExtractionJob(project,clip),stage:'extract',continue_required:true};}
 const {frames}=axisFrames(project,axis);
 const pendingMasks=r.matting?frames.filter(f=>{const head=db.query('SELECT h.reviewed,v.kind FROM mask_heads h JOIN mask_versions v ON v.id=h.version_id WHERE h.frame_id=?').get(f.id) as any;return !head||(head.kind==='imported'&&!head.reviewed);}):[];
 if(pendingMasks.length)return {job_id:createSceneMattingJob({project_id:project,frame_ids:pendingMasks.map(f=>f.id),region:r.matting.region}),stage:'matting',continue_required:true};
 if(r.alignment){const state=(db.query('SELECT value FROM settings WHERE key=?').get(`sfs.alignment.${project}.${axis}`) as any);if(!state||JSON.stringify(JSON.parse(state.value).config)!==JSON.stringify(r.alignment))saveAlignment(project,axis,r.alignment,getProject(project).revision);}
 return {job_id:createExportJob({...r.output,project_id:project,axis_id:axis}),stage:'export',continue_required:false};
}
