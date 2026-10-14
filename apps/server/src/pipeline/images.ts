import { createHash } from 'node:crypto';
import { copyFileSync,mkdirSync,writeFileSync } from 'node:fs';
import type { ContentToken, PngSourceProbe, TaskBrief, WorkContext } from '@framebaker/shared';
import { assertDraftBase, draftAxis, finishDraftOperation, outputDurations, readDraftContent } from './collaboration/drafts';
import { claimOperation } from './collaboration/operations';
import { saveDraftState } from './collaboration/timing';
import { join,basename } from 'node:path';
import { db,uid,STORAGE_ROOT } from '../db';
import { getProject,PipelineError } from './service';
import { ensureDefaultTimeline } from '../timeline';
import { runImageWorker } from './masks';
import { fileHash } from './alignment';
import { broadcast } from '../ws';
import { invalidateProjectUndo } from '../undo';

/** PNG输入保存完整原件；有Alpha的输入建立独立可编辑遮罩，始终需要人工确认。 */
export async function importImages(project:string,files:Array<{name:string;bytes:Uint8Array}>,name='PNG序列') {
 const revision=getProject(project).revision;
 if(!files.length||files.length>2000)throw new PipelineError('INVALID_INPUT','需要1到2000张PNG');
 files=[...files].sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true})||a.name.localeCompare(b.name,'en'));
 const source=uid(),dir=join(STORAGE_ROOT,'sources',source,'images');mkdirSync(dir,{recursive:true});
 const entries=files.map((f,index)=>{const id=uid(),version=uid(),raw=join(dir,`source_${index.toString().padStart(6,'0')}.png`);writeFileSync(raw,f.bytes,{flag:'wx'});return {id,version,raw,mask:join(dir,version+'-mask.png'),rgba:join(dir,version+'-foreground.png'),preview:join(dir,version+'-preview.png'),original_name:basename(f.name)};});
 const result=await runImageWorker({action:'import',frames:entries},join(dir,'validation'));
 if(getProject(project).revision!==revision)throw new PipelineError('STALE_JOB_RESULT','导入期间项目已修改，原件保留但未提交',409);
 const {axis,track}=ensureDefaultTimeline(project);
 const start=(db.query('SELECT COALESCE(MAX(idx),-1)+1 AS idx FROM animation_steps WHERE axis_id=?').get(axis.id) as any).idx;
 db.transaction(()=>{for(let i=0;i<entries.length;i++){const e=entries[i],step=uid(),info=result.frames[i];
  db.query('INSERT INTO animation_steps(id,axis_id,idx,duration) VALUES(?,?,?,1)').run(step,axis.id,start+i);
  db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,processed_path,status,metadata) VALUES(?,?,?,?,?,?,?,'ready',?)").run(e.id,project,track.id,step,start+i,e.raw,e.rgba,JSON.stringify({source_id:source,source_index:i,original_name:e.original_name}));
  db.query('INSERT INTO mask_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(e.version,e.id,null,'imported',e.mask,e.rgba,e.preview,e.raw,fileHash(e.raw),JSON.stringify(info),Date.now());
  db.query('INSERT INTO mask_heads VALUES(?,?,0)').run(e.id,e.version);
 }})();
 writeFileSync(join(dir,'import.json'),JSON.stringify({source_id:source,name,frames:entries.map(e=>({id:e.id,original_name:e.original_name,sha256:fileHash(e.raw)}))},null,2));
 broadcast('frames_changed',{projectId:project});broadcast('timeline_changed',{projectId:project});return {source_id:source,axis_id:axis.id,frame_count:entries.length,frame_ids:entries.map(e=>e.id),requires_user_action:true};
}

