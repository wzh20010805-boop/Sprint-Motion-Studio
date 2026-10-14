export const setup = String.raw`
import assert from 'node:assert/strict';
const {db,STORAGE_ROOT,uid}=await import('./apps/server/src/db');
const {createProject,getProject,getSource,createClip}=await import('./apps/server/src/pipeline/service');
const {ensureDefaultTimeline,setStepDuration,reorderSteps}=await import('./apps/server/src/timeline');
const d=await import('./apps/server/src/pipeline/collaboration/drafts');
const {importImageSequence}=await import('./apps/server/src/pipeline/images');
const {imagePython,maskState,reviewMask}=await import('./apps/server/src/pipeline/masks');
const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
const project=createProject('task3'),{axis,track}=ensureDefaultTimeline(project.id),context={project_id:project.id,axis_id:axis.id};
const path=join(STORAGE_ROOT,'input.png');const proc=Bun.spawn([imagePython(),'-c',"from PIL import Image,ImageDraw;import sys;i=Image.new('RGBA',(64,64),(0,0,0,0));ImageDraw.Draw(i).rectangle((20,8,40,50),fill=(255,0,0,255));i.save(sys.argv[1])",path],{windowsHide:true});assert.equal(await proc.exited,0);const bytes=readFileSync(path);
const timing={value:{mode:'confirmed_fps',fps:{num:12,den:1}},origin:'user'};
const config={canvas:{width:32,height:32},anchor:[16,30],scale:1,resampling:'pixel',mode:'fixed',roots:[{index:0,x:4,y:8}],offsets:{}};
const actor={session_id:'internal-fixture',role:'maker'};
const importSeq=(files,options={})=>importImageSequence(context,files,{request_key:uid(),timing,base_content:d.readDraftContent(context).token,...options});
const files=[{name:'frame10.png',bytes},{name:'frame2.png',bytes}];
`;
