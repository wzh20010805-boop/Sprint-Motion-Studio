import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';

test('editor transforms affect shared preview, reviewed export and fingerprints; soft PNG reviews stay safe',async()=>{
 const root=join(import.meta.dir,'../..'),workspace=join(root,'fixtures/generated/editor-export',crypto.randomUUID());mkdirSync(workspace,{recursive:true});
 const script=String.raw`
 import assert from 'node:assert/strict';
 import {join} from 'node:path';import {readFileSync,writeFileSync} from 'node:fs';
 import {db,STORAGE_ROOT} from './apps/server/src/db';
 import {createProject,getProject} from './apps/server/src/pipeline/service';
 import {importImages} from './apps/server/src/pipeline/images';
 import {maskState,reviewMask,imagePython,editMask} from './apps/server/src/pipeline/masks';
 import {saveAlignment,previewFrame,approveAlignment,reviewFingerprint,checkAlignment} from './apps/server/src/pipeline/alignment';
 import {exportSnapshot,prepareExport,exportAssets} from './apps/server/src/pipeline/export';
 import {app} from './apps/server/src/app';
 const python=imagePython(),file=join(STORAGE_ROOT,'input.png');
 async function image(alpha){const p=Bun.spawn([python,'-c',"from PIL import Image,ImageDraw; import sys; i=Image.new('RGBA',(32,32)); ImageDraw.Draw(i).rectangle((8,8,20,24),fill=(210,60,90,int(sys.argv[2]))); i.save(sys.argv[1])",file,String(alpha)],{stdout:'pipe',stderr:'pipe',windowsHide:true});const [code,,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);assert.equal(code,0,err);}
 for(const alpha of [128,1,0]){
  await image(alpha);const project=createProject('soft alpha '+alpha),imported=await importImages(project.id,[{name:'frame1.png',bytes:readFileSync(file)}]),id=imported.frame_ids[0];
  let state=maskState(id);
  if(!alpha){assert.throws(()=>reviewMask(id,state.version_id,state.revision),e=>e.code==='MATTE_NO_FOREGROUND');continue;}
  const legacy={...JSON.parse(state.current.info),reasons:['LOW_CONFIDENCE']};db.query('UPDATE mask_versions SET info=? WHERE id=?').run(JSON.stringify(legacy),state.version_id);
  const response=await app.handle(new Request('http://localhost/api/v1/projects/'+project.id+'/masks'));const summary=await response.json();assert.equal(JSON.parse(summary.data.frames[0].info).reasons.includes('LOW_CONFIDENCE'),false);
  state=maskState(id);reviewMask(id,state.version_id,state.revision);
  state=await editMask(id,state.version_id,[{mode:'erase',size:1,points:[[8,8]]}],getProject(project.id).revision);reviewMask(id,state.version_id,state.revision);
  const config={canvas:{width:64,height:64},anchor:[16,16],scale:1,resampling:'pixel',mode:'fixed',roots:[{index:0,x:0,y:0}],offsets:{}};
  saveAlignment(project.id,imported.axis_id,config,getProject(project.id).revision);
  const originalPreview=readFileSync(await previewFrame(project.id,imported.axis_id,id)),fingerprint=reviewFingerprint(project.id,imported.axis_id);
  await approveAlignment(project.id,imported.axis_id,getProject(project.id).revision,'isolated synthetic operator','regression test');
  const saved=prepareExport({project_id:project.id,axis_id:imported.axis_id});
  db.query('UPDATE frames SET offset_x=4,offset_y=3,scale=.5,rotation=?,opacity=.5 WHERE id=?').run(Math.PI/2,id);
  db.query('UPDATE projects SET revision=? WHERE id=?').run(saved.revision,project.id);
  assert.notEqual(reviewFingerprint(project.id,imported.axis_id),fingerprint);
  assert.throws(()=>exportSnapshot({project_id:project.id,axis_id:imported.axis_id}),e=>e.code==='MASK_REVIEW_REQUIRED');
  await assert.rejects(exportAssets(saved),e=>e.code==='MASK_REVIEW_REQUIRED'||e.code==='STALE_JOB_RESULT');
  const preview=readFileSync(await previewFrame(project.id,imported.axis_id,id));assert.notDeepEqual(preview,originalPreview);
  const snapshot=exportSnapshot({project_id:project.id,axis_id:imported.axis_id,draft:true}).snapshot;
  assert.deepEqual(snapshot.frames[0].transform,{offset_x:4,offset_y:3,scale:.5,rotation:Math.PI/2,opacity:.5});
  await approveAlignment(project.id,imported.axis_id,getProject(project.id).revision,'synthetic transformed frame reviewed','regression test');
  const result=await exportAssets(prepareExport({project_id:project.id,axis_id:imported.axis_id}));
  const manifest=JSON.parse(readFileSync(join(result.directory,'manifest.json'),'utf8'));assert.deepEqual(manifest.frames[0].transform,snapshot.frames[0].transform);
  assert.deepEqual(preview,readFileSync(join(result.directory,manifest.frames[0].file)));
  if(alpha===128){
   const {setAxisWorkflowMode}=await import('./apps/server/src/pipeline/collaboration/store');
   const late=prepareExport({project_id:project.id,axis_id:imported.axis_id});
   await assert.rejects(exportAssets(late,()=>setAxisWorkflowMode({project_id:project.id,axis_id:imported.axis_id},'collaboration')),e=>e.code==='IMMUTABLE_DELIVERY_REQUIRED');
   assert.throws(()=>prepareExport(late.request),e=>e.code==='IMMUTABLE_DELIVERY_REQUIRED');
  }
  db.query('UPDATE frames SET offset_x=.4,offset_y=.4,scale=.001,rotation=0,opacity=1 WHERE id=?').run(id);
  const disappeared=await checkAlignment(project.id,imported.axis_id);assert.equal(disappeared.checks[0].empty,true);assert.equal(disappeared.checks[0].overflow,false);
  await assert.rejects(approveAlignment(project.id,imported.axis_id,getProject(project.id).revision,'empty resampled frame','regression test'),e=>e.code==='ALIGNMENT_REVIEW_REQUIRED');
  db.query('UPDATE frames SET offset_x=1000 WHERE id=?').run(id);assert.equal((await checkAlignment(project.id,imported.axis_id)).checks[0].overflow,true);
 }
 await image(128);const p=createProject('automatic guard'),i=await importImages(p.id,[{name:'noise.png',bytes:readFileSync(file)}]);let s=maskState(i.frame_ids[0]);
 db.query('UPDATE mask_versions SET kind=?,info=? WHERE id=?').run('automatic',JSON.stringify({...JSON.parse(s.current.info),reasons:['LOW_CONFIDENCE']}),s.version_id);s=maskState(i.frame_ids[0]);assert.throws(()=>reviewMask(i.frame_ids[0],s.version_id,s.revision),e=>e.code==='MATTE_NO_FOREGROUND');
 db.close();console.log('Editor/export and soft alpha regression passed');
 `;
 const p=Bun.spawn([process.execPath,'-e',script],{cwd:root,env:{...process.env,SFS_WORKSPACE:workspace},stdout:'pipe',stderr:'pipe',windowsHide:true});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);expect(code,out+'\n'+err).toBe(0);
},60000);
