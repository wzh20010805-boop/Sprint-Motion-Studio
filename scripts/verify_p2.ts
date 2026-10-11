import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureService } from '../apps/cli/src/client';
const root=resolve(import.meta.dir,'..');
const workspace=join(root,'fixtures/generated/p2-desktop',crypto.randomUUID());mkdirSync(workspace,{recursive:true});
process.env.SFS_WORKSPACE=workspace;
const evidence=join(root,'docs/evidence/p2/desktop',new Date().toISOString().replaceAll(':','-'));mkdirSync(evidence,{recursive:true});
const {db,uid}=await import('../apps/server/src/db');
const {createProject}=await import('../apps/server/src/pipeline/service');
const {ensureDefaultTimeline}=await import('../apps/server/src/timeline');
const project=createProject('荧光小兵 · P2 合成验收');const {axis,track}=ensureDefaultTimeline(project.id);
const image=join(workspace,'场景原图.png');
const child=Bun.spawn([join(root,'.venv-image/Scripts/python.exe'),'-c',"from PIL import Image,ImageDraw; import sys; i=Image.new('RGB',(128,128),(140,190,160)); d=ImageDraw.Draw(i); d.rectangle((0,100,127,127),fill=(90,110,130)); d.ellipse((44,20,84,62),fill=(245,80,160)); d.rectangle((43,59,86,95),fill=(60,200,245)); d.rectangle((43,96,55,120),fill=(90,60,160)); d.rectangle((74,96,86,120),fill=(90,60,160)); d.line((106,12,106,105),fill=(240,230,80),width=2); i.save(sys.argv[1])",image],{windowsHide:true,stdout:'pipe',stderr:'pipe'});
if(await child.exited!==0)throw new Error(await new Response(child.stderr).text());
for(let i=0;i<3;i++){const step=uid(),id=uid();db.query('INSERT INTO animation_steps VALUES(?,?,?,1)').run(step,axis.id,i);db.query("INSERT INTO frames(id,project_id,idx,raw_path,status,track_id,step_id) VALUES(?,?,?,?,'raw',?,?)").run(id,project.id,i,image,track.id,step);}
if(process.env.SFS_PROBE_SCENARIO==='onion-preview')db.query('UPDATE frames SET offset_x=32 WHERE project_id=? AND idx=1').run(project.id);
db.close();
const service=await ensureService(workspace);
try{
 const proc=Bun.spawn([join(root,'probes/desktop/node_modules/electron/dist/electron.exe'),join(root,'probes/desktop'),'--smoke'],{cwd:root,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,SFS_SERVICE_URL:service.url,SFS_SERVICE_TOKEN:service.token,SFS_PROBE_PATH:'/project/'+project.id,SFS_PROBE_SCENARIO:process.env.SFS_PROBE_SCENARIO??'p2-masks',P0_EVIDENCE_DIR:evidence,P0_PROFILE_DIR:join(workspace,'.sfs/p2-profile')}});
 const [exit,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
 writeFileSync(join(evidence,'command-output.txt'),out+'\n'+err);
 const report=JSON.parse(readFileSync(join(evidence,'desktop-report.json'),'utf8'));
 writeFileSync(join(evidence,'run-meta.json'),JSON.stringify({workspace,project:project.id,command:'bun scripts/verify_p2.ts',bun:Bun.version,exit},null,2));
 console.log(JSON.stringify({exit,evidence,passed:report.p2Scenario?.passed??report.onionScenario?.passed,error:report.error,consoleErrors:report.console.filter((m:any)=>m.level==='error')},null,2));
 process.exitCode=exit;
}finally{process.kill(service.pid);}
