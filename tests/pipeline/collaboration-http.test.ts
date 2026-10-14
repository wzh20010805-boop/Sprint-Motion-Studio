import {test,expect} from 'bun:test';
import {reviewSetup} from './reviewFixture';
import {candidateSetup} from './candidateFixture';
import {runCollaborationScript} from './collaborationFixtures';
test('scoped HTTP review routes retain role, CAS, repair and source exception semantics',async()=>{
const x=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(2),p=await c.buildPrivateCandidate(request());await submit(p);const q=await import('./apps/server/src/queue');q.pauseQueue();const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const secret=auth.issueReviewerSession('synthetic-test-only');
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){try{auth.authenticateLocalRequest(req,new URL(req.url).host);return collaborationApi.handle(req);}catch(e){return Response.json({error:e.code},{status:403});}}});
 const post=async(path,body,role='reviewer')=>{const response=await fetch(server.url.origin+'/api/v1/collaboration'+path,{method:'POST',headers:{'Content-Type':'application/json',...(role==='reviewer'?{Cookie:'sfs_reviewer='+secret}:{Authorization:'Bearer test-maker'})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 try{const ids=c.readCandidateManifest(p.id).frames.map(f=>f.frame_id),frameBody={context:rc(p.id),patch:{frame_id:ids[0],verdict:'approved'}};
 const oldOperations=db.query('SELECT COUNT(*) n FROM collab_operations').get().n,oldReviewRevision=c.readCandidate(p.id).review_revision;
 for(const path of ['/reviews/frame','/reviews/playback','/reviews/issue','/reviews/repair','/reviews/source-exception','/reviews/inheritance','/reviews/selection']){
  const response=await post(path,path==='/reviews/inheritance'?{context:rc(p.id),parent_candidate_id:p.id}:frameBody);
  assert.equal(response.status,404,'retired unscoped review route '+path);
 }
 assert.equal((await fetch(server.url.origin+'/api/v1/collaboration/candidates/'+p.id+'/reviews',{headers:{Cookie:'sfs_reviewer='+secret}})).status,404);
 assert.equal(db.query('SELECT COUNT(*) n FROM collab_operations').get().n,oldOperations);assert.equal(c.readCandidate(p.id).review_revision,oldReviewRevision);
 assert.equal((await post('/candidates/'+p.id+'/reviews/frame',frameBody,'maker')).status,403);assert.equal((await post('/candidates/'+p.id+'/reviews/frame',frameBody)).status,200);
 assert.equal((await post('/candidates/'+p.id+'/reviews/frame',{...frameBody,context:{...frameBody.context,request_key:uid()}})).status,409);
 assert.equal((await post('/candidates/wrong/reviews/frame',{context:rc(p.id),patch:frameBody.patch})).status,409);
 assert.equal((await post('/candidates/'+p.id+'/reviews/frame',{context:rc(p.id),patch:{frame_id:ids[1],verdict:'approved'}})).status,200);
 assert.equal((await post('/candidates/'+p.id+'/reviews/playback',{context:rc(p.id),patch:{playback_hash:c.readCandidateManifest(p.id).playback_hash,confirmed:true}})).body.data.accepted,true);
 const issuePatch={frame_ids:[ids[0]],rect:null,coordinate_system:'final_canvas_pixels',text:'synthetic fixture source issue',severity:'blocking'};assert.equal((await post('/candidates/'+p.id+'/issues',{context:rc(p.id),patch:issuePatch})).status,200);const issue=r.readReviewState(p.id).issues[0];
 const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:p.id});await submit(child);
 assert.equal((await post('/issues/'+issue.id+'/repair',{context:rc(p.id),patch:{issue_id:issue.id,repair_candidate_id:child.id,frame_ids:[ids[0]],note:'synthetic association'}},'maker')).status,200);
 assert.equal((await post('/candidates/'+child.id+'/reviews/inherit',{context:rc(child.id),parent_candidate_id:p.id})).status,200);
 const task=readTaskRecord(p.task_id),selectionBody={task_id:p.task_id,candidate_id:p.id,expected_selected_candidate_id:task.selected_candidate_id,expected_acceptance_epoch:task.acceptance_epoch,request_key:uid()};assert.equal((await post('/tasks/'+p.task_id+'/selection',selectionBody)).status,200);assert.equal((await post('/tasks/'+p.task_id+'/selection',{...selectionBody,request_key:uid()})).status,409);
 const exception={context:rc(p.id),patch:{issue_id:issue.id,frame_ids:[ids[0]],reason:'synthetic explicit exception'}};assert.equal((await post('/issues/'+issue.id+'/accept-source-defect',exception,'maker')).status,403);assert.equal((await post('/issues/'+issue.id+'/accept-source-defect',exception)).status,200);
 const read=await fetch(server.url.origin+'/api/v1/collaboration/candidates/'+p.id+'/review-state',{headers:{Authorization:'Bearer test-maker'}});assert.equal(read.status,200);assert.equal((await read.json()).data.issues[0].status,'accepted_exception');
 }finally{server.stop(true);}
`,'t10');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},60000);

test('aggregate inline bytes and actual Bun request limit have distinct boundaries',async()=>{
const x=await runCollaborationScript(String.raw`
 import assert from 'node:assert/strict';const {decodeInline}=await import('./apps/server/src/mcp/makerTools');const {MULTIPART_BODY_BYTES}=await import('./apps/server/src/mcp/request');
 const b=Buffer.alloc(294912).toString('base64');assert.equal(decodeInline([{name:'a',bytes_base64:b},{name:'b',bytes_base64:b}]).reduce((n,f)=>n+f.bytes.length,0),589824);assert.throws(()=>decodeInline([{name:'a',bytes_base64:b},{name:'b',bytes_base64:b+'AAAA'}]),e=>e.code==='INLINE_LIMIT_EXCEEDED');assert.throws(()=>decodeInline([{name:'a',bytes_base64:'YWJ='}]),e=>e.code==='INVALID_INPUT');
 const server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:MULTIPART_BODY_BYTES,async fetch(req){return Response.json({bytes:(await req.arrayBuffer()).byteLength});}});
 try{const small=await fetch(server.url,{method:'POST',body:Buffer.alloc(1048577)});assert.equal(small.status,200);assert.equal((await small.json()).bytes,1048577);
 const chunk=new Uint8Array(65536);let sent=0;const body=new ReadableStream({pull(c){const size=Math.min(chunk.length,MULTIPART_BODY_BYTES+1-sent);if(size<=0){c.close();return;}c.enqueue(chunk.subarray(0,size));sent+=size;}});const large=await fetch(server.url,{method:'POST',body});assert.equal(large.status,413);console.log(JSON.stringify({inline:589824,http_limit:MULTIPART_BODY_BYTES,oversized_status:large.status}));}finally{server.stop(true);}
