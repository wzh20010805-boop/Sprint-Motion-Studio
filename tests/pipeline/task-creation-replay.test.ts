import {test,expect} from 'bun:test';
import {candidateSetup} from './candidateFixture';
import {runCollaborationScript} from './collaborationFixtures';
const setup=candidateSetup+String.raw`
const seeded=await seedCandidate(2);
const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('creation-replay','maker');
const current=()=>auth.authenticateLocalRequest(new Request('http://localhost/test',{headers:{Authorization:'Bearer maker'}}),'localhost');
let maker=current();const {createTaskFromInput}=await import('./apps/server/src/pipeline/collaboration/creation');
const {runMakerTool}=await import('./apps/server/src/mcp/makerTools');const {saveAlignment}=await import('./apps/server/src/pipeline/alignment');
const {draftKey}=await import('./apps/server/src/pipeline/collaboration/timing');const ops=await import('./apps/server/src/pipeline/collaboration/operations');
const input={brief:{context,source_id:seeded.imp.source_id,goal:{value:'Keep the complete supplied action',origin:'user'}},request_key:uid()};
const originalRow=id=>db.query('SELECT * FROM collab_operations WHERE id=?').get(id);
const briefRow=id=>db.query('SELECT * FROM task_briefs WHERE task_id=?').get(id);
const counts=()=>db.query('SELECT (SELECT COUNT(*) FROM collab_tasks) tasks,(SELECT COUNT(*) FROM collab_operations) operations,(SELECT COUNT(*) FROM jobs) jobs').get();
`;
const run=async(script:string)=>{const x=await runCollaborationScript(setup+script,'t10');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);};

test('same minimal creation reuses original defaults after alignment, timing and config removal without resetting edits',()=>run(String.raw`
 const first=await runMakerTool('create_task',input,maker),opId=first.operation_ids[0],originalOp=originalRow(opId),originalBrief=briefRow(first.id);assert.equal((await runMakerTool('create_task',input,maker)).id,first.id);
 saveAlignment(project.id,axis.id,{...config,anchor:[47,80]},getProject(project.id).revision);const aligned=d.readDraftContent(context),afterAlignment=counts();assert.equal((await runMakerTool('create_task',input,maker)).id,first.id);assert.deepEqual(d.readDraftContent(context),aligned);assert.deepEqual(counts(),afterAlignment);
 d.setOutputTiming(context,{value:{mode:'confirmed_fps',fps:{num:24,den:1}},origin:'user'},d.readDraftContent(context).token,{request_key:uid()});const retimed=d.readDraftContent(context),afterTiming=counts();assert.equal(createTaskFromInput(input.brief,input.request_key,maker).id,first.id);assert.deepEqual(d.readDraftContent(context),retimed);assert.deepEqual(counts(),afterTiming);
 // Removal models unavailable current configuration; a committed replay needs neither it nor draft timing.
 db.query('DELETE FROM settings WHERE key IN (?,?,?)').run('sfs.alignment.'+project.id+'.'+axis.id,'sfs.preset.'+project.id,draftKey(context));const removedSettings=db.query('SELECT * FROM settings ORDER BY key').all(),removedProject=getProject(project.id),afterRemoval=counts();assert.equal(createTaskFromInput(input.brief,input.request_key,maker).id,first.id);assert.deepEqual(db.query('SELECT * FROM settings ORDER BY key').all(),removedSettings);assert.deepEqual(getProject(project.id),removedProject);assert.deepEqual(counts(),afterRemoval);
 for(const patch of [{goal:{value:'A changed explicit goal',origin:'user'}},{source_id:'different-source'},{alignment:{value:config,origin:'user'}},{timing},{source_identity:{kind:'png_sequence',original_sha256:'b'.repeat(64),frames:[]}}])assert.throws(()=>createTaskFromInput({...input.brief,...patch},input.request_key,maker),e=>e.code==='REQUEST_CONFLICT');
 assert.deepEqual(originalRow(opId),originalOp);assert.deepEqual(briefRow(first.id),originalBrief);assert.equal(ops.readOperation(opId).attempt_job_ids.length,0);
 // Original byte identity is checked even when public input matched and no current draft is available.
 const source=getSource(project.id,seeded.imp.source_id),sourceBytes=readFileSync(source.original_path);writeFileSync(source.original_path,'changed');assert.throws(()=>createTaskFromInput(input.brief,input.request_key,maker),e=>e.code==='SOURCE_IDENTITY_CONFLICT');writeFileSync(source.original_path,sourceBytes);
 const png=source.probe.frames[0],pngBytes=readFileSync(png.canonical_path);writeFileSync(png.canonical_path,'changed');assert.throws(()=>createTaskFromInput(input.brief,input.request_key,maker),e=>e.code==='SOURCE_IDENTITY_CONFLICT');writeFileSync(png.canonical_path,pngBytes);assert.equal(createTaskFromInput(input.brief,input.request_key,maker).id,first.id);
 writeFileSync(join(STORAGE_ROOT,'creation-replay-evidence.json'),JSON.stringify({input,task_id:first.id,operation_id:opId,originalBrief,originalOp,afterAlignment,afterTiming,afterRemoval,source_verified:true},null,2));
`),30000);