/** 明确目标动作、顺序和时序的协作入口；原件与编辑副本分别保存。 */
export async function importImageSequence(context:WorkContext,files:Array<{name:string;bytes:Uint8Array}>,options:{request_key:string;ordered_names?:string[];timing:TaskBrief['timing'];base_content:ContentToken}):Promise<{source_id:string;frame_ids:string[];content_token:ContentToken}> {
 options=structuredClone(options);
 if(!options||typeof options!=='object'||(options.ordered_names!==undefined&&(!Array.isArray(options.ordered_names)||options.ordered_names.some(n=>typeof n!=='string'))))throw new PipelineError('INVALID_INPUT','序列选项或显式顺序无效');
 draftAxis(context);
 if(!files.length||files.length>2000)throw new PipelineError('INVALID_INPUT','需要1到2000张PNG');
 const names=files.map(f=>f.name);
 if(names.some(n=>!n||n.length>200||n.includes('/')||n.includes('\\')||!n.toLowerCase().endsWith('.png')||n!==n.normalize('NFC'))||new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw new PipelineError('INVALID_INPUT','PNG名称必须唯一、规范且不含目录');
 const ordered=options.ordered_names;
 if(ordered&&(ordered.length!==files.length||new Set(ordered).size!==files.length||ordered.some(n=>!names.includes(n))))throw new PipelineError('INVALID_INPUT','显式顺序必须恰好覆盖全部PNG');
 const sorted=ordered?ordered.map(n=>files.find(f=>f.name===n)!):[...files].sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true})||a.name.localeCompare(b.name,'en'));
 const durations=outputDurations(options.timing,sorted.map(()=>({})));
 if(options.timing.origin==='inferred')throw new PipelineError('TIMING_REQUIRED','PNG时长需要用户确认或已确认预设');
 const operation=claimOperation('import_image_sequence',{request_key:options.request_key},{context,order_origin:ordered?'explicit':'natural',ordered_names:sorted.map(f=>f.name),files:sorted.map(f=>({name:f.name,sha256:createHash('sha256').update(f.bytes).digest('hex')})),timing:options.timing,base_content:options.base_content});
 if(operation.state==='succeeded')return operation.result as unknown as {source_id:string;frame_ids:string[];content_token:ContentToken};
 if(operation.state==='running')throw new PipelineError('OPERATION_BUSY','相同导入正在执行',409);
 const empty=()=>{if(db.query('SELECT 1 FROM animation_steps WHERE axis_id=? LIMIT 1').get(context.axis_id)||db.query('SELECT 1 FROM frames f JOIN animation_tracks t ON t.id=f.track_id WHERE t.axis_id=? LIMIT 1').get(context.axis_id)||db.query('SELECT 1 FROM clips WHERE axis_id=? LIMIT 1').get(context.axis_id))throw new PipelineError('AXIS_NOT_EMPTY','动作已有素材，不能隐式追加或替换',409);};
 assertDraftBase(context,options.base_content);empty();
 const track=db.query('SELECT id FROM animation_tracks WHERE axis_id=? AND is_primary=1').get(context.axis_id) as {id:string}|null;
 if(!track)throw new PipelineError('PRIMARY_TRACK_REQUIRED','目标动作需要主轨');
 db.query("UPDATE collab_operations SET state='running' WHERE id=?").run(operation.id);
 const source=uid(),dir=join(STORAGE_ROOT,'sources',source,'images');mkdirSync(dir,{recursive:true});
 const entries=sorted.map((f,index)=>{const id=uid(),source_frame_id=uid(),version=uid(),raw=join(dir,`source_${index.toString().padStart(6,'0')}.png`);writeFileSync(raw,f.bytes,{flag:'wx'});return {id,source_frame_id,version,raw,mask:join(dir,version+'-mask.png'),rgba:join(dir,version+'-foreground.png'),preview:join(dir,version+'-preview.png'),original_name:f.name};});
 let committedResult:{source_id:string;frame_ids:string[];content_token:ContentToken};
 try {
 const result=await runImageWorker({action:'import',frames:entries},join(dir,'validation'));
 const probe:PngSourceProbe={kind:'png_sequence',schema_version:'1.0',order_origin:ordered?'explicit':'natural',timing:structuredClone(options.timing),warnings:[],frames:entries.map((e,i)=>({source_frame_id:e.source_frame_id,source_index:i,original_name:e.original_name,canonical_path:e.raw,sha256:fileHash(e.raw),width:result.frames[i].width,height:result.frames[i].height}))};
 const manifest=join(dir,'source.json');writeFileSync(manifest,JSON.stringify({source_id:source,project_id:context.project_id,probe},null,2),{flag:'wx'});
 const copies=join(STORAGE_ROOT,'projects',context.project_id,'raw',source);mkdirSync(copies,{recursive:true});
 const editable=entries.map((e,i)=>{const path=join(copies,`${i}.png`);copyFileSync(e.raw,path);return path;});
 committedResult=db.transaction(()=>{
   assertDraftBase(context,options.base_content);empty();
   db.query("INSERT INTO sources(id,project_id,original_name,original_path,sha256,byte_size,probe_json,status,created_at) VALUES(?,?,?,?,?,?,?,'extracted',?)").run(source,context.project_id,'PNG序列',manifest,fileHash(manifest),sorted.reduce((n,f)=>n+f.bytes.length,0),JSON.stringify(probe),Date.now());
   for(let i=0;i<entries.length;i++){const e=entries[i]!,step=uid();
     db.query('INSERT INTO animation_steps(id,axis_id,idx,duration) VALUES(?,?,?,1)').run(step,context.axis_id,i);
     db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,processed_path,status,metadata) VALUES(?,?,?,?,?,?,?,'ready',?)").run(e.id,context.project_id,track.id,step,i,editable[i]!,e.rgba,JSON.stringify({source_id:source,source_frame_id:e.source_frame_id,source_index:i,original_name:e.original_name}));
     db.query('INSERT INTO mask_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(e.version,e.id,null,'imported',e.mask,e.rgba,e.preview,e.raw,fileHash(e.raw),JSON.stringify(result.frames[i]),Date.now());
     db.query('INSERT INTO mask_heads VALUES(?,?,0)').run(e.id,e.version);
   }
   if(options.timing.value.mode==='confirmed_fps')db.query('UPDATE animation_axes SET fps=? WHERE id=?').run(options.timing.value.fps.num/options.timing.value.fps.den,context.axis_id);
   saveDraftState(context,{source_id:source,expected_source_frame_ids:entries.map(e=>e.source_frame_id),timing:structuredClone(options.timing),...(options.timing.value.mode==='confirmed_fps'?{preview_fps:options.timing.value.fps}:{}),durations:Object.fromEntries(entries.map((e,i)=>[e.id,durations[i]]))});
   const reply={source_id:source,frame_ids:entries.map(e=>e.id),content_token:readDraftContent(context).token};finishDraftOperation(operation.id,reply);
   broadcast('frames_changed',{projectId:context.project_id});broadcast('timeline_changed',{projectId:context.project_id});return reply;
 }).immediate();
 }catch(error){db.query("UPDATE collab_operations SET state='failed',checkpoint_json=?,updated_at=? WHERE id=?").run(JSON.stringify({stage:'png_import',retained_directory:dir,error:(error as Error).message}),Date.now(),operation.id);throw error;}
 invalidateProjectUndo(context.project_id);
 return committedResult;
}
