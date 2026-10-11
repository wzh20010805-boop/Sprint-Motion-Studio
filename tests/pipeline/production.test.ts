import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

test('P3/P4 shared HTTP roots, review gate, immutable export, stale publication, cancel and resume', async () => {
 const root=join(import.meta.dir,'../..'), workspace=join(root,'fixtures/generated/p3-p4',crypto.randomUUID()); mkdirSync(workspace,{recursive:true});
 const script=String.raw`
 import assert from 'node:assert/strict';
 import {join} from 'node:path';
 import {readFileSync,existsSync,writeFileSync} from 'node:fs';
 import {db,uid,STORAGE_ROOT} from './apps/server/src/db';
 import {createProject,getProject} from './apps/server/src/pipeline/service';
 import {ensureDefaultTimeline} from './apps/server/src/timeline';
 import {maskState,reviewMask,matteBatch,prepareMatte} from './apps/server/src/pipeline/masks';
 import {getPersistedJob,cancelJob} from './apps/server/src/queue';
 import {app} from './apps/server/src/app';
 import {importImages} from './apps/server/src/pipeline/images';
 import {submitRecipe} from './apps/server/src/pipeline/recipe';
 const project=createProject('P3 P4 验收'),{axis,track}=ensureDefaultTimeline(project.id);
 const image=join(STORAGE_ROOT,'source.png');
 const python=join(process.cwd(),'.venv-image/Scripts/python.exe');
 const p=Bun.spawn([python,'-c',"from PIL import Image,ImageDraw; import sys; i=Image.new('RGB',(64,64),'white'); ImageDraw.Draw(i).rectangle((22,10,42,50),fill='red'); i.save(sys.argv[1])",image],{windowsHide:true});assert.equal(await p.exited,0);
 const ids=Array.from({length:3},()=>uid());for(let i=0;i<3;i++){let s=uid();db.query('INSERT INTO animation_steps(id,axis_id,idx,duration) VALUES(?,?,?,?)').run(s,axis.id,i,i+1);db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,status) VALUES(?,?,?,?,?,?,'raw')").run(ids[i],project.id,track.id,s,i,image);}
 const request=async(path,body)=>{const r=await app.handle(new Request('http://localhost/api/v1'+path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));const text=await r.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed={error:text};}return {code:r.status,...parsed};};
 const config={canvas:{width:64,height:64},anchor:[32,58],scale:1,resampling:'pixel',mode:'ground_keyframes',roots:[{index:0,x:32,y:58},{index:2,x:34,y:58}],offsets:{}};
 let reply=await request('/alignment',{project_id:project.id,axis_id:axis.id,config,base_revision:getProject(project.id).revision});assert.equal(reply.code,200,JSON.stringify(reply));
 assert.equal((await request('/alignment',{project_id:project.id,axis_id:axis.id,config,base_revision:0})).code,409);
 assert.equal((await request('/export',{project_id:project.id,axis_id:axis.id,draft:false})).code,409);
 await matteBatch(prepareMatte({project_id:project.id,frame_ids:ids}));
 for(const id of ids){const s=maskState(id);reviewMask(id,s.version_id,s.revision);}
 reply=await request('/alignment/check',{project_id:project.id,axis_id:axis.id});assert.equal(reply.code,200);assert.equal(reply.data.checks.length,3);
 reply=await request('/review/apply',{project_id:project.id,axis_id:axis.id,base_revision:getProject(project.id).revision,confirmation:'合成验收根位置和边缘确认',source:'test operator'});assert.equal(reply.code,200,JSON.stringify(reply));
 const wait=async(id)=>{for(let i=0;i<600;i++){let j=getPersistedJob(id);if(!['queued','running'].includes(j.status))return j;await Bun.sleep(20);}throw new Error('timeout');};
 reply=await request('/export',{project_id:project.id,axis_id:axis.id,draft:false,max_texture:134});assert.equal(reply.code,200,JSON.stringify(reply));let j=await wait(reply.job_id);assert.equal(j.status,'done',JSON.stringify(j));
 const dir=j.result.directory, manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));assert.equal(manifest.frames.length,3);assert.equal(manifest.release_mode,'reviewed');assert.equal(manifest.duration.num/manifest.duration.den,6/axis.fps);assert.ok(existsSync(join(dir,'previews/preview-on-background.mp4')));
 const maskFile=maskState(ids[0]).current.rgba_path;const maskBytes=readFileSync(maskFile);writeFileSync(maskFile,Buffer.concat([maskBytes,Buffer.from('changed')]));assert.equal((await request('/export',{project_id:project.id,axis_id:axis.id,draft:false})).code,409);writeFileSync(maskFile,maskBytes);assert.equal(manifest.sheets.length,1);assert.equal(manifest.anchor_pixels[1],58);assert.equal(manifest.generator.name,'soldier-frame-studio');
 let preview=await app.handle(new Request('http://localhost/api/v1/preview/'+ids[0]+'?axis_id='+axis.id));assert.equal(preview.status,200);assert.deepEqual(new Uint8Array(await preview.arrayBuffer()),new Uint8Array(readFileSync(join(dir,manifest.frames[0].file))));
 // Exact reviewed revision cannot approve future editor changes.
 db.query('UPDATE frames SET offset_x=1 WHERE id=?').run(ids[0]);assert.equal((await request('/export',{project_id:project.id,axis_id:axis.id,draft:false})).code,409);
 // Draft is allowed but stale work must never publish.
 reply=await request('/export',{project_id:project.id,axis_id:axis.id,draft:true});db.query('UPDATE frames SET offset_x=2 WHERE id=?').run(ids[0]);j=await wait(reply.job_id);assert.equal(j.error_code,'STALE_JOB_RESULT');assert.ok(existsSync(join(dir,'manifest.json')));
 reply=await request('/jobs/'+j.id+'/resume',{});assert.equal(reply.code,200);j=await wait(reply.job_id);assert.equal(j.status,'done',JSON.stringify(j));assert.equal(j.result.draft,true);
 reply=await request('/export',{project_id:project.id,axis_id:axis.id,draft:true});assert.equal(cancelJob(reply.job_id),true);j=await wait(reply.job_id);assert.equal(j.status,'cancelled');
 assert.equal((await request('/exports/'+uid()+'/file?path=../../framebaker.db')).code,400);
 // PNG序列自然排序、保留输入Alpha、不自动审核；recipe输出与GUI走同一队列。
 const imageProject=createProject('PNG and recipe'),png=join(STORAGE_ROOT,'alpha.png');
 const alpha=Bun.spawn([python,'-c',"from PIL import Image,ImageDraw; import sys; i=Image.new('RGBA',(64,64),(0,0,0,0)); ImageDraw.Draw(i).rectangle((20,10,42,50),fill=(180,60,90,128)); ImageDraw.Draw(i).rectangle((30,30,32,32),fill=(180,60,90,255)); i.save(sys.argv[1])",png],{windowsHide:true});assert.equal(await alpha.exited,0);
 const imported=await importImages(imageProject.id,[{name:'frame10.png',bytes:readFileSync(png)},{name:'frame2.png',bytes:readFileSync(png)}]);
 const ordered=db.query('SELECT metadata FROM frames WHERE project_id=? ORDER BY idx').all(imageProject.id);assert.equal(JSON.parse(ordered[0].metadata).original_name,'frame2.png');assert.equal(maskState(imported.frame_ids[0]).reviewed,false);
 assert.throws(()=>submitRecipe(imageProject.id,imported.axis_id,{schema_version:'wrong'}));
 const recipe={schema_version:'1.0',alignment:{...config,mode:'fixed',roots:[{index:0,x:32,y:58}]},output:{draft:true}};
 const next=submitRecipe(imageProject.id,imported.axis_id,recipe);assert.equal(next.stage,'export');const imageJob=await wait(next.job_id);assert.equal(imageJob.status,'done',JSON.stringify(imageJob));assert.equal(imageJob.result.draft,true);
 const z=Bun.spawn([python,'-c',"from PIL import Image; import zipfile,sys; i=Image.open(sys.argv[1]); assert i.getpixel((25,25))[3]==128; z=zipfile.ZipFile(sys.argv[2]); assert z.testzip() is None; assert 'manifest.json' in z.namelist()",join(imageJob.result.directory,'frames/frame_000001.png'),join(imageJob.result.directory,'assets.zip')],{windowsHide:true});assert.equal(await z.exited,0);
 assert.equal((await request('/export',{project_id:imageProject.id,axis_id:imported.axis_id})).code,409);
 const confirmedImport=maskState(imported.frame_ids[0]);reviewMask(imported.frame_ids[0],confirmedImport.version_id,confirmedImport.revision);
 const requestedMatte=submitRecipe(imageProject.id,imported.axis_id,{schema_version:'1.0',matting:{backend:'rembg',model:'u2netp'},output:{draft:true}});assert.equal(requestedMatte.stage,'matting');const matteJob=await wait(requestedMatte.job_id);assert.equal(matteJob.status,'waiting_user',JSON.stringify(matteJob));assert.equal(matteJob.result.frame_count,1);assert.equal(maskState(imported.frame_ids[0]).version_id,confirmedImport.version_id);
 // 同角色第二动作修改公共比例/画布，旧动作根轨迹独立但使用新的公共预设。
 const otherAxis=uid(),otherTrack=uid(),otherStep=uid();db.query('INSERT INTO animation_axes VALUES(?,?,?,1,8,?)').run(otherAxis,project.id,'death',Date.now());db.query("INSERT INTO animation_tracks VALUES(?,?,'Main',0,1,0,1)").run(otherTrack,otherAxis);db.query('INSERT INTO animation_steps VALUES(?,?,0,1)').run(otherStep,otherAxis);db.query("INSERT INTO frames(id,project_id,track_id,step_id,idx,raw_path,status) VALUES(?,?,?,?,0,?,'raw')").run(uid(),project.id,otherTrack,otherStep,image);
 const shared={...config,canvas:{width:96,height:96},scale:1.5,mode:'fixed',roots:[{index:0,x:32,y:58}]};reply=await request('/alignment',{project_id:project.id,axis_id:otherAxis,config:shared,base_revision:getProject(project.id).revision});assert.equal(reply.code,200);
 const oldAction=await request('/alignment?project_id='+project.id+'&axis_id='+axis.id);assert.equal(oldAction.data.config.scale,1.5);assert.equal(oldAction.data.config.canvas.width,96);assert.deepEqual(oldAction.data.config.roots,config.roots);
 writeFileSync(join(STORAGE_ROOT,'production-test.json'),JSON.stringify({project:project.id,axis:axis.id,directory:dir,manifest}));db.close();console.log('P3/P4 production checks passed');
 `;
 const proc=Bun.spawn([process.execPath,'-e',script],{cwd:root,env:{...process.env,SFS_WORKSPACE:workspace},stdout:'pipe',stderr:'pipe',windowsHide:true});
 const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);expect(code,out+'\n'+err).toBe(0);
},60000);