test('needs_input consumes no key; answer bundle first commits once and completed replay ignores later defaults',()=>run(String.raw`
 const incomplete={context,source_id:seeded.imp.source_id},key=uid(),before=counts(),missing=createTaskFromInput(incomplete,key,maker);assert.equal(missing.status,'needs_input');assert.deepEqual(missing.resume,{brief:incomplete,request_key:key});assert.deepEqual(counts(),before);assert.equal(db.query('SELECT id FROM collab_operations WHERE request_key=?').get(key),null);
 const answer={...missing.resume.brief,goal:input.brief.goal},first=createTaskFromInput(answer,key,maker),original=briefRow(first.id);saveAlignment(project.id,axis.id,{...config,anchor:[46,80]},getProject(project.id).revision);assert.equal(createTaskFromInput(answer,key,maker).id,first.id);assert.deepEqual(briefRow(first.id),original);
 assert.throws(()=>createTaskFromInput({...answer,goal:{value:'Changed after first success',origin:'user'}},key,maker),e=>e.code==='REQUEST_CONFLICT');assert.throws(()=>createTaskFromInput(incomplete,key,maker),e=>e.code==='REQUEST_CONFLICT');
`),30000);

test('current server actor is required before creation replay or missing-input discovery',()=>run(String.raw`
 const first=createTaskFromInput(input.brief,input.request_key,maker),before=counts();for(const fake of [{...maker},{role:'maker',session_id:'invented'}])assert.throws(()=>createTaskFromInput(input.brief,input.request_key,fake),e=>e.code==='ROLE_FORBIDDEN');
 auth.initializeLocalSessions('replacement','maker');assert.throws(()=>createTaskFromInput(input.brief,input.request_key,maker),e=>e.code==='ROLE_FORBIDDEN');assert.throws(()=>createTaskFromInput({context,source_id:seeded.imp.source_id},uid(),maker),e=>e.code==='ROLE_FORBIDDEN');maker=current();assert.equal(createTaskFromInput(input.brief,input.request_key,maker).id,first.id);assert.deepEqual(counts(),before);
`),30000);

test('binding rolls back on failed first creation and never invents historical supplied input',()=>run(String.raw`
 const failedKey=uid(),before=counts(),settings=db.query('SELECT * FROM settings ORDER BY key').all();assert.throws(()=>createTaskFromInput({...input.brief,sampling_limit:13},failedKey,maker),e=>e.code==='INVALID_TASK_BRIEF');assert.deepEqual(counts(),before);assert.deepEqual(db.query('SELECT * FROM settings ORDER BY key').all(),settings);assert.equal(db.query('SELECT id FROM collab_operations WHERE request_key=?').get(failedKey),null);
 const first=createTaskFromInput(input.brief,failedKey,maker);assert.ok(first.id);const otherKey=uid();ops.claimOperation('different_operation',{request_key:otherKey},{});assert.throws(()=>createTaskFromInput(input.brief,otherKey,maker),e=>e.code==='REQUEST_CONFLICT');
 const historicalId=seeded.task.operation_ids[0],historical=originalRow(historicalId);assert.equal(historical.checkpoint_json,null);assert.equal(createTaskFromInput(seeded.brief,historical.request_key,maker).id,seeded.task.id);assert.deepEqual(originalRow(historicalId),historical);
`),30000);

