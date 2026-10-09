import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..");
const fixtures = join(repo, "docs", "evidence", "p1", "service-fixtures");
mkdirSync(fixtures, { recursive: true });

async function child(name: string, code: string) {
  const workspace = join(fixtures, `${name}-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: repo, env: { ...process.env, SFS_WORKSPACE: workspace }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await Bun.write(join(workspace, "test-output.log"), `${stdout}\n${stderr}`);
  expect({ exit, output: `${stdout}\n${stderr}` }).toEqual({ exit: 0, output: "PASS\n\n" });
}

describe("P1 shared service", () => {
  test("migration backs up WAL contents before adding source schema and remains idempotent", async () => {
    await child("migration", `
      import assert from 'node:assert/strict';
      import { Database } from 'bun:sqlite';
      import { readdirSync } from 'node:fs';
      import { join } from 'node:path';
      const { migratePipeline } = await import('./apps/server/src/pipeline/migrations.ts');
      const root = process.env.SFS_WORKSPACE;
      const db = new Database(join(root,'framebaker.db'));
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,created_at INTEGER); CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,type TEXT,status TEXT,progress TEXT,error TEXT,created_at INTEGER); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER); CREATE TABLE animation_axes(id TEXT PRIMARY KEY,project_id TEXT); CREATE TABLE animation_tracks(id TEXT PRIMARY KEY,axis_id TEXT); CREATE TABLE animation_steps(id TEXT PRIMARY KEY,axis_id TEXT); CREATE TABLE frames(id TEXT PRIMARY KEY,project_id TEXT); INSERT INTO projects VALUES(\'legacy\',\'WAL preserved\',42)");
      const first = migratePipeline(db, root);
      assert.ok(first.backupPath);
      const backup = new Database(first.backupPath, {readonly:true});
      assert.equal(backup.query('SELECT name FROM projects').get().name,'WAL preserved');
      assert.equal(backup.query("SELECT name FROM pragma_table_info('projects') WHERE name='revision'").get(),null);
      assert.equal(db.query('SELECT revision FROM projects').get().revision,0);
      assert.equal(db.query('SELECT version FROM schema_migrations WHERE version=3').get().version,3);
      const second = migratePipeline(db,root);
      assert.equal(second.backupPath,null);
      assert.equal(readdirSync(join(root,'backups')).filter(x=>x.endsWith('.db')).length,1);
      backup.close(); db.close(); console.log('PASS');
    `);
  });

  test("HTTP imports validated immutable source and queues exact timed frames as safe editor copies", async () => {
    await child("http", `
      import assert from 'node:assert/strict';
      import {readFileSync,existsSync} from 'node:fs';
      import {join} from 'node:path';
      const {app} = await import('./apps/server/src/app.ts');
      const {db,STORAGE_ROOT} = await import('./apps/server/src/db.ts');
      assert.equal(STORAGE_ROOT, process.env.SFS_WORKSPACE);
      const request = async (path,body) => {
        const r=await app.handle(new Request('http://localhost/api/v1'+path,{method:body?'POST':'GET',headers:body instanceof FormData?{}:body?{'content-type':'application/json'}:{},body:body instanceof FormData?body:body?JSON.stringify(body):undefined}));
        const text=await r.text(); try{return {code:r.status,...JSON.parse(text)}}catch{throw Error(text)};
      };
      const made=await request('/projects',{name:'小兵测试'}); assert.equal(made.code,200); assert.equal(made.schema_version,'1.0');
      const projectId=made.data.project.id;
      const input=join(STORAGE_ROOT,'test 输入&路径.mp4');
      const proc=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','48','-c:v','libx264','-pix_fmt','yuv420p',input],{stdout:'ignore',stderr:'pipe'});
      await new Response(proc.stderr).text(); assert.equal(await proc.exited,0);
      const form=new FormData(); form.append('projectId',projectId); form.append('file',new File([readFileSync(input)],'../错误后缀.bin'));
      const imported=await request('/sources/import',form); assert.equal(imported.code,200); assert.ok(imported.data.source_id);
      const source=imported.data.source; assert.equal(source.sha256.length,64); assert.ok(existsSync(source.original_path));
      assert.equal(readFileSync(source.original_path).equals(readFileSync(input)),true);
      const invalid=new FormData(); invalid.append('projectId',projectId); invalid.append('file',new File(['not video'],'fake.mp4'));
      const rejected=await request('/sources/import',invalid); assert.equal(rejected.code,400); assert.equal(rejected.ok,false);
      const bad=await request('/clips',{project_id:'../outside',source_id:source.id,name:'bad'}); assert.equal(bad.code,400);
      const clipResponse=await request('/clips',{project_id:projectId,source_id:source.id,name:'attack'}); assert.equal(clipResponse.code,200);
      const clip=clipResponse.data.clip;
      const conflict=await request('/extract',{project_id:projectId,clip_id:clip.id,mode:'all',base_revision:0}); assert.equal(conflict.code,409);
      const accepted=await request('/extract',{project_id:projectId,clip_id:clip.id,mode:'all'}); assert.equal(accepted.status,'accepted'); assert.ok(accepted.job_id);
      const duplicate=await request('/extract',{project_id:projectId,clip_id:clip.id,mode:'all'}); assert.equal(duplicate.code,409);
      let job; for(let i=0;i<300;i++){job=await request('/jobs/'+accepted.job_id);if(['succeeded','failed','cancelled'].includes(job.status))break;await Bun.sleep(30)}
      assert.equal(job.status,'succeeded',JSON.stringify(job)); assert.equal(job.data.job.result.frame_count,48); assert.equal(job.data.job.payload.sourceExtract.clipId,clip.id);
      const frames=db.query('SELECT * FROM source_frames WHERE source_id=? ORDER BY source_index').all(source.id); assert.equal(frames.length,48);
      assert.equal(frames[47].source_index,47); assert.equal(JSON.parse(frames[0].timing_json).display_duration.den,24);
      const cells=db.query('SELECT f.*,s.duration FROM frames f JOIN animation_steps s ON s.id=f.step_id WHERE f.track_id=? ORDER BY s.idx').all(clip.track_id);
      assert.equal(cells.length,48); assert.ok(cells.every(x=>x.duration===1));
      assert.equal(db.query('SELECT fps FROM animation_axes WHERE id=?').get(clip.axis_id).fps,24);
      assert.equal(JSON.parse(cells[0].metadata).source_index,0); assert.equal(JSON.parse(cells[47].metadata).source_frame_id,frames[47].source_frame_id);
      assert.ok(cells.every(x=>x.raw_path.startsWith(join(STORAGE_ROOT,'projects',projectId,'raw',clip.id))));
      assert.notEqual(cells[0].raw_path,join(STORAGE_ROOT,'sources',source.id,'raw','frame_000000.png'));
      const inspected=await request('/projects/'+projectId); assert.equal(inspected.data.sources.length,1); assert.equal(inspected.data.clips.length,1);
      console.log('PASS');
    `);
  }, 30000);

  test("restart retains queued payload and marks jobs interrupted without false resume", async () => {
    await child("restart", `
      import assert from 'node:assert/strict';
      const {db} = await import('./apps/server/src/db.ts');
      db.query('INSERT INTO jobs(id,project_id,type,status,created_at,payload) VALUES(?,?,?,?,?,?)').run('survivor','p','extract_frames','running',123,JSON.stringify({sourceExtract:{projectId:'p',clipId:'c',sourceId:'s',baseRevision:7}}));
      const proc=Bun.spawn([process.execPath,'-e',"await import('./apps/server/src/queue.ts')"],{cwd:process.cwd(),env:process.env,stdout:'pipe',stderr:'pipe'});
      const err=await new Response(proc.stderr).text(); assert.equal(await proc.exited,0,err);
      const row=db.query('SELECT * FROM jobs WHERE id=?').get('survivor'); assert.equal(row.status,'interrupted'); assert.equal(JSON.parse(row.payload).sourceExtract.baseRevision,7); assert.equal(row.error_code,'SERVICE_RESTARTED'); assert.equal(row.result,null);
      console.log('PASS');
    `);
  });

  test("cancelled extraction publishes no completed DB source and preserves original", async () => {
    await child("cancel", `
      import assert from 'node:assert/strict'; import {join} from 'node:path'; import {existsSync} from 'node:fs';
      const {createProject,importVideo,createClip}=await import('./apps/server/src/pipeline/service.ts');
      const {app}=await import('./apps/server/src/app.ts'); const {db,STORAGE_ROOT}=await import('./apps/server/src/db.ts');
      const input=join(STORAGE_ROOT,'cancel.mp4'); const proc=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=64x64:rate=24','-frames:v','300','-c:v','libx264','-pix_fmt','yuv420p',input],{stdout:'ignore',stderr:'pipe'}); await new Response(proc.stderr).text(); assert.equal(await proc.exited,0);
      const p=createProject('cancel');const s=await importVideo(p.id,input);const c=createClip(p.id,s.id,'clip');
      const accepted=await app.handle(new Request('http://localhost/api/v1/extract',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:p.id,clip_id:c.id,mode:'all'})}));const a=await accepted.json();
      const cancel=await app.handle(new Request('http://localhost/api/v1/jobs/'+a.job_id+'/cancel',{method:'POST'}));assert.equal(cancel.status,200);
      let job; for(let i=0;i<150;i++){job=db.query('SELECT * FROM jobs WHERE id=?').get(a.job_id);if(job.status==='cancelled')break;await Bun.sleep(20)}
      assert.equal(job.status,'cancelled');assert.equal(job.result,null);assert.equal(JSON.parse(job.payload).sourceExtract.clipId,c.id);
      assert.equal(db.query('SELECT count(*) AS n FROM source_frames WHERE source_id=?').get(s.id).n,0);assert.equal(db.query('SELECT count(*) AS n FROM frames WHERE project_id=?').get(p.id).n,0);assert.equal(db.query('SELECT status FROM sources WHERE id=?').get(s.id).status,'imported');assert.ok(existsSync(s.original_path));console.log('PASS');
    `);
  }, 30000);

  test("GUI edit during extraction rejects stale commit and retained source can be retried", async () => {
    await child("stale", `
      import assert from 'node:assert/strict';import {join} from 'node:path';import {existsSync} from 'node:fs';
      const {createProject,importVideo,createClip,extractSource,prepareSourceExtraction}=await import('./apps/server/src/pipeline/service.ts');const {db,STORAGE_ROOT}=await import('./apps/server/src/db.ts');
      const input=join(STORAGE_ROOT,'stale.mp4');const proc=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','48','-c:v','libx264','-pix_fmt','yuv420p',input],{stdout:'ignore',stderr:'pipe'});await new Response(proc.stderr).text();assert.equal(await proc.exited,0);
      const p=createProject('stale');const s=await importVideo(p.id,input);const c=createClip(p.id,s.id,'clip');const payload=prepareSourceExtraction(p.id,c.id);let edited=false;
      await assert.rejects(()=>extractSource(payload,()=>{if(!edited){edited=true;db.query('UPDATE animation_axes SET name=? WHERE id=?').run('GUI updated',c.axis_id)}}),e=>e.code==='STALE_JOB_RESULT');
      assert.equal(db.query('SELECT count(*) AS n FROM source_frames WHERE source_id=?').get(s.id).n,0);assert.equal(db.query('SELECT count(*) AS n FROM frames WHERE project_id=?').get(p.id).n,0);assert.equal(db.query('SELECT status FROM sources WHERE id=?').get(s.id).status,'imported');assert.ok(existsSync(join(STORAGE_ROOT,'sources',s.id,'timing.json')));
      const retried=await extractSource(prepareSourceExtraction(p.id,c.id));assert.equal(retried.frame_count,48);assert.equal(db.query('SELECT status FROM clips WHERE id=?').get(c.id).status,'extracted');console.log('PASS');
    `);
  }, 30000);

  test("legacy GUI default and direct all mode worker share exact source semantics", async () => {
    await child("gui-bridge", `
      import assert from 'node:assert/strict';import {join} from 'node:path';import {readFileSync,existsSync} from 'node:fs';
      const {app}=await import('./apps/server/src/app.ts');const {createProject}=await import('./apps/server/src/pipeline/service.ts');const {extractFrames}=await import('./apps/server/src/jobs/extract.ts');const {db,STORAGE_ROOT}=await import('./apps/server/src/db.ts');
      const input=join(STORAGE_ROOT,'GUI.mp4');const proc=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','48','-c:v','libx264','-pix_fmt','yuv420p',input],{stdout:'ignore',stderr:'pipe'});await new Response(proc.stderr).text();assert.equal(await proc.exited,0);
      const p=createProject('GUI');const form=new FormData();form.append('projectId',p.id);form.append('type','mp4');form.append('file',new File([readFileSync(input)],'GUI.mp4'));const response=await app.handle(new Request('http://localhost/api/import/upload',{method:'POST',body:form}));assert.equal(response.status,200);const accepted=await response.json();assert.equal(accepted.mode,'all');assert.ok(accepted.jobId);
      let job;for(let i=0;i<200;i++){job=db.query('SELECT * FROM jobs WHERE id=?').get(accepted.jobId);if(['done','error'].includes(job.status))break;await Bun.sleep(20)}assert.equal(job.status,'done',JSON.stringify(job));
      const sourceFrames=db.query('SELECT source_index,timing_json FROM source_frames WHERE source_id=? ORDER BY source_index').all(accepted.sourceId);assert.equal(sourceFrames.length,48);
      const other=createProject('worker');await extractFrames({stagingFile:input,mediaType:'mp4',mode:'all',fps:8,autoMatting:false,target:{kind:'project',projectId:other.id}},()=>{},()=>{});
      const workerSource=db.query('SELECT id,original_path FROM sources WHERE project_id=?').get(other.id);assert.ok(workerSource);assert.ok(existsSync(workerSource.original_path));const workerFrames=db.query('SELECT source_index,timing_json FROM source_frames WHERE source_id=? ORDER BY source_index').all(workerSource.id);assert.equal(workerFrames.length,48);
      for(let i=0;i<48;i++){const a=JSON.parse(sourceFrames[i].timing_json),b=JSON.parse(workerFrames[i].timing_json);assert.equal(a.source_index,b.source_index);assert.equal(a.pts,b.pts);assert.deepEqual(a.display_duration,b.display_duration)}assert.ok(existsSync(input));
      const queued=createProject('queued bridge'); const {createJob,getPersistedJob}=await import('./apps/server/src/queue.ts');
      const id=createJob(queued.id,'extract_frames',{extract:{stagingFile:input,mediaType:'mp4',mode:'all',fps:8,autoMatting:false,target:{kind:'project',projectId:queued.id}}});
      let q;for(let i=0;i<200;i++){q=getPersistedJob(id);if(['done','error'].includes(q.status))break;await Bun.sleep(20)}assert.equal(q.status,'done');assert.equal(q.result?.frame_count,48);assert.ok(existsSync(q.result.artifacts[0].path));console.log('PASS');
    `);
  }, 30000);
});
