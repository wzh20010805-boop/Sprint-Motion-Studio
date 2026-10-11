import { test, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('真实CPU批量初稿、修笔、冲突、撤销、待人工任务与重启持久化', async()=>{
 const root=join(import.meta.dir,'../..'), workspace=join(root,'fixtures/generated/p2-service',crypto.randomUUID());mkdirSync(workspace,{recursive:true});
 const script=String.raw`
 import assert from 'node:assert/strict';
 import {join} from 'node:path';
 import {writeFileSync,readFileSync} from 'node:fs';
 import {createHash} from 'node:crypto';
 import {db,uid,STORAGE_ROOT} from './apps/server/src/db';
 import {runImageWorker,maskState,editMask,undoMask,reviewMask,prepareMatte,matteBatch,imagePython} from './apps/server/src/pipeline/masks';
 import {createSceneMattingJob,getPersistedJob} from './apps/server/src/queue';
 import {app} from './apps/server/src/app';
 const project=uid();db.query('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(project,'P2 合成场景验收',Date.now());
 const python=imagePython();
 const image=join(STORAGE_ROOT,'soldier.png');
 const create=Bun.spawn([python,'-c',"from PIL import Image,ImageDraw; import sys; i=Image.new('RGB',(128,128),(140,190,160)); d=ImageDraw.Draw(i); d.rectangle((0,100,127,127),fill=(90,110,130)); d.ellipse((44,20,84,62),fill=(245,80,160)); d.rectangle((43,59,86,95),fill=(60,200,245)); d.rectangle((43,96,55,120),fill=(90,60,160)); d.rectangle((74,96,86,120),fill=(90,60,160)); d.line((106,12,106,105),fill=(240,230,80),width=2); i.save(sys.argv[1])",image],{stdout:'pipe',stderr:'pipe',windowsHide:true});
 assert.equal(await create.exited,0);
 const hash=()=>createHash('sha256').update(readFileSync(image)).digest('hex');const before=hash();
 const ids=Array.from({length:3},()=>uid());for(let i=0;i<ids.length;i++)db.query("INSERT INTO frames(id,project_id,idx,raw_path,status) VALUES(?,?,?,?, 'raw')").run(ids[i],project,i,image);
 const request=async(path,body)=>{const response=await app.handle(new Request('http://localhost/api/v1'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined));return{code:response.status,...await response.json()};};
 assert.equal((await request('/matte',{project_id:project,frame_ids:ids,base_revision:0})).code,409);
 const accepted=await request('/matte',{project_id:project,frame_ids:ids,region:[0,0,128,128]});assert.equal(accepted.status,'accepted');
 let job;for(let i=0;i<1000;i++){job=getPersistedJob(accepted.job_id);if(!['queued','running'].includes(job.status))break;await Bun.sleep(50);}
 assert.equal(job.status,'waiting_user',JSON.stringify(job));assert.equal(job.requires_user_action,1);assert.equal(job.result.session_count,1);assert.equal(job.result.frame_count,3);assert.equal(hash(),before);
 assert.equal((await request('/jobs/'+job.id)).requires_user_action,true);
 let state=maskState(ids[0]);const auto=state.current;
 const oldProcessed=db.query('SELECT processed_path FROM frames WHERE id=?').get(ids[0]).processed_path;
 await assert.rejects(()=>matteBatch(prepareMatte({project_id:project,frame_ids:ids,region:[0,0,24,24]})),e=>e.code==='REGION_NO_FOREGROUND'&&e.message.includes('请框住角色及装备'));
 assert.equal(maskState(ids[0]).version_id,auto.id);assert.equal(maskState(ids[0]).versions.length,1);
 assert.equal(db.query('SELECT processed_path FROM frames WHERE id=?').get(ids[0]).processed_path,oldProcessed);
 assert.equal(state.versions.length,1);assert.equal(auto.kind,'automatic');
 const rawBytes=readFileSync(auto.raw_path);const maskBytes=readFileSync(auto.mask_path);
 const stale=await request('/masks/'+ids[0]+'/strokes',{version_id:state.version_id,revision:state.revision-1,strokes:[{mode:'erase',size:3,points:[[50,50]]}]});assert.equal(stale.code,409);
 state=await editMask(ids[0],state.version_id,[{mode:'erase',size:5,points:[[50,50]]},{mode:'restore',size:1,points:[[106,12],[106,105]]}],state.revision);
 assert.equal(state.versions.length,2);assert.equal(state.current.kind,'manual');assert.deepEqual(readFileSync(auto.mask_path),maskBytes);assert.deepEqual(readFileSync(auto.raw_path),rawBytes);assert.equal(hash(),before);
 const check=Bun.spawn([python,'-c',"from PIL import Image; import sys; i=Image.open(sys.argv[1]); assert i.mode=='RGBA'; assert i.size==(128,128); assert i.getpixel((50,50))[3]==0; assert i.getpixel((106,12))[3]==255; assert i.getpixel((106,105))[3]==255",state.current.rgba_path],{stdout:'pipe',stderr:'pipe',windowsHide:true});const err=await new Response(check.stderr).text();assert.equal(await check.exited,0,err);
 const manualId=state.version_id;state=undoMask(ids[0],state.version_id,state.revision);assert.equal(state.version_id,auto.id);assert.equal(state.versions.length,2);
 state=await editMask(ids[0],state.version_id,[{mode:'erase',size:512,points:[[64,64]]}],state.revision);
 assert.throws(()=>reviewMask(ids[0],state.version_id,state.revision),e=>e.code==='MATTE_NO_FOREGROUND');
 state=undoMask(ids[0],state.version_id,state.revision);assert.equal(state.version_id,auto.id);
 const sourceBytes=readFileSync(image);writeFileSync(image,Buffer.concat([sourceBytes,Buffer.from('modified')]));assert.equal(maskState(ids[0]).source_changed,true);assert.equal(maskState(ids[0]).current,null);assert.equal(maskState(ids[0]).reviewed,false);await assert.rejects(()=>editMask(ids[0],auto.id,[],state.revision),e=>e.code==='SOURCE_CHANGED');writeFileSync(image,sourceBytes);
 for(const id of ids){const s=maskState(id);reviewMask(id,s.version_id,s.revision);}
 assert.equal(getPersistedJob(job.id).status,'done');
 const conflict=prepareMatte({project_id:project,frame_ids:[ids[0]]});db.query('UPDATE frames SET offset_x=1 WHERE id=?').run(ids[0]);
 await assert.rejects(()=>matteBatch(conflict), e=>e.code==='STALE_JOB_RESULT');assert.equal(maskState(ids[0]).version_id,auto.id);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>matteBatch(prepareMatte({project_id:project,frame_ids:[ids[0]]}),undefined,cancelled.signal));
 process.env.SFS_MODEL_DIR=join(STORAGE_ROOT,'missing-model');assert.throws(()=>prepareMatte({project_id:project,frame_ids:[ids[0]]}),e=>e.code==='MODEL_NOT_READY');delete process.env.SFS_MODEL_DIR;
 writeFileSync(join(STORAGE_ROOT,'persist.json'),JSON.stringify({project,frame:ids[0],autoId:auto.id,manualId,hash:before}));db.close();console.log('P2 service checks passed');
 `;
 const run=async(code:string)=>{const proc=Bun.spawn([process.execPath,'-e',code],{cwd:root,env:{...process.env,SFS_WORKSPACE:workspace},stdout:'pipe',stderr:'pipe',windowsHide:true});const [exit,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);return{exit,out,err};};
 const first=await run(script);expect(first.exit,first.out+'\n'+first.err).toBe(0);
 const second=await run(String.raw`import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{join}from'node:path';import{db,STORAGE_ROOT}from'./apps/server/src/db';import{maskState}from'./apps/server/src/pipeline/masks';const saved=JSON.parse(readFileSync(join(STORAGE_ROOT,'persist.json'),'utf8'));const state=maskState(saved.frame);assert.equal(state.version_id,saved.autoId);assert.equal(state.reviewed,true);assert.ok(state.versions.some(v=>v.id===saved.manualId));assert.equal(db.query('SELECT processed_path FROM frames WHERE id=?').get(saved.frame).processed_path,state.current.rgba_path);db.close();console.log('Reopened mask and undo persisted');`);
 expect(second.exit,second.out+'\n'+second.err).toBe(0);
 const saved=await Bun.file(join(workspace,'persist.json')).json();
 const invoke=async(args:string[])=>{const proc=Bun.spawn([process.execPath,join(root,'apps/cli/src/index.ts'),...args,'--workspace',workspace,'--json'],{cwd:root,stdout:'pipe',stderr:'pipe',windowsHide:true});const[exit,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);return{exit,body:JSON.parse(out),err};};
 let serviceInfo:any;
 try{
  const shown=await invoke(['mask','show','--frame',saved.frame]);expect(shown.exit,shown.err).toBe(0);expect(shown.body.data.version_id).toBe(saved.autoId);
  const strokes=join(workspace,'画笔修正.json');writeFileSync(strokes,JSON.stringify([{mode:'restore',size:1,points:[[106,12],[106,105]]}]));
  const edited=await invoke(['mask','edit','--frame',saved.frame,'--strokes',strokes]);expect(edited.exit,edited.err).toBe(0);expect(edited.body.data.current.kind).toBe('manual');
  const undone=await invoke(['mask','undo','--frame',saved.frame]);expect(undone.exit,undone.err).toBe(0);expect(undone.body.data.version_id).toBe(saved.autoId);
  const draft=await invoke(['matte','--project',saved.project,'--frames',saved.frame,'--wait']);expect(draft.exit,JSON.stringify(draft.body)).toBe(4);expect(draft.body.requires_user_action).toBe(true);
  const approved=await invoke(['mask','review','--frame',saved.frame]);expect(approved.exit,approved.err).toBe(0);expect(approved.body.data.reviewed).toBe(true);
  const finished=await invoke(['job','wait','--job',draft.body.job_id]);expect(finished.exit,finished.err).toBe(0);
 }finally{try{serviceInfo=await Bun.file(join(workspace,'.sfs/service.json')).json();process.kill(serviceInfo.pid);}catch{/*服务已经退出*/}}
 writeFileSync(join(workspace,'test-report.txt'),first.out+first.err+second.out+second.err);
},90000);
