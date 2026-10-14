import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';

// 仅测试用：在真实 Python archive dispatch 边界改变 staging，不替换归档输出或审核依据。
for(const mode of ['persistent','transient','unchanged'] as const)test(`archive inventory ${mode==='unchanged'?'preserves unchanged honest bytes':`rejects ${mode} generated-document corruption`}`,async()=>{
 const x=await runCollaborationScript(reviewSetup+`const corruptionMode=${JSON.stringify(mode)};`+String.raw`
 const delivery=await import('./apps/server/src/pipeline/collaboration/delivery');
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);const a=playback(candidate.id),req=delivery.readDeliveryRequest(a.pending_delivery_operation_id);
 const originalSpawn=Bun.spawn,generated=['manifest.json','quality-report.json','checksums.json'];let archiveDirectory,seen=false,restored=false;const before={};
 Bun.spawn=function(argv,options){
  let restore;
  if(Array.isArray(argv)&&String(argv[1]).endsWith('worker.py')){
   const wr=JSON.parse(readFileSync(argv[2],'utf8'));
   if(wr.action==='archive'){
    seen=true;archiveDirectory=wr.directory;
    for(const name of generated){before[name]=readFileSync(join(wr.directory,name));writeFileSync(join(STORAGE_ROOT,'before-'+name),before[name]);}
    if(corruptionMode!=='unchanged'){
     const manifest=JSON.parse(before['manifest.json']);manifest.frames[0].duration={num:99,den:1};writeFileSync(join(wr.directory,'manifest.json'),JSON.stringify(manifest));
     const qa=JSON.parse(before['quality-report.json']);qa.visual_scope='forged: every frame visually inspected';qa.self_check.viewed_frame_ids=qa.self_check.unviewed_frame_ids;qa.self_check.unviewed_frame_ids=[];writeFileSync(join(wr.directory,'quality-report.json'),JSON.stringify(qa));
     const checks=JSON.parse(before['checksums.json']);checks['manifest.json']=fileHash(join(wr.directory,'manifest.json'));checks['quality-report.json']=fileHash(join(wr.directory,'quality-report.json'));writeFileSync(join(wr.directory,'checksums.json'),JSON.stringify(checks));
     for(const name of generated)writeFileSync(join(STORAGE_ROOT,'forged-'+name),readFileSync(join(wr.directory,name)));
     if(corruptionMode==='transient')restore=()=>{for(const name of generated)writeFileSync(join(wr.directory,name),before[name]);restored=true;};
    }
   }
  }
  const child=originalSpawn.call(Bun,argv,options);if(!restore)return child;
  const exited=child.exited.then(code=>{restore();return code;});
  return new Proxy(child,{get(target,key){if(key==='exited')return exited;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 };
 let result,failure;try{result=await delivery.packageAcceptedCandidate(req);}catch(error){failure=error;}finally{Bun.spawn=originalSpawn;}
 assert.ok(seen,'real archive worker was dispatched');assert.equal(restored,corruptionMode==='transient');
 // 实际 ZIP 保留被注入的错误；恢复松散文件不应掩盖它。
 const zip=originalSpawn.call(Bun,[imagePython(),'-c',"import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);m=json.loads(z.read('manifest.json'));q=json.loads(z.read('quality-report.json'));print(json.dumps({'duration':m['frames'][0]['duration'],'viewed':q['self_check']['viewed_frame_ids'],'unviewed':q['self_check']['unviewed_frame_ids']}))",join(result?.directory??archiveDirectory,'assets.zip')],{stdout:'pipe',stderr:'pipe',windowsHide:true});
 const zipped=JSON.parse(await new Response(zip.stdout).text());assert.equal(await zip.exited,0);
 if(corruptionMode==='unchanged'){
  assert.equal(failure,undefined);assert.equal(ops.readOperation(req.operation_id).state,'succeeded');assert.deepEqual(zipped.duration,{num:1,den:12});assert.equal(zipped.viewed.length,0);assert.equal(zipped.unviewed.length,1);
  const cp=ops.readOperation(req.operation_id).checkpoint.delivery;
  for(const [file,sha] of Object.entries(result.checksums)){assert.equal(fileHash(delivery.deliveryFilePath(result.delivery_id,file)),sha);assert.equal(cp.files.find(x=>x.file===file).sha256,sha);}
  assert.equal(result.checksums['assets.zip'],undefined);assert.equal(fileHash(delivery.deliveryFilePath(result.delivery_id,'assets.zip')),result.archive_sha256);
  for(const file of generated)assert.deepEqual(readFileSync(delivery.deliveryFilePath(result.delivery_id,file)),before[file]);
 }else{
  assert.deepEqual(zipped.duration,{num:99,den:1});assert.equal(zipped.unviewed.length,0);
  if(corruptionMode==='transient')for(const name of generated)assert.deepEqual(readFileSync(join(result?.directory??archiveDirectory,name)),before[name]);
  assert.ok(failure,'corrupted generated documents / ZIP must not publish');assert.match(String(failure.message),/DELIVERY_(FILE|ARCHIVE)_CHANGED/);assert.notEqual(ops.readOperation(req.operation_id).state,'succeeded');assert.throws(()=>delivery.readDelivery(req.operation_id),e=>e.code==='DELIVERY_NOT_COMMITTED');
  assert.equal(ops.readOperation(req.operation_id).checkpoint.revocation,null,'staging failure must not revoke immutable acceptance');
 }
 console.log(JSON.stringify({corruptionMode,archiveDirectory,restored,operation_id:req.operation_id,failure:failure?.message??null,zipped}));
 `,'t8f');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},120000);
