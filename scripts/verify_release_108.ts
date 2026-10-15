/** 1.0.8 便携包隔离冒烟；不作真实美术验收，也不更改用户工作区。 */
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';

const repo=resolve(import.meta.dir,'..');
const packageRoot=resolve(process.argv[2]??'');
const allowedEvidence=join(repo,'fixtures/generated/release-1.0.8');
const evidence=resolve(process.argv[3]??join(allowedEvidence,'cli-api-'+Date.now()));
const evidenceRelative=relative(allowedEvidence,evidence);
assert.ok(evidenceRelative&&evidenceRelative!=='..'&&!evidenceRelative.startsWith('..'+sep)&&!isAbsolute(evidenceRelative),'证据必须位于 fixtures/generated/release-1.0.8 的独立子目录');
assert.ok(!existsSync(evidence),'不覆盖已有证据目录');
assert.ok(existsSync(join(packageRoot,'sfs.exe')),'需要已构建便携包目录');
mkdirSync(evidence,{recursive:true});
const workspace=join(evidence,'工作区 A'),otherWorkspace=join(evidence,'工作区 B'),user=join(evidence,'u');
mkdirSync(workspace);mkdirSync(otherWorkspace);
const cli=join(packageRoot,'sfs.exe'),python=join(packageRoot,'runtime/python/python.exe');
const env:Record<string,string|undefined>={...process.env,PATH:'C:\\Windows\\System32;C:\\Windows',LOCALAPPDATA:user,SFS_IDLE_TIMEOUT_MS:'300000',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',NUMBA_CACHE_DIR:join(evidence,'numba-cache')};
for(const key of ['SFS_WORKSPACE','SFS_REPO_ROOT','SFS_IMAGE_PYTHON','SFS_MODEL_DIR','SFS_SERVICE_URL','SFS_SERVICE_TOKEN','SFS_SMOKE_SCENARIO','SFS_SMOKE_PAGE','SFS_SMOKE_EVIDENCE'])delete env[key];
const secrets:string[]=[];
const redact=(value:string)=>secrets.reduce((s,secret)=>s.split(secret).join('[REDACTED]'),value);
const save=(name:string,value:unknown)=>writeFileSync(join(evidence,name+'.json'),redact(JSON.stringify(value,null,2)));
const identity=()=>{const info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));if(!secrets.includes(info.token))secrets.push(info.token);return info;};
const projectIdentity=(info:any)=>({workspace:info.workspace,instance_id:info.instance_id,pid:info.pid,url:info.url});
async function command(name:string,exe:string,args:string[],expected=0,stdin?:string){
 const started=Date.now(),p=Bun.spawn([exe,...args],{cwd:'C:/Windows/Temp',env,windowsHide:true,stdout:'pipe',stderr:'pipe',stdin:stdin?'pipe':'ignore'});
 if(stdin){(p.stdin as any).write(stdin);(p.stdin as any).end();}
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
 save(name,{exe,args,cwd:'C:/Windows/Temp',PATH:env.PATH,code,out,err,elapsed_ms:Date.now()-started});
 assert.equal(code,expected,`${name}: ${redact(out+err)}`);return out;
}
async function json(name:string,args:string[],expected=0){return JSON.parse(await command(name,cli,[...args,'--json'],expected));}
async function http(name:string,path:string,body?:unknown,cookie?:string){
 const info=identity(),response=await fetch(info.url+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:'sfs_reviewer='+cookie}:{Authorization:'Bearer '+info.token}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const text=await response.text();let value:any;try{value=JSON.parse(text);}catch{value=text;}
 save(name,{path,status:response.status,body:value});return {status:response.status,body:value};
}
const flags=['--workspace',workspace];
const modelFlag=process.argv.indexOf('--model');
let completed=false,startedService=false,stopped=false;
const checks:string[]=[];
try{
 const inventory=JSON.parse(readFileSync(join(packageRoot,'sfs-package.json'),'utf8'));
 const production=JSON.parse(readFileSync(join(packageRoot,'resources/app/productionVersion.json'),'utf8'));
 assert.equal(inventory.version,'1.0.8');assert.equal(inventory.production_api_version,'1.3');assert.equal(production.version,'1.3');
 save('package-identity',{root:packageRoot,version:inventory.version,production_api_version:production.version,cli_sha256:createHash('sha256').update(readFileSync(cli)).digest('hex')});
 const initial=await json('workspace-current-default',['workspace','current']);assert.ok(initial.data.workspace.startsWith(user+sep));
 await json('workspace-list-default',['workspace','list']);
 await json('workspace-add-a',['workspace','add','--name','release-a','--directory',workspace]);
 await json('workspace-add-b',['workspace','add','--name','release-b','--directory',otherWorkspace]);
 await json('workspace-use-b',['workspace','use','--name','release-b']);
 assert.equal((await json('workspace-current-b',['workspace','current'])).data.workspace,otherWorkspace);
 await json('workspace-use-a',['workspace','use','--name','release-a']);
 assert.equal((await json('workspace-current-a',['workspace','current'])).data.workspace,workspace);
 assert.equal((await json('service-status-before',['service','status',...flags])).data.status,'stopped');
 assert.ok(!existsSync(join(workspace,'.sfs/service.json')));checks.push('isolated portable registry list/current/add/use; management does not start service');

 startedService=true;
 const project=await json('project-create',['project','create','--name','1.0.8 包内隔离检查',...flags]);
 const projectId=project.data.project.id,first=identity();
 const parallel=await Promise.all([json('parallel-project-list-1',['project','list',...flags]),json('parallel-project-list-2',['project','list',...flags]),json('parallel-project-inspect',['project','inspect','--project',projectId,...flags])]);
 assert.ok(parallel.every(v=>v.ok));assert.deepEqual(projectIdentity(identity()),projectIdentity(first));
 const ps=join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const listeners=JSON.parse(await command('tcp-listeners',ps,['-NoProfile','-NonInteractive','-Command',`@(Get-NetTCPConnection -State Listen -OwningProcess ${first.pid} -ErrorAction Stop | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress`]));
 const ports=Array.isArray(listeners)?listeners:[listeners];assert.deepEqual(ports,[Number(new URL(first.url).port)]);
 const config=await http('api-config','/api/config');assert.equal(config.status,200);assert.equal(config.body.sfs.production_api_version,'1.3');
 assert.equal((await json('service-status-running',['service','status',...flags])).data.pid,first.pid);
 const unauth=await fetch(first.url+'/api/v1/projects');assert.equal(unauth.status,401);save('authentication',{unauthorized_status:unauth.status});
 checks.push('concurrent packaged CLI clients reuse one authenticated API 1.3 listener');

 const action=await json('action-create',['action','create','--project',projectId,'--name','isolated-png','--fps','12',...flags]);
 const context={project_id:projectId,axis_id:action.data.axis.id},query=new URLSearchParams(context);
 const draft=await http('draft-empty','/api/v1/collaboration/draft?'+query);assert.equal(draft.status,200);
 const images=join(evidence,'input-png');mkdirSync(images);
 await command('png-fixture',python,['-c',"from PIL import Image,ImageDraw; import pathlib,sys\np=pathlib.Path(sys.argv[1])\nfor n in range(3):\n i=Image.new('RGBA',(64,64),(0,0,0,0)); d=ImageDraw.Draw(i); d.rectangle((22+n,10,39+n,50),fill=(230,70,120,255)); i.save(p/('frame_%03d.png'%n))",images]);
 const timing={value:{mode:'confirmed_fps',fps:{num:12,den:1}},origin:'user'};
 const options=join(evidence,'import-options.json');writeFileSync(options,JSON.stringify({request_key:'release-import',timing,base_content:draft.body.data.token}));
 const imported=await json('import-collaboration-images',['import','images','--project',projectId,'--axis',context.axis_id,'--directory',images,'--file',options,...flags]);
 const taskFile=join(evidence,'task-input.json');
 const brief={context,source_id:imported.data.source_id,goal:{value:'使用这三张合成 PNG 验证便携包协作制作，不代表真实素材批准。',origin:'user'},alignment:{value:{canvas:{width:96,height:96},anchor:[48,80],scale:1,resampling:'pixel',mode:'fixed',roots:[{index:0,x:32,y:50}],offsets:{}},origin:'inferred'},timing,loop:{value:true,origin:'user'},sampling_limit:3,output:{value:{max_texture:512,gap:1,margin:1,formats:['png_sequence','spritesheet','contact_sheet','zip']},origin:'inferred'}};
 writeFileSync(taskFile,JSON.stringify({request_key:'release-task',brief}));
 const task=await json('task-create',['task','create','--file',taskFile,...flags]);
 const replay=await json('task-create-replay',['task','create','--file',taskFile,...flags]);assert.equal(replay.data.id,task.data.id);
 const inspected=await json('task-inspect',['task','inspect','--task',task.data.id,...flags]);
 assert.equal(inspected.data.brief.goal.value,brief.goal.value);assert.equal(inspected.data.brief.source_identity.frames.length,3);
 const currentDraft=await http('draft-imported','/api/v1/collaboration/draft?'+query);assert.equal(currentDraft.body.data.frames.length,3);
 const candidate=await json('candidate-create',['candidate','create','--project',projectId,'--axis',context.axis_id,'--task',task.data.id,'--base-content',JSON.stringify(currentDraft.body.data.token),'--request-key','release-candidate','--wait','--timeout','120',...flags]);
 const candidateId=candidate.data.result.candidate_id;
 const candidateInfo=await json('candidate-inspect',['candidate','inspect','--candidate',candidateId,...flags]);assert.equal(candidateInfo.data.manifest.frames.length,3);
 await json('candidate-check',['candidate','check','--candidate',candidateId,...flags]);
 const samples=await json('candidate-samples',['candidate','samples','--candidate',candidateId,...flags]);assert.ok(samples.data.samples.length<=3);
 const reviewBody={context:{task_id:task.data.id,candidate_id:candidateId,base_review_revision:0,request_key:'never-approved-by-smoke'},patch:{frame_id:candidateInfo.data.manifest.frames[0].frame_id,verdict:'pending'}};
 const denied=await http('maker-review-denied',`/api/v1/collaboration/candidates/${candidateId}/reviews/frame`,reviewBody);assert.equal(denied.status,403);assert.equal(denied.body.error.code,'ROLE_FORBIDDEN');
 assert.equal((await http('retired-review-alias','/api/v1/collaboration/reviews/frame',reviewBody)).status,404);
 checks.push('packaged PNG task creation replay, frozen source identity, candidate/Pillow check and bounded samples; maker review denied; retired alias absent');

 const require=createRequire(import.meta.url),helper=require(join(packageRoot,'resources/app/review-bootstrap.cjs'));
 await assert.rejects(helper.obtainDesktopReviewSession(workspace,{...first,instance_id:'wrong'}),/DESKTOP_SERVICE_IDENTITY/);
 const reviewer=await helper.obtainDesktopReviewSession(workspace,first);secrets.push(reviewer.reviewer_cookie);
 assert.equal(reviewer.instance_id,first.instance_id);
 const reviewState=await http('reviewer-read',`/api/v1/collaboration/candidates/${candidateId}/review-state`,undefined,reviewer.reviewer_cookie);assert.equal(reviewState.status,200);assert.equal(reviewState.body.data.accepted,false);
 // private 候选不能写审核；ROLE_FORBIDDEN 以外的明确领域拒绝证明 Cookie 已通过身份边界。
 const privateWrite=await http('reviewer-private-write-rejected',`/api/v1/collaboration/candidates/${candidateId}/reviews/frame`,reviewBody,reviewer.reviewer_cookie);
 assert.equal(privateWrite.status,409);assert.notEqual(privateWrite.body.error.code,'ROLE_FORBIDDEN');
 const fakeWorkspace=join(evidence,'version-conflict');mkdirSync(join(fakeWorkspace,'.sfs'),{recursive:true});
 const fakeInstance=randomUUID(),fakeToken='a'.repeat(64);
 const fake=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){return Response.json(new URL(request.url).pathname==='/api/health'?{pid:process.pid,instance_id:fakeInstance}:{sfs:{production_api_version:'1.2'}});}});
 try{writeFileSync(join(fakeWorkspace,'.sfs/service.json'),JSON.stringify({url:fake.url.origin,pid:process.pid,instance_id:fakeInstance,token:fakeToken,workspace:fakeWorkspace}));await assert.rejects(helper.obtainDesktopReviewSession(fakeWorkspace),/BACKEND_VERSION_CONFLICT/);const conflict=await json('cli-backend-version-conflict',['project','list','--workspace',fakeWorkspace],6);assert.equal(conflict.error.code,'BACKEND_VERSION_CONFLICT');}finally{await fake.stop(true);}
 save('desktop-helper',{packaged_helper:true,correct_instance:true,wrong_instance_rejected:true,backend_version_conflict_rejected:true,cli_backend_version_conflict_rejected:true,reviewer_read_status:200,private_review_write_status:privateWrite.status,synthetic_only:true,artistic_acceptance:false});
 checks.push('packaged desktop helper live instance and API 1.3 handshake; reviewer cookie recognized; mismatched backend version rejected');

 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'release-108-isolated-smoke',version:'1.0'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'inspect_capabilities',arguments:{}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'inspect_task',arguments:{task_id:task.data.id}}}];
 const mcpOut=await command('packaged-mcp',cli,['mcp','--stdio',...flags],0,messages.map(m=>JSON.stringify(m)).join('\n')+'\n');
 const replies=mcpOut.trim().split(/\r?\n/).map(line=>JSON.parse(line));
 const tools=replies.find(r=>r.id===2)?.result.tools.map((t:any)=>t.name).sort();
 const content=(id:number)=>JSON.parse(replies.find(r=>r.id===id).result.content[0].text);
 const capabilities=content(3);assert.equal(capabilities.production_api_version,'1.3');assert.equal(capabilities.review_authority,'desktop reviewer only');assert.deepEqual(tools,[...capabilities.tools].sort());
 const expectedTools=['cancel_job','cancel_operation','cancel_task','check_candidate','compare_candidates','create_action','create_candidate','create_project','create_task','edit_mask','export_assets','extract_source','get_candidate_samples','get_frame_artifacts','get_job','get_review_artifacts','import_images','import_source','inspect_action_collaboration','inspect_candidate','inspect_capabilities','inspect_operation','inspect_project','inspect_task','list_frames','list_review_issues','record_issue_repair','record_sample_observations','resume_operation','save_alignment','set_output_timing','start_rework','submit_candidate','submit_pipeline','undo_mask'];
 assert.deepEqual(tools,expectedTools,'1.0.8/API 1.3 的明确制作工具白名单');
 for(const name of ['create_task','create_candidate','inspect_task','cancel_task','resume_operation'])assert.ok(tools.includes(name));
 for(const name of ['apply_frame_review','apply_playback_review','apply_whole_candidate_review','accept_source_defect','select_candidate','issue_reviewer_session'])assert.ok(!tools.includes(name));
 assert.equal(content(4).task.id,task.data.id);save('mcp-whitelist',{tools,production_api_version:capabilities.production_api_version,review_authority:capabilities.review_authority});
 checks.push('packaged MCP maker whitelist equals runtime capabilities, includes collaboration, excludes human approval');

 if(modelFlag>=0){
  const model=resolve(process.argv[modelFlag+1]??''),sha=createHash('sha256').update(readFileSync(model)).digest('hex');assert.equal(sha,'309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8');
  const models=join(user,'SpriteMotionStudio/models');mkdirSync(models,{recursive:true});copyFileSync(model,join(models,'u2netp.onnx'));
  const doctor=await json('optional-model-doctor',['doctor',...flags]);assert.equal(doctor.data.capabilities.matting,true);
  const matteProject=await json('optional-model-project',['project','create','--name','明确本地模型初稿',...flags]);
  const complexImages=join(evidence,'rgb');mkdirSync(complexImages);
  await command('optional-model-fixture',python,['-c',"from PIL import Image,ImageDraw; import pathlib,sys\np=pathlib.Path(sys.argv[1])\nfor n in range(3):\n i=Image.new('RGB',(128,128),(140,190,160)); d=ImageDraw.Draw(i); d.rectangle((0,100,127,127),fill=(90,110,130)); d.ellipse((44+n,20,84+n,62),fill=(245,80,160)); d.rectangle((43+n,59,86+n,95),fill=(60,200,245)); d.line((106,12,106,105),fill=(240,230,80),width=2); i.save(p/('frame_%03d.png'%n))",complexImages]);
  const matteImport=await json('optional-model-import',['import','images','--project',matteProject.data.project.id,'--directory',complexImages,...flags]);
  const recipe=join(evidence,'optional-model-recipe.json');writeFileSync(recipe,JSON.stringify({schema_version:'1.0',matting:{backend:'rembg',model:'u2netp'},output:{draft:true}}));
  const matte=await json('optional-model-matting',['pipeline','run','--project',matteProject.data.project.id,'--axis',matteImport.data.axis_id,'--recipe',recipe,'--wait','--timeout','120',...flags],4);assert.equal(matte.status,'waiting_user');assert.equal(matte.data.job.result.frame_count,3);assert.equal(matte.data.job.result.session_count,1);
  save('optional-model',{sha256:sha,explicit_local_copy:true,downloaded:false,bundled:false,frame_count:3,session_count:1,status:matte.status,artistic_acceptance:false});checks.push('explicit local optional CPU model with one real inference session produced three unreviewed RGB draft frames offline');
 }

 const finalTask=await json('task-before-cancel',['task','inspect','--task',task.data.id,...flags]);
 await json('task-cancel',['task','cancel','--task',task.data.id,'--expected-acceptance-epoch',String(finalTask.data.task.acceptance_epoch),'--request-key','release-cancel',...flags]);
 assert.equal((await json('task-after-cancel',['task','inspect','--task',task.data.id,...flags])).data.task.state,'cancelled');
 assert.deepEqual(projectIdentity(identity()),projectIdentity(first));
 await json('service-stop',['service','stop',...flags]);stopped=true;
 assert.equal((await json('service-status-after',['service','status',...flags])).data.status,'stopped');
 assert.equal((await json('other-workspace-status',['service','status','--workspace',otherWorkspace])).data.status,'stopped');
 checks.push('task cancellation and authenticated service stop preserve one service; other registered workspace remains stopped');
 completed=true;
}finally{
 if(startedService&&!stopped){try{await json('cleanup-service-stop',['service','stop',...flags]);stopped=true;}catch(error){save('cleanup-error',{message:redact(String(error)),forced_kill:false});}}
 save('summary',{ok:completed&&stopped,package_root:packageRoot,workspace,evidence,checks,authenticated_stop:stopped,clean_vm:false,scope:'relocated packaged executables on current Windows with restricted PATH',artistic_acceptance:false});
}
console.log(JSON.stringify({ok:completed&&stopped,evidence,checks:checks.length,artistic_acceptance:false}));
