import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {candidateSetup} from './candidateFixture';
test('technical check examines all 300 frozen files including missing and corrupt frames beyond 256',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {request}=await seedCandidate(300);const candidate=await c.buildPrivateCandidate(request());const m=c.readCandidateManifest(candidate.id),root=c.candidateDirectory(candidate.id);
 let report=await checkCandidate(candidate.id);assert.equal(report.checked_frame_count,300);assert.deepEqual(report.blocking_errors,[]);
 const {unlinkSync}=await import('node:fs');unlinkSync(join(root,m.frames[298].files.png));writeFileSync(join(root,m.frames[299].files.png),'corrupt');
 report=await checkCandidate(candidate.id);assert.equal(report.checked_frame_count,300);assert.ok(report.blocking_errors.some(e=>e.frame_id===m.frames[298].frame_id));assert.ok(report.blocking_errors.some(e=>e.frame_id===m.frames[299].frame_id));
 assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/TECHNICAL_CHECK_FAILED|CANDIDATE_FILE_CHANGED/);
 console.log(JSON.stringify(report));
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},180000);

test('imported alpha1 remains reviewable while automatic low-confidence provenance blocks',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const soft=Bun.spawn([imagePython(),'-c',"from PIL import Image;import sys;i=Image.new('RGBA',(64,64),(220,30,60,1));i.save(sys.argv[1])",path],{windowsHide:true});assert.equal(await soft.exited,0);
 const {request}=await seedCandidate(2,readFileSync(path));const imported=await c.buildPrivateCandidate(request());assert.deepEqual((await checkCandidate(imported.id)).blocking_errors,[]);
 const f=d.readDraftContent(context).frames[0],mask=maskState(f.frame_id).current;
 db.query("UPDATE mask_versions SET kind='automatic',info=? WHERE id=?").run(JSON.stringify({reasons:['LOW_CONFIDENCE'],foreground_fraction:1,visible_fraction:0}),mask.id);
 const automatic=await c.buildPrivateCandidate(request());assert.ok((await checkCandidate(automatic.id)).blocking_errors.some(e=>e.code==='LOW_CONFIDENCE'));
 console.log('imported alpha and automatic confidence remain distinct');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
test('cross-language authoritative affine mapping handles rotation offset root and negative scale',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {request}=await seedCandidate();const f=d.readDraftContent(context).frames[0];db.query('UPDATE frames SET rotation=?,scale=-1,offset_x=2,offset_y=3 WHERE id=?').run(Math.PI/2,f.frame_id);
 const candidate=await c.buildPrivateCandidate(request()),m=c.readCandidateManifest(candidate.id),mapping=m.frames[0].source_to_canvas;
 const map=(a,x,y)=>[a[0]*x+a[2]*y+a[4],a[1]*x+a[3]*y+a[5]];
 const p=map(mapping.matrix,20.5,8.5),back=map(mapping.inverse_matrix,...p);assert.ok(Math.abs(back[0]-20.5)<1e-9&&Math.abs(back[1]-8.5)<1e-9);
 assert.deepEqual(p,[26.5,76.5]);
 const pixel=Bun.spawn([imagePython(),'-c',"from PIL import Image;import sys;assert Image.open(sys.argv[1]).getpixel((26,76))[3]==255",join(c.candidateDirectory(candidate.id),m.frames[0].files.png)],{windowsHide:true});assert.equal(await pixel.exited,0);
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);

test('saved-image checks distinguish legal soft alpha, empty/clipped output, provenance, dimensions and sheet/input tampering',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const {request}=await seedCandidate();const f=d.readDraftContent(context).frames[0];
 for(const opacity of [1/255,128/255,0]){
  db.query('UPDATE frames SET opacity=? WHERE id=?').run(opacity,f.frame_id);const candidate=await c.buildPrivateCandidate(request());const check=await checkCandidate(candidate.id);
  if(opacity===0)assert.ok(check.blocking_errors.some(e=>e.code==='EMPTY_FRAME'));else assert.deepEqual(check.blocking_errors,[]);
 }
 db.query('UPDATE frames SET opacity=1,offset_x=80 WHERE id=?').run(f.frame_id);const clipped=await c.buildPrivateCandidate(request());assert.ok((await checkCandidate(clipped.id)).blocking_errors.some(e=>e.code==='FRAME_CLIPPED'));
 db.query('UPDATE frames SET offset_x=0 WHERE id=?').run(f.frame_id);const candidate=await c.buildPrivateCandidate(request()),m=c.readCandidateManifest(candidate.id),root=c.candidateDirectory(candidate.id);
 const mutate=(path,script)=>Bun.spawn([imagePython(),'-c',script,path],{windowsHide:true}).exited;
 assert.equal(await mutate(join(root,m.frames[0].files.png),"from PIL import Image;import sys;Image.new('RGBA',(1,1),(255,0,0,255)).save(sys.argv[1])"),0);
 writeFileSync(join(root,m.frames[1].files.mask),'bad mask');assert.equal(await mutate(join(root,m.sheets[0].file),"from PIL import Image;import sys;p=sys.argv[1];i=Image.open(p);i.putpixel((1,1),(0,255,0,255));i.save(p)"),0);
 const report=await checkCandidate(candidate.id);assert.equal(report.checked_frame_count,2);for(const code of ['IMAGE_DIMENSION_MISMATCH','FILE_HASH_MISMATCH','IMAGE_INVALID','SHEET_PIXELS_MISMATCH'])assert.ok(report.blocking_errors.some(e=>e.code===code),code);
 console.log('saved output and frozen input failures verified');
 `,'t4');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},180000);
