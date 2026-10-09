import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");

async function cacheScenario(name: string, body: string) {
  const workspace = join(repository, "fixtures", "generated", `p1-cache-${name}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  const code = `
    import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
    import {join} from 'node:path';
    const {createProject,importVideo,createClip,extractSource,prepareSourceExtraction} = await import('./apps/server/src/pipeline/service.ts');
    const {db,STORAGE_ROOT} = await import('./apps/server/src/db.ts');
    const input=join(STORAGE_ROOT,'three original frames.mp4');
    const proc=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','3','-c:v','libx264','-pix_fmt','yuv420p',input],{stdout:'pipe',stderr:'pipe'});
    const [exit,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);assert.equal(exit,0,err);
    const p=createProject('cache integrity'); const s=await importVideo(p.id,input); const firstClip=createClip(p.id,s.id,'first');
    const first=await extractSource(prepareSourceExtraction(p.id,firstClip.id));assert.equal(first.frame_count,3);
    const directory=join(STORAGE_ROOT,'sources',s.id); const raw=join(directory,'raw','frame_000000.png'); const original=readFileSync(raw);
    const timingPath=join(directory,'timing.json');const validTiming=readFileSync(timingPath);
    const noFrames=clip=>{
      assert.equal(db.query('SELECT count(*) n FROM frames WHERE track_id=?').get(clip.track_id).n,0);
      assert.equal(db.query('SELECT count(*) n FROM animation_steps WHERE axis_id=?').get(clip.axis_id).n,0);
      assert.notEqual(db.query('SELECT status FROM clips WHERE id=?').get(clip.id).status,'extracted');
    };
    ${body}
    assert.deepEqual(readFileSync(s.original_path),readFileSync(input));
    assert.equal(db.query('SELECT count(*) n FROM source_frames WHERE source_id=?').get(s.id).n,3);
    db.close();console.log('PASS');
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { cwd: repository, env: { ...process.env, SFS_WORKSPACE: workspace }, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await Bun.write(join(workspace, "cache-test-output.log"), `${stdout}\n${stderr}`);
  expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "PASS\n", stderr: "" });
}

test("缓存的损坏 PNG 和截断时序阻止新 Clip 入库，恢复有效产物后仍能复用三帧", async () => {
  await cacheScenario("corrupt-and-truncated", `
    writeFileSync(raw,'corrupt PNG after storage transfer');
    writeFileSync(join(STORAGE_ROOT,'corrupt-cache-frame.png'),readFileSync(raw));
    const corruptClip=createClip(p.id,s.id,'corrupt raw');
    await assert.rejects(()=>extractSource(prepareSourceExtraction(p.id,corruptClip.id)),/PNG|解码/);noFrames(corruptClip);
    writeFileSync(raw,original);
    const timing=JSON.parse(validTiming.toString());timing.frames=timing.frames.slice(0,1);timing.duration={num:1,den:24};writeFileSync(timingPath,JSON.stringify(timing));
    writeFileSync(join(STORAGE_ROOT,'truncated-cache-timing.json'),readFileSync(timingPath));
    const truncatedClip=createClip(p.id,s.id,'truncated timing');
    await assert.rejects(()=>extractSource(prepareSourceExtraction(p.id,truncatedClip.id)),error=>error.code==='INVALID_TIMING');noFrames(truncatedClip);
    writeFileSync(timingPath,validTiming);
    const reused=createClip(p.id,s.id,'valid reuse');const result=await extractSource(prepareSourceExtraction(p.id,reused.id));
    assert.equal(result.frame_count,3);assert.equal(db.query('SELECT count(*) n FROM frames WHERE track_id=?').get(reused.track_id).n,3);
    assert.deepEqual(readFileSync(raw),original);assert.deepEqual(readFileSync(timingPath),validTiming);
  `);
}, 30_000);

test("缓存 PNG 即使 IHDR 有效也必须完整解码通过", async () => {
  await cacheScenario("truncated-png", `
    writeFileSync(raw,original.subarray(0,40));
    const invalid=createClip(p.id,s.id,'truncated compressed PNG');
    await assert.rejects(()=>extractSource(prepareSourceExtraction(p.id,invalid.id)),/PNG|解码|失败/);noFrames(invalid);
    assert.equal(readFileSync(raw).length,40);
  `);
}, 30_000);

test("缓存时序中的路径和显示时长篡改不会被相同帧数掩盖", async () => {
  await cacheScenario("semantic-timing", `
    for(const field of ['file','display_duration']){
      const timing=JSON.parse(validTiming.toString());
      if(field==='file')timing.frames[0].file='raw/frame_000001.png';else timing.frames[0].display_duration={num:5,den:24};
      writeFileSync(timingPath,JSON.stringify(timing));
      const invalid=createClip(p.id,s.id,'modified '+field);
      await assert.rejects(()=>extractSource(prepareSourceExtraction(p.id,invalid.id)),error=>error.code==='INVALID_TIMING');noFrames(invalid);
    }
  `);
}, 30_000);
