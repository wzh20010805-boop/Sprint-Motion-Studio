import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ensureService} from '../apps/cli/src/client';
const root=resolve(import.meta.dir,'..');
const workspace=join(root,'fixtures/generated/material-retention-desktop',crypto.randomUUID());mkdirSync(workspace,{recursive:true});
process.env.SFS_WORKSPACE=workspace;
const evidence=join(root,'docs/evidence/material-retention/desktop',new Date().toISOString().replaceAll(':','-'));mkdirSync(evidence,{recursive:true});
const {db}=await import('../apps/server/src/db');
const {createProject}=await import('../apps/server/src/pipeline/service');
const {ensureDefaultTimeline}=await import('../apps/server/src/timeline');
const project=createProject('素材库复用验收');ensureDefaultTimeline(project.id);db.close();
const video=join(workspace,'run.mp4'),image=join(workspace,'hero.png');
for(const argv of [
  ['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','6','-c:v','libx264','-pix_fmt','yuv420p',video],
  ['ffmpeg','-hide_banner','-nostdin','-n','-i',video,'-frames:v','1',image],
]) {const proc=Bun.spawn(argv,{windowsHide:true,stdout:'ignore',stderr:'pipe'});const err=await new Response(proc.stderr).text();if(await proc.exited!==0)throw Error(err);}
const service=await ensureService(workspace);
try{
  const proc=Bun.spawn([join(root,'probes/desktop/node_modules/electron/dist/electron.exe'),join(root,'probes/desktop'),'--smoke'],{cwd:root,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,SFS_SERVICE_URL:service.url,SFS_SERVICE_TOKEN:service.token,SFS_PROBE_PATH:'/project/'+project.id,SFS_PROBE_SCENARIO:'material-retention',SFS_PROBE_VIDEO_FILE:video,SFS_PROBE_IMAGE_FILE:image,P0_EVIDENCE_DIR:evidence,P0_PROFILE_DIR:join(workspace,'.sfs/material-retention-profile')}});
  const [exit,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  writeFileSync(join(evidence,'command-output.txt'),out+'\n'+err);
  const report=JSON.parse(readFileSync(join(evidence,'desktop-report.json'),'utf8'));
  writeFileSync(join(evidence,'run-meta.json'),JSON.stringify({workspace,project:project.id,command:'bun scripts/verify_material_retention.ts',exit},null,2));
  console.log(JSON.stringify({exit,evidence,passed:report.materialRetentionScenario?.passed,error:report.error,consoleErrors:report.console.filter((m:any)=>m.level==='error')},null,2));
  process.exitCode=exit;
}finally{process.kill(service.pid);}
