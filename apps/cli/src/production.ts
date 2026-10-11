import { readFileSync,existsSync,mkdirSync,copyFileSync,constants } from 'node:fs';
import { resolve,join } from 'node:path';
import { alignmentSchema,recipeSchema,manifestSchema } from '../../../packages/shared/src/pipeline/schemas';
import { CliError,requestService,waitJob } from './client';
import type { ServiceInfo } from '../../server/src/runtime';

export const productionCommands=['project list','inspect','align','review apply','preview','export','pipeline run','job resume'];
export const schemas:Record<string,unknown>={alignment:alignmentSchema,recipe:recipeSchema,manifest:manifestSchema};
export async function runProduction(command:string,flags:Record<string,unknown>,service:ServiceInfo,revision?:number,timeout=60) {
 const required=(key:string)=>{const v=flags[key];if(typeof v!=='string'||!v.trim())throw new CliError('INVALID_ARGUMENT',`缺少--${key}`);return v;};
 const post=(body:unknown):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const file=(key:string)=>{try{return JSON.parse(readFileSync(resolve(required(key)),'utf8'));}catch(e){throw new CliError('INVALID_INPUT',`无法读取${key} JSON: ${(e as Error).message}`);}};
 if(command==='project list')return requestService(service,'/api/v1/projects');
 if(command==='job resume'){const result=await requestService(service,`/api/v1/jobs/${encodeURIComponent(required('job'))}/resume`,post({}));return flags.wait?(await waitJob(service,result.job_id,timeout)):result;}
 const project=required('project');let axis=flags.axis;
 if(!axis){const inspect=await requestService(service,`/api/v1/projects/${encodeURIComponent(project)}`);const clip=inspect.data.clips.find((c:any)=>c.id===flags.clip);if(clip)axis=clip.axis_id;else if(inspect.data.axes?.length===1)axis=inspect.data.axes[0].id;}
 if(typeof axis!=='string')throw new CliError('INVALID_ARGUMENT','需要--axis或有效--clip');
 const context={project_id:project,axis_id:axis};
 if(flags.format&&!['png-sequence','grid-sheet','manifest'].includes(String(flags.format)))throw new CliError('INVALID_ARGUMENT','格式应为png-sequence、grid-sheet或manifest；共享导出包始终附完整清单');
 if(command==='inspect')return requestService(service,`/api/v1/alignment?project_id=${project}&axis_id=${axis}`);
 if(command==='align'){
  const result=await requestService(service,`/api/v1/projects/${project}`);
  return requestService(service,'/api/v1/alignment',post({...context,config:file('config'),base_revision:revision??result.data.project.revision}));
 }
 if(command==='review apply'){if(revision===undefined)throw new CliError('INVALID_ARGUMENT','审核必须提供--base-revision');return requestService(service,'/api/v1/review/apply',post({...file('patch'),...context,base_revision:revision}));}
 if(command==='preview'){
  const check=await requestService(service,'/api/v1/alignment/check',post(context));
  if(flags.frame){const headers={Authorization:`Bearer ${service.token}`};const response=await fetch(service.url+`/api/v1/preview/${encodeURIComponent(required('frame'))}?axis_id=${axis}`,{headers});if(!response.ok)throw new CliError('EXECUTION_ERROR',await response.text());const output=resolve(required('output'));if(await Bun.file(output).exists())throw new CliError('INVALID_INPUT','不覆盖已有预览文件');await Bun.write(output,new Uint8Array(await response.arrayBuffer()));check.artifacts=[{kind:'canvas_preview',path:output}];}
  return check;
 }
 let result:any;
 if(command==='pipeline run')result=await requestService(service,'/api/v1/pipeline',post({...context,clip_id:flags.clip,recipe:file('recipe')}));
 else result=await requestService(service,'/api/v1/export',post({...context,draft:!!flags.draft,base_revision:revision,timing:flags.timing??'source_pts',max_texture:flags['max-texture']?Number(flags['max-texture']):undefined}));
 if(flags.wait||flags.output){
  let waited=await waitJob(service,result.job_id,timeout);
  while(command==='pipeline run'&&waited.exitCode===0&&result.data.stage!=='export'){
   result=await requestService(service,'/api/v1/pipeline',post({...context,clip_id:flags.clip,recipe:file('recipe')}));
   waited=await waitJob(service,result.job_id,timeout);
  }
  if(waited.exitCode===0&&flags.output){const destination=resolve(required('output'));if(existsSync(destination))throw new CliError('INVALID_INPUT','输出目录已存在，禁止覆盖');const exported=waited.body.data.job.result;if(!exported?.checksums||!exported?.directory)throw new CliError('INVALID_INPUT','此任务没有可复制的导出包');mkdirSync(destination,{recursive:true});for(const file of [...Object.keys(exported.checksums),'checksums.json']){if(!/^[a-zA-Z0-9_./-]+$/.test(file)||file.includes('..')||file.startsWith('/'))throw new CliError('INVALID_INPUT','服务返回非法导出路径');const target=join(destination,file);mkdirSync(resolve(target,'..'),{recursive:true});copyFileSync(join(exported.directory,file),target,constants.COPYFILE_EXCL);}waited.body.artifacts.push({kind:'output_copy',path:destination});}
  return waited;
 }
 return result;
}

/** stdout 保持摘要；完整序列与异常细节留在已有本地报告。 */
export function compactResult(value:any):any {
 if(Array.isArray(value)){if(value.length>32)return {count:value.length,sample:value.slice(0,8).map(compactResult),truncated:true};return value.map(compactResult);}
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compactResult(v)]));
 return value;
}
