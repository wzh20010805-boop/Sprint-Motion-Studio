import { test, expect } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 使用真正带桌面限制的服务，而非绕过 index.ts 的 app.handle。
for (const entry of ['project', 'library'] as const) {
  test(`${entry} imports retain independent reusable library assets`, async () => {
    const repo = join(import.meta.dir, '..');
    const workspace = join(repo, 'docs/evidence/material-retention', `${entry}-${crypto.randomUUID()}`);
    mkdirSync(workspace, { recursive: true });
    const code = `
      import assert from 'node:assert/strict';
      import {readFileSync,existsSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {ensureService,requestService,waitJob} from './apps/cli/src/client.ts';
      const root=process.env.SFS_WORKSPACE;
      const video=join(root,'run.mp4');
      const proc=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','6','-c:v','libx264','-pix_fmt','yuv420p',video],{windowsHide:true,stdout:'ignore',stderr:'pipe'});
      const err=await new Response(proc.stderr).text(); assert.equal(await proc.exited,0,err);
      const gif=join(root,'blink.gif');
      const g=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-i',video,'-frames:v','2',gif],{windowsHide:true,stdout:'ignore',stderr:'pipe'});
      const ge=await new Response(g.stderr).text();assert.equal(await g.exited,0,ge);
      const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
      const service=await ensureService(root);
      try {
        const req=(path,body,method='POST')=>requestService(service,path,{method,body:body instanceof FormData?body:body?JSON.stringify(body):undefined,headers:body && !(body instanceof FormData)?{'content-type':'application/json'}:{}});
        const project=await req('/api/projects',{name:'source'});
        for(const [name,bytes,type] of [['hero.png',image,'image'],['run.mp4',readFileSync(video),'mp4'],['blink.gif',readFileSync(gif),'gif']]){
          const fd=new FormData();fd.append('file',new File([bytes],name));fd.append('autoMatting','false');fd.append('type',type);fd.append('mode','all');fd.append('projectId',project.id);
          const r=await req('${entry === 'project' ? '/api/import/upload' : '/api/materials/upload'}',fd);
          if(r.jobId){const done=await waitJob(service,r.jobId,20);assert.equal(done.exitCode,0,JSON.stringify(done.body));}
        }
        const list=await req('/api/materials',undefined,'GET');
        assert.ok(list.materials.every(m=>m.project_ids.length===1&&m.project_ids[0]===project.id),'originals and all extracted images must inherit their project partition');
        const images=list.materials.filter(m=>m.kind==='image');
        assert.equal(images.length,9,'library must contain the image, all 6 video frames and 2 GIF frames');
        const original=list.materials.find(m=>m.kind==='video' && m.name==='run');
        assert.ok(original,'original video must remain reusable in library');
        assert.equal(readFileSync(original.raw_path).equals(readFileSync(video)),true);
        assert.ok(list.materials.every(m=>m.raw_path.startsWith(join(root,'materials'))));
        const target=await req('/api/projects',{name:'reuse'});
        const empty=await req('/api/projects/'+target.id+'/timeline',undefined,'GET');
        await req('/api/materials/batch-import',{ids:images.map(m=>m.id),projectId:target.id,target:{axisId:empty.axis.id,trackId:empty.tracks[0].id}});
        const timeline=await req('/api/projects/'+target.id+'/timeline',undefined,'GET');
        assert.equal(timeline.frames.length,9);
        const reused=timeline.frames.find(f=>JSON.parse(JSON.stringify(f.metadata)).fromMaterial===images[0].id);
        assert.ok(reused);assert.notEqual(reused.raw_path,images[0].raw_path);
        const shared=await req('/api/materials',undefined,'GET');assert.ok(shared.materials.filter(m=>m.kind==='image').every(m=>m.project_ids.includes(project.id)&&m.project_ids.includes(target.id)),'reuse must add target membership without losing source');
        const before=readFileSync(images[0].raw_path);writeFileSync(reused.raw_path,image);assert.equal(readFileSync(images[0].raw_path).equals(before),true);
        await req('/api/projects/'+project.id,undefined,'DELETE');
        assert.ok(list.materials.every(m=>existsSync(m.raw_path)),'deleting source project must preserve library');
        const extracted=await req('/api/materials/'+original.id+'/extract',{});
        const done=await waitJob(service,extracted.jobId,20);assert.equal(done.exitCode,0,JSON.stringify(done.body));
        const again=await req('/api/materials',undefined,'GET');assert.equal(again.materials.length,11,'repeat extraction must reuse existing source frames');
        assert.ok(again.materials.every(m=>!m.project_ids.includes(project.id)),'deleted projects must disappear from partitions while assets remain');
        writeFileSync(join(root,'report.json'),JSON.stringify({entry:'${entry}',materials:list.materials.length,reusedFrames:timeline.frames.length,repeatMaterials:again.materials.length,passed:true},null,2));
      }finally{process.kill(service.pid);}
      console.log('PASS');
    `;
    const proc = Bun.spawn([process.execPath, '-e', code], { cwd: repo, env: { ...process.env, SFS_WORKSPACE: workspace }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [exit, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await Bun.write(join(workspace, 'test-output.log'), out + '\n' + err);
    expect({ exit, output: out + '\n' + err }).toEqual({ exit: 0, output: 'PASS\n\n' });
  }, 60000);
}

test('upgrade retains legacy project imports once without resurrecting deleted library records', async () => {
  const repo = join(import.meta.dir, '..');
  const workspace = join(repo, 'docs/evidence/material-retention', `upgrade-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  const code = `
    import assert from 'node:assert/strict';
    import {join} from 'node:path';
    import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
    import {ensureService,requestService} from './apps/cli/src/client.ts';
    const root=process.env.SFS_WORKSPACE;
    const {db}=await import('./apps/server/src/db.ts');
    const {createProject,importVideo,createClip,extractSource,prepareSourceExtraction}=await import('./apps/server/src/pipeline/service.ts');
    const p=createProject('legacy');
    const video=join(root,'old.mp4');
    const proc=Bun.spawn(['ffmpeg','-hide_banner','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=24','-frames:v','2','-c:v','libx264','-pix_fmt','yuv420p',video],{windowsHide:true,stdout:'ignore',stderr:'pipe'});
    const err=await new Response(proc.stderr).text(); assert.equal(await proc.exited,0,err);
    const source=await importVideo(p.id,video);const clip=createClip(p.id,source.id,'old');await extractSource(prepareSourceExtraction(p.id,clip.id));
    const png=join(root,'projects',p.id,'raw','old-image.png');writeFileSync(png,readFileSync(join(root,'sources',source.id,'raw','frame_000000.png')));
    db.query("INSERT INTO frames(id,project_id,idx,raw_path,status,source) VALUES('legacy-image',?,10,?,'ready','image')").run(p.id,png);
    // 模拟旧版本没有登记素材库的数据库；保留文件作为历史证据。
    db.query('DELETE FROM materials').run();db.close();
    let service=await ensureService(root);
    try{
      const list=await requestService(service,'/api/materials');assert.equal(list.materials.length,4);
      assert.ok(list.materials.every(m=>m.raw_path.startsWith(join(root,'materials'))));
      const chosen=list.materials.find(m=>m.metadata.fromFrame==='legacy-image');assert.ok(chosen);
      await requestService(service,'/api/materials/batch-delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[chosen.id]})});
      process.kill(service.pid); await Bun.sleep(200); service=await ensureService(root);
      const after=await requestService(service,'/api/materials');assert.equal(after.materials.length,3);
      writeFileSync(join(root,'report.json'),JSON.stringify({legacyRetained:4,afterDeletionAndRestart:3,passed:true},null,2));
    }finally{process.kill(service.pid);}
    console.log('PASS');
  `;
  const proc = Bun.spawn([process.execPath, '-e', code], { cwd: repo, env: { ...process.env, SFS_WORKSPACE: workspace }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [exit, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await Bun.write(join(workspace, 'test-output.log'), out + '\n' + err);
  expect({ exit, output: out + '\n' + err }).toEqual({ exit: 0, output: 'PASS\n\n' });
}, 60000);
