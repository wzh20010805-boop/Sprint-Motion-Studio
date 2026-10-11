import { mkdirSync,writeFileSync } from 'node:fs';
import { join,basename } from 'node:path';
import { db,uid,STORAGE_ROOT } from '../db';
import { getProject,PipelineError } from './service';
import { ensureDefaultTimeline } from '../timeline';
import { runImageWorker } from './masks';
import { fileHash } from './alignment';
import { broadcast } from '../ws';

/** PNG输入保存完整原件；有Alpha的输入建立独立可编辑遮罩，始终需要人工确认。 */
export async function importImages(project:string,files:Array<{name:string;bytes:Uint8Array}>,name='PNG序列') {
 const revision=getProject(project).revision;
 if(!files.length||files.length>2000)throw new PipelineError('INVALID_INPUT','需要1到2000张PNG');
 files.sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
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
