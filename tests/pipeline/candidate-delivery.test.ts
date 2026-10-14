import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
const run=async(s:string)=>{const x=await runCollaborationScript(reviewSetup+'{'+s+'}','t8');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);};
test('accepted package copies exact fixed PNG/sheets and timing, honest QA and noncircular ZIP checksums',()=>run(String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery').catch(()=>({}));assert.equal(typeof mod.packageAcceptedCandidate,'function','immutable delivery service is required');
 timing.value={mode:'explicit_durations',durations:[{num:1001,den:30000},{num:1,den:7},{num:2,den:9},{num:11,den:60},{num:3,den:17}]};
 const soft=join(STORAGE_ROOT,'soft.png'),make=Bun.spawn([imagePython(),'-c',"from PIL import Image;import sys;i=Image.new('RGBA',(64,64),(130,70,90,128));i.save(sys.argv[1])",soft],{windowsHide:true});assert.equal(await make.exited,0);
 const {request}=await seedCandidate(5,readFileSync(soft),{ordered_names:['frame4.png','frame1.png','frame3.png','frame0.png','frame2.png']}),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const accepted=playback(candidate.id);
 const req={task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:accepted.acceptance_epoch,operation_id:accepted.pending_delivery_operation_id},m=c.readCandidateManifest(candidate.id);
 db.query('UPDATE frames SET opacity=0,offset_x=1000 WHERE project_id=?').run(project.id);
 const result=await mod.packageAcceptedCandidate(req);assert.equal(ops.readOperation(req.operation_id).state,'succeeded');assert.equal(result.approval_status,'approved');
 assert.deepEqual(m.frames.map(f=>f.duration),timing.value.durations);assert.equal(m.sheets.length,2);assert.deepEqual(m.grid.cell,[96,96]);
 assert.deepEqual(JSON.parse(readFileSync(join(result.directory,'candidate-manifest.json'),'utf8')),m);
 for(const f of [...m.frames.map(f=>({file:f.files.png,sha256:f.png_sha256})),...m.sheets])assert.equal(fileHash(join(result.directory,f.file)),f.sha256);
 const qa=JSON.parse(readFileSync(join(result.directory,'quality-report.json'),'utf8'));assert.equal(qa.technical_check.checked_frame_count,5);assert.equal(qa.self_check.viewed_frame_ids.length,0);assert.equal(qa.self_check.unviewed_frame_ids.length,1);assert.deepEqual(qa.self_check,sampling.requireCandidateSelfCheck(candidate.id));
 const checks=JSON.parse(readFileSync(join(result.directory,'checksums.json'),'utf8'));assert.equal(checks['assets.zip'],undefined);assert.equal(result.archive_sha256,fileHash(join(result.directory,'assets.zip')));
 const zip=Bun.spawn([imagePython(),'-c',"import sys,zipfile,json,hashlib;z=zipfile.ZipFile(sys.argv[1]);c=json.loads(z.read('checksums.json'));assert 'assets.zip' not in c;assert all(hashlib.sha256(z.read(k)).hexdigest()==v for k,v in c.items())",join(result.directory,'assets.zip')],{windowsHide:true});assert.equal(await zip.exited,0);
 assert.deepEqual(await mod.packageAcceptedCandidate(req),result);playback(candidate.id,false);const withdrawn=mod.readDelivery(result.delivery_id);assert.equal(withdrawn.approval_status,'withdrawn');assert.equal(ops.readOperation(req.operation_id).state,'succeeded');assert.equal(fileHash(join(withdrawn.directory,'assets.zip')),result.archive_sha256);
`),120000);
test('resolver and file adapter use committed authority, exact formats, and typed task ambiguity',()=>run(String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery');const {request,brief}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const a=playback(candidate.id);
 const req={task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:a.acceptance_epoch,operation_id:a.pending_delivery_operation_id};await assert.rejects(mod.resolveActionExport(context,'sequence'),e=>e.code==='DELIVERY_NOT_COMMITTED');
 const done=await mod.packageAcceptedCandidate(req),resolution=await mod.resolveActionExport(context,'spritesheet');assert.deepEqual(resolution.files.map(f=>f.file),c.readCandidateManifest(candidate.id).sheets.map(s=>s.file));
 const {Elysia}=await import('./apps/server/node_modules/elysia'),{productionApi}=await import('./apps/server/src/pipeline/productionApi'),app=new Elysia().use(productionApi);
 const file=await app.handle(new Request('http://localhost/api/v1'+resolution.files[0].url.split('/api/v1')[1]));assert.equal(file.status,200);assert.deepEqual(new Uint8Array(await file.arrayBuffer()),new Uint8Array(readFileSync(mod.deliveryFilePath(done.delivery_id,resolution.files[0].file))));
 playback(candidate.id,false);const historical=await app.handle(new Request('http://localhost/api/v1/deliveries/'+done.delivery_id+'/file?path=assets.zip'));assert.equal(historical.status,200);assert.equal(historical.headers.get('X-Approval-Status'),'withdrawn');await assert.rejects(mod.resolveActionExport(context,'spritesheet'),e=>e.code==='ACCEPTED_CANDIDATE_REQUIRED');
 d.createCollaborationTask(brief,{request_key:uid()},actor);const ambiguous=await mod.resolveActionExport(context,'sequence');assert.equal(ambiguous.mode,'ambiguous');assert.equal(ambiguous.task_ids.length,2);
`),120000);
test('original identity checks reject edited payload/base and staging mutation before move',()=>run(String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery');const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const a=playback(candidate.id),id=a.pending_delivery_operation_id;
 const req=mod.readDeliveryRequest(id),row=db.query('SELECT payload_json,base_content_json FROM collab_operations WHERE id=?').get(id);
 db.query('UPDATE collab_operations SET payload_json=? WHERE id=?').run('{}',id);assert.throws(()=>mod.readDeliveryRequest(id),e=>e.code==='OPERATION_INPUT_MISMATCH');db.query('UPDATE collab_operations SET payload_json=?,base_content_json=? WHERE id=?').run(row.payload_json,JSON.stringify({revision:0,hash:'a'.repeat(64)}),id);assert.throws(()=>mod.readDeliveryRequest(id),e=>e.code==='DELIVERY_IDENTITY_INVALID');db.query('UPDATE collab_operations SET base_content_json=NULL WHERE id=?').run(id);
 await assert.rejects(mod.packageAcceptedCandidate(req,undefined,undefined,{onPhase(phase,cp){if(phase==='prepared')writeFileSync(join(cp.staging_directory,'assets.zip'),'bad archive');}}),e=>e.code==='DELIVERY_FILE_CHANGED');assert.equal(ops.readOperation(id).state,'failed');
`),120000);
test('shared publication boundary rejects prior revocation, preserves moved evidence, and commit wins late abort',()=>run(String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery').catch(()=>({}));assert.equal(typeof mod.packageAcceptedCandidate,'function');
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);let accepted=playback(candidate.id);
 const req=()=>({task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:accepted.acceptance_epoch,operation_id:accepted.pending_delivery_operation_id});
 const old=req();await assert.rejects(mod.packageAcceptedCandidate(old,undefined,undefined,{onPhase(phase){if(phase==='prepared')playback(candidate.id,false);}}),e=>e.code==='ACCEPTANCE_INVALID');assert.notEqual(ops.readOperation(old.operation_id).state,'succeeded');
 accepted=playback(candidate.id);const moving=req();await assert.rejects(mod.packageAcceptedCandidate(moving,undefined,undefined,{onPhase(phase){if(phase==='moved')throw Error('synthetic commit gap');}}),/synthetic commit gap/);const cp=ops.readOperation(moving.operation_id).checkpoint;assert.equal(cp.delivery.phase,'prepared');assert.throws(()=>mod.readDelivery(cp.delivery.delivery_id),e=>e.code==='DELIVERY_NOT_COMMITTED');
 playback(candidate.id,false);accepted=playback(candidate.id);const ac=new AbortController(),latest=req();const done=await mod.packageAcceptedCandidate(latest,ac.signal,undefined,{onPhase(phase){if(phase==='committed')ac.abort();}});assert.equal(ops.readOperation(latest.operation_id).state,'succeeded');assert.equal(done.approval_status,'approved');
`),120000);
test('human acceptance wakes existing queue without maker and duplicate callbacks share attempt',()=>run(String.raw`
 const q=await import('./apps/server/src/queue');assert.equal(typeof q.queueAcceptedDelivery,'function');
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const accepted=playback(candidate.id),id=accepted.pending_delivery_operation_id;
 const a=q.queueAcceptedDelivery(id),b=q.queueAcceptedDelivery(id);assert.equal(a.job_id,b.job_id);assert.equal(ops.readOperation(id).attempt_job_ids.length,1);assert.equal(q.getPersistedJob(a.job_id).operation_id,id);
 for(let i=0;i<500&&!['done','error','cancelled'].includes(q.getPersistedJob(a.job_id).status);i++)await Bun.sleep(20);
 assert.equal(q.getPersistedJob(a.job_id).status,'done',JSON.stringify(q.getPersistedJob(a.job_id)));assert.equal(ops.readOperation(id).state,'succeeded');assert.equal(q.queueAcceptedDelivery(id).job_id,a.job_id);
 assert.equal(q.cancelJob(a.job_id),false);assert.equal(ops.readOperation(id).state,'succeeded');
`),120000);
test('staging corruption after copy cannot become a new checksum authority',()=>run(String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery');const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const a=playback(candidate.id);
 const req={task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:a.acceptance_epoch,operation_id:a.pending_delivery_operation_id};
 await assert.rejects(mod.packageAcceptedCandidate(req,undefined,undefined,{onPhase(phase,cp){if(phase==='copied')writeFileSync(join(cp.staging_directory,c.readCandidateManifest(candidate.id).frames[0].files.png),'modified before inventory');}}),e=>e.code==='DELIVERY_FILE_CHANGED');
 assert.notEqual(ops.readOperation(req.operation_id).state,'succeeded');
`),120000);
test('controlled packaging barrier admits advisory revision but rejects candidate corruption and revoked epoch',()=>run(String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery');const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);let a=playback(candidate.id);
 const req=()=>({task_id:candidate.task_id,candidate_id:candidate.id,acceptance_epoch:a.acceptance_epoch,operation_id:a.pending_delivery_operation_id});
 let ready,release;const entered=new Promise(resolve=>ready=resolve),barrier=new Promise(resolve=>release=resolve);const operation=req();
 const packing=mod.packageAcceptedCandidate(operation,undefined,undefined,{onPhase(phase){if(phase==='prepared'){ready();return barrier;}}});await entered;
 r.applyIssue(rc(candidate.id),{frame_ids:[c.readCandidateManifest(candidate.id).frames[0].frame_id],rect:null,coordinate_system:'final_canvas_pixels',text:'synthetic advisory while packaging',severity:'advisory'},human);release();const done=await packing;assert.ok(done.review_revision>a.review_revision);
 playback(candidate.id,false);a=playback(candidate.id);const newer=req(),m=c.readCandidateManifest(candidate.id);const old=readFileSync(c.candidateFilePath(candidate.id,m.frames[0].files.png));
 await assert.rejects(mod.packageAcceptedCandidate(newer,undefined,undefined,{onPhase(phase){if(phase==='prepared')writeFileSync(c.candidateFilePath(candidate.id,m.frames[0].files.png),'fixed candidate corrupt');}}),e=>e.code==='ACCEPTANCE_INVALID');assert.ok(ops.readOperation(newer.operation_id).checkpoint.revocation);writeFileSync(join(STORAGE_ROOT,'retained-before-corruption.png'),old);
`),120000);
test('requested auxiliary preview uses fixed final pixels and missing format requires new candidate',async()=>{
 const setup=reviewSetup.replace("formats:['png_sequence','spritesheet']","formats:['png_sequence','preview_mp4']");
 const x=await runCollaborationScript(setup+String.raw`
 const mod=await import('./apps/server/src/pipeline/collaboration/delivery');const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const a=playback(candidate.id);
 await assert.rejects(mod.resolveActionExport(context,'spritesheet'),e=>e.code==='NEW_CANDIDATE_REQUIRED');const done=await mod.packageAcceptedCandidate(mod.readDeliveryRequest(a.pending_delivery_operation_id));assert.ok(done.checksums['previews/preview-on-background.mp4']);assert.equal(fileHash(mod.deliveryFilePath(done.delivery_id,'previews/preview-on-background.mp4')),done.checksums['previews/preview-on-background.mp4']);
 `,'t8');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},120000);