test('HTTP tasks and maker route, real MCP and CLI share unchanged minimal replay after draft edits',()=>run(String.raw`
 const fixtureToken='a'.repeat(64),bootId='creation-replay-cli-'+uid();auth.initializeLocalSessions(bootId,fixtureToken);maker=auth.authenticateLocalRequest(new Request('http://localhost/test',{headers:{Authorization:'Bearer '+fixtureToken}}),'localhost');
 const first=await runMakerTool('create_task',input,maker);saveAlignment(project.id,axis.id,{...config,anchor:[45,80]},getProject(project.id).revision);const edited=d.readDraftContent(context),before=counts();
 const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi'),{sfsMcpHandler}=await import('./apps/server/src/mcp/sfs');let phase='http';const cliRequests=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){const u=new URL(req.url);if(phase==='cli')cliRequests.push({path:u.pathname,host:u.host,method:req.method,boot_id:bootId,pid:process.pid});if(u.pathname==='/api/health')return Response.json({instance_id:bootId,pid:process.pid});auth.authenticateLocalRequest(req,u.host);if(u.pathname==='/api/config')return Response.json({sfs:{production_api_version:'1.2'}});return u.pathname==='/mcp'?sfsMcpHandler.fetch(req):collaborationApi.handle(req);}});
 let cliPid=null,cliExit=null,completed=false;
 try{for(const route of ['/api/v1/collaboration/tasks','/api/v1/collaboration/maker/create_task']){const response=await fetch(server.url.origin+route,{method:'POST',headers:{Authorization:'Bearer '+fixtureToken,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,200);assert.equal((await response.json()).data.id,first.id);}
 const mcp=await fetch(server.url.origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+fixtureToken,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_task',arguments:input}})});assert.equal(mcp.status,200);const text=await mcp.text(),response=text.startsWith('event:')||text.startsWith('data:')?JSON.parse(text.split('\n').find(l=>l.startsWith('data:')).slice(5)):JSON.parse(text);assert.equal(JSON.parse(response.result.content[0].text).id,first.id);
 const {mkdirSync,existsSync}=await import('node:fs');mkdirSync(join(STORAGE_ROOT,'.sfs'),{recursive:true});const descriptorPath=join(STORAGE_ROOT,'.sfs/service.json'),descriptor={schema_version:'1.0',instance_id:bootId,pid:process.pid,workspace:STORAGE_ROOT,url:server.url.origin,token:fixtureToken},descriptorBytes=JSON.stringify(descriptor);writeFileSync(descriptorPath,descriptorBytes);
 const {readService}=await import('./apps/cli/src/client');assert.deepEqual(readService(STORAGE_ROOT),descriptor,'CLI must accept the owned listener descriptor before it can spawn a different runtime');
 const file=join(STORAGE_ROOT,'input.json');writeFileSync(file,JSON.stringify(input));phase='cli';const cli=Bun.spawn([process.execPath,'apps/cli/src/index.ts','task','create','--file',file,'--workspace',STORAGE_ROOT],{windowsHide:true,stdout:'pipe',stderr:'pipe'});cliPid=cli.pid;
 const [code,out,err]=await Promise.all([cli.exited,new Response(cli.stdout).text(),new Response(cli.stderr).text()]);cliExit=code;phase='completed';assert.equal(code,0,err+' '+out);assert.equal(JSON.parse(out).data.id,first.id);
 assert.equal(cliRequests.filter(r=>r.path==='/api/health').length,1);assert.equal(cliRequests.filter(r=>r.path==='/api/config').length,1);assert.equal(cliRequests.filter(r=>r.path==='/api/v1/collaboration/maker/create_task').length,1);assert.equal(cliRequests.length,3);assert.ok(cliRequests.every(r=>r.host===new URL(descriptor.url).host&&r.boot_id===bootId&&r.pid===descriptor.pid));
 assert.equal(readFileSync(descriptorPath,'utf8'),descriptorBytes);assert.deepEqual(readService(STORAGE_ROOT),descriptor);for(const name of ['service.log','service.lock','desktop-bootstrap.json'])assert.equal(existsSync(join(STORAGE_ROOT,'.sfs',name)),false,'Unexpected main-runtime artifact '+name);
 assert.deepEqual(d.readDraftContent(context),edited);assert.deepEqual(counts(),before);completed=true;writeFileSync(join(STORAGE_ROOT,'adapter-replay-evidence.json'),JSON.stringify({task_id:first.id,code,out,err,mcp:text,descriptor,descriptor_unchanged:true,cli_requests:cliRequests,no_main_runtime_artifacts:true},null,2));
 }finally{await server.stop();assert.equal(server.pendingRequests,0);db.close();writeFileSync(join(STORAGE_ROOT,'fixture-lifecycle.json'),JSON.stringify({owned_listener_pid:process.pid,boot_id:bootId,cli_pid:cliPid,cli_exit:cliExit,cli_awaited:cliPid===null||cliExit!==null,listener_stop_awaited:true,pending_requests:server.pendingRequests,db_closed:true,completed},null,2));}
`),30000);
