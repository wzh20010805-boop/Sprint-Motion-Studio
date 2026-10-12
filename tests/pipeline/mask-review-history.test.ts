import { test, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('遮罩确认不受已删历史帧阻塞；失败时确认、修订与任务一起回滚', async () => {
 const root=join(import.meta.dir,'../..');
 const workspace=join(root,'fixtures/generated/mask-review-history',crypto.randomUUID());
 mkdirSync(workspace,{recursive:true});
 const script=String.raw`
 import assert from 'node:assert/strict';
 import {writeFileSync} from 'node:fs';
 import {join} from 'node:path';
 import {createHash} from 'node:crypto';
 import {db,uid,STORAGE_ROOT} from './apps/server/src/db';
 import {maskState} from './apps/server/src/pipeline/masks';
 import {app} from './apps/server/src/app';
 const project=uid();
 db.query('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(project,'历史任务确认回归',Date.now());
 const image=join(STORAGE_ROOT,'original.png');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHaQAAAAASUVORK5CYII=','base64');
 writeFileSync(image,bytes);
 const hash=createHash('sha256').update(bytes).digest('hex');
 let index=0;
 const addFrame=()=>{
  const id=uid(),version=uid();
  db.query("INSERT INTO frames(id,project_id,idx,raw_path,processed_path,status) VALUES(?,?,?,?,?,'ready')").run(id,project,index++,image,image);
  db.query('INSERT INTO mask_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(version,id,null,'automatic',image,image,image,image,hash,JSON.stringify({reasons:[],foreground_fraction:1}),Date.now());
  db.query('INSERT INTO mask_heads VALUES(?,?,0)').run(id,version);
  return id;
 };
 const addJob=(ids)=>{
  const id=uid();
  db.query("INSERT INTO jobs(id,project_id,type,status,payload,result,requires_user_action,created_at) VALUES(?,?,'matting','waiting_user',?,?,1,?)").run(id,project,JSON.stringify({sceneMatting:{project_id:project,frame_ids:ids}}),JSON.stringify({retained_artifact:'original draft evidence'}),Date.now());
  return id;
 };
 const job=id=>db.query('SELECT * FROM jobs WHERE id=?').get(id);
 const review=async(id,s)=>{
  const response=await app.handle(new Request('http://localhost/api/v1/masks/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version_id:s.version_id,revision:s.revision})}));
  return {code:response.status,...await response.json()};
 };
 const deleted=addFrame(),first=addFrame(),second=addFrame(),other=addFrame();
 const moved=addFrame(),movedBatch=addJob([moved,first]),destination=uid();
 db.query('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(destination,'移动后的项目',Date.now());
 db.query('UPDATE frames SET project_id=? WHERE id=?').run(destination,moved);
 const oldBatch=addJob([deleted,first]),deletedOnly=addJob([deleted]),current=addJob([first,second]),unrelated=addJob([other]);
 const oldEvidence=job(oldBatch);
 db.query('DELETE FROM frames WHERE id=?').run(deleted);
 const before=maskState(first);
 let reply=await review(first,before);
 console.log('first review',JSON.stringify({code:reply.code,error:reply.error}));
 assert.equal(reply.code,200,JSON.stringify(reply));
 assert.equal(reply.data.reviewed,true);
 assert.equal(reply.data.revision,before.revision+1);
 for(const id of [oldBatch,deletedOnly,movedBatch]){assert.equal(job(id).status,'cancelled');assert.equal(job(id).requires_user_action,0);}
 assert.equal(maskState(moved).reviewed,false);
 assert.equal(job(oldBatch).payload,oldEvidence.payload);assert.equal(job(oldBatch).result,oldEvidence.result);
 assert.equal(job(current).status,'waiting_user');assert.equal(job(unrelated).status,'waiting_user');
 assert.equal(maskState(second).reviewed,false);
 assert.equal((await review(first,before)).code,409);
 assert.equal(maskState(first).revision,before.revision+1);
 reply=await review(second,maskState(second));assert.equal(reply.code,200,JSON.stringify(reply));
 assert.equal(job(current).status,'done');assert.equal(job(current).requires_user_action,0);
 assert.equal(job(unrelated).status,'waiting_user');
 const currentRevision=maskState(first).revision;
 assert.equal((await review(deleted,{version_id:uid(),revision:currentRevision})).code,404);
 assert.equal(maskState(first).revision,currentRevision);

 // 任务落库失败必须回滚整次确认，不能先保存审核再返回失败。
 const lateDeleted=addFrame(),lateJob=addJob([lateDeleted]);
 db.query('DELETE FROM frames WHERE id=?').run(lateDeleted);
 const rollbackFrame=addFrame(),rollbackJob=addJob([rollbackFrame]);
 db.exec("CREATE TRIGGER review_job_failure BEFORE UPDATE ON jobs WHEN NEW.id='"+rollbackJob+"' BEGIN SELECT RAISE(ABORT,'injected job failure'); END;");
 const rollbackBefore=maskState(rollbackFrame);
 reply=await review(rollbackFrame,rollbackBefore);
 assert.equal(reply.code,500);assert.match(reply.error.message,/injected job failure/);
 assert.equal(maskState(rollbackFrame).reviewed,false);
 assert.equal(maskState(rollbackFrame).revision,rollbackBefore.revision);
 assert.equal(job(rollbackJob).status,'waiting_user');
 assert.equal(job(lateJob).status,'waiting_user');assert.equal(job(lateJob).requires_user_action,1);
 db.exec('DROP TRIGGER review_job_failure');
 reply=await review(rollbackFrame,rollbackBefore);assert.equal(reply.code,200,JSON.stringify(reply));
 assert.equal(reply.data.reviewed,true);assert.equal(job(rollbackJob).status,'done');
 assert.equal(job(lateJob).status,'cancelled');
 console.log('Historical frames, current review, stale rejection, evidence retention and atomic rollback passed');
 db.close();
 `;
 const proc=Bun.spawn([process.execPath,'-e',script],{cwd:root,env:{...process.env,SFS_WORKSPACE:workspace},windowsHide:true,stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
 expect(code,out+'\n'+err).toBe(0);
},30000);