`,'t10');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},30000);
test('CLI collaboration mask and alignment commands forward explicit content and mask bases',async()=>{
const x=await runCollaborationScript(candidateSetup+String.raw`
 await seedCandidate(2);let forwardedRequests=0;const token='b'.repeat(64);const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('cli-bases',token);const {PRODUCTION_API_VERSION}=await import('./packages/shared/src/index');const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const u=new URL(req.url);if(u.pathname==='/api/health')return Response.json({instance_id:'cli-bases',pid:process.pid});auth.authenticateLocalRequest(req,u.host);if(u.pathname==='/api/config')return Response.json({sfs:{production_api_version:PRODUCTION_API_VERSION}});forwardedRequests++;return collaborationApi.handle(req);}});
 const {mkdirSync}=await import('node:fs');mkdirSync(join(STORAGE_ROOT,'.sfs'),{recursive:true});writeFileSync(join(STORAGE_ROOT,'.sfs/service.json'),JSON.stringify({schema_version:'1.0',instance_id:'cli-bases',pid:process.pid,workspace:STORAGE_ROOT,url:server.url.origin,token}));
 try{const {run}=await import('./apps/cli/src/index');const frame=d.readDraftContent(context).frames[0],state=maskState(frame.frame_id),strokes=join(STORAGE_ROOT,'strokes.json');writeFileSync(strokes,JSON.stringify([{mode:'erase',size:2,points:[[30,20]]}]));const args=['mask','edit','--project',project.id,'--axis',axis.id,'--frame',frame.frame_id,'--strokes',strokes,'--base-content',JSON.stringify(d.readDraftContent(context).token),'--base-revision',String(state.revision),'--workspace',STORAGE_ROOT];
 const stale=await run([...args,'--base-mask-version','wrong']);assert.equal(stale.exitCode,6);assert.equal(maskState(frame.frame_id).version_id,state.version_id);
 const good=await run([...args,'--base-mask-version',state.version_id]);assert.equal(good.exitCode,0,JSON.stringify(good.body));assert.notEqual(maskState(frame.frame_id).version_id,state.version_id);
 const configPath=join(STORAGE_ROOT,'alignment.json');writeFileSync(configPath,JSON.stringify(config));const aligned=await run(['align','--project',project.id,'--axis',axis.id,'--config',configPath,'--base-content',JSON.stringify(d.readDraftContent(context).token),'--base-revision',String(getProject(project.id).revision),'--workspace',STORAGE_ROOT]);assert.equal(aligned.exitCode,0,JSON.stringify(aligned.body));assert.deepEqual(d.readDraftContent(context).alignment,config);
 assert.equal(forwardedRequests,3,'CLI must reuse the authenticated fixture service');
 }finally{server.stop(true);const actual=JSON.parse(readFileSync(join(STORAGE_ROOT,'.sfs/service.json'),'utf8'));if(actual.pid!==process.pid&&actual.workspace===STORAGE_ROOT){try{process.kill(actual.pid);}catch{}}}
`,'t10');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},30000);
