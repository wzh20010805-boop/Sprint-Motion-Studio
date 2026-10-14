import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {reviewSetup} from '../tests/pipeline/reviewFixture';
import {runCollaborationScript} from '../tests/pipeline/collaborationFixtures';
const root=resolve(import.meta.dir,'..'),regionOnly=process.argv.includes('--region-only');
const buildDir=join(process.env.SFS_WORKSPACE!,'review-bundle');mkdirSync(buildDir,{recursive:true});
const build=await Bun.build({entrypoints:[join(root,'probes/desktop/candidate-review-fixture.tsx')],target:'browser',outdir:buildDir});
if(!build.success)throw Error(build.logs.join('\n'));
if(process.argv.includes('--build-only')){console.log(JSON.stringify({build:true,output:build.outputs[0]!.path}));process.exit(0);}
const result=await runCollaborationScript(reviewSetup+String.raw`
const repo=process.cwd(),runtime=join(repo,'probes/desktop/node_modules/electron/dist');
const {request}=await seedCandidate(FRAME_COUNT);const parent=await c.buildPrivateCandidate(request());await submit(parent);
d.startRework(parent.task_id,parent.id,d.readDraftContent(context).token,{request_key:uid()},actor);
const first=c.readCandidateManifest(parent.id).frames[0];db.query('UPDATE frames SET offset_x=3,rotation=0.1,scale=-0.8,opacity=0.75 WHERE id=?').run(first.frame_id);
const candidate=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await submit(candidate);const manifest=c.readCandidateManifest(candidate.id);
const {Elysia}=await import('./apps/server/node_modules/elysia');const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const {LocalAuthError}=auth;
const app=new Elysia().onRequest(({request})=>{try{auth.authenticateLocalRequest(request,new URL(request.url).host);}catch(e){return Response.json({ok:false,error:{code:e.code,message:e.message}},{status:e.status});}}).use(collaborationApi);
const credential=auth.issueReviewerSession('synthetic-test-only');
// 合成审核基线只用于测试最终闸门；GUI导航覆盖与人工美术验收是不同证据。
for(const f of manifest.frames.slice(0,-1))r.applyFrameReview(rc(candidate.id),{frame_id:f.frame_id,verdict:'approved'},human);
writeFileSync(join(STORAGE_ROOT,'synthetic-review-baseline.json'),JSON.stringify({preapproved_frames:manifest.frames.length-1,preapproved_frame_ids:manifest.frames.slice(0,-1).map(f=>f.frame_id),gui_approvals:0,artistic_acceptance:false},null,2));
const expectedFiles=Object.fromEntries(manifest.frames.map(f=>[f.frame_id,{png_sha256:f.png_sha256,duration:f.duration,grid_cell:f.grid_cell}]));
for(const f of manifest.frames)assert.equal(fileHash(c.candidateFilePath(candidate.id,f.files.png)),f.png_sha256);
writeFileSync(join(STORAGE_ROOT,'all-file-evidence.json'),JSON.stringify({candidate:candidate.id,frames:expectedFiles,note:'All fixture fixed PNG byte hashes and frozen rational/grid inventory; separate from bounded Canvas RGBA proof'},null,2));
let reviews=0;const requests=[];
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const url=new URL(req.url);
 if(url.pathname==='/')return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',{headers:{'Content-Type':'text/html'}});
 if(url.pathname==='/fixture.js')return new Response(Bun.file(BUNDLE));
 if(url.pathname==='/styles.css'||url.pathname==='/candy.css')return new Response(Bun.file(join(repo,'apps/web/src',url.pathname.slice(1))));
 if(url.pathname.startsWith('/fonts/'))return new Response(Bun.file(join(repo,'apps/web/public',url.pathname.slice(1))));
 if(url.pathname==='/api/settings/theme'||url.pathname==='/api/settings/lang')return Response.json({ok:true});
 if(url.pathname==='/fixture/identity')return Response.json({taskId:candidate.task_id,candidateId:candidate.id,parentId:parent.id,manifest});
 if(url.pathname==='/fixture/evidence')return Response.json({reviews,requests,state:r.readReviewState(candidate.id)});
 if(url.pathname==='/fixture/conflict'&&req.method==='POST'){r.applyFrameReview(rc(candidate.id),{frame_id:manifest.frames[1].frame_id,verdict:'pending'},human);return Response.json({ok:true});}
 if(url.pathname.startsWith('/api/v1/collaboration')){const entry={path:url.pathname,method:req.method,body:req.method==='POST'?await req.clone().json():null,status:null};requests.push(entry);if(req.method==='POST'&&url.pathname.includes('/reviews/'))reviews++;const response=await app.handle(req);entry.status=response.status;return response;}
 return new Response('Fixture route missing',{status:404});
}});
let child=null,exit=null;let stdout='',stderr='';
try{
 child=Bun.spawn([join(runtime,'electron.exe'),join(repo,REGION_CHECK)],{cwd:repo,windowsHide:true,stdout:'pipe',stderr:'pipe',env:{...process.env,SFS_REVIEW_URL:server.url.toString(),SFS_REVIEW_OUTPUT:STORAGE_ROOT,SFS_REVIEW_COOKIE:credential}});
 [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 writeFileSync(join(STORAGE_ROOT,'electron.stdout.log'),stdout);writeFileSync(join(STORAGE_ROOT,'electron.stderr.log'),stderr);
 assert.equal(exit,0,stderr);assert.equal(stderr.includes('FATAL'),false);
 const report=JSON.parse(readFileSync(join(STORAGE_ROOT,'report.json'),'utf8'));assert.equal(report.passed,true,JSON.stringify(report.failures));
 for(const f of manifest.frames)assert.equal(fileHash(c.candidateFilePath(candidate.id,f.files.png)),f.png_sha256);
 writeFileSync(join(STORAGE_ROOT,'api-final-evidence.json'),JSON.stringify({note:'Synthetic fixture reviewer only; not artistic acceptance',requests,state:r.readReviewState(candidate.id),same_fixed_hashes:true},null,2));
}finally{
 if(child&&exit===null){child.kill();exit=await child.exited;}
 await server.stop(true);await (await import('./apps/server/src/queue')).waitForQueueIdle();writeFileSync(join(STORAGE_ROOT,'api-final-evidence.json'),JSON.stringify({requests,state:r.readReviewState(candidate.id),synthetic_reviewer:true,artistic_acceptance:false},null,2));db.close();writeFileSync(join(STORAGE_ROOT,'fixture-lifecycle.json'),JSON.stringify({electron_pid:child?.pid??null,electron_exit:exit,electron_awaited:true,listener_stop_awaited:true,queue_idle_awaited:true,pending_requests:server.pendingRequests,db_closed:true,completed:exit===0},null,2));
}
`.replace('BUNDLE',JSON.stringify(build.outputs[0]!.path)).replace('FRAME_COUNT',regionOnly?'4':'300').replace('REGION_CHECK',JSON.stringify(regionOnly?'probes/desktop/candidate-region-check.cjs':'probes/desktop/candidate-review-check.cjs')),'t11');
writeFileSync(join(buildDir,'fixture-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));process.exitCode=result.exit_code;
