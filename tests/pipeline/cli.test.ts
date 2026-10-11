import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";

const cli = join(import.meta.dir, "../../apps/cli/src/index.ts");
async function invoke(args: string[], env = process.env) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let body: any;
  try { body = JSON.parse(stdout); } catch { body = null; }
  return { exitCode, body, stdout, stderr };
}

test("doctor输出一个JSON且模型未准备不会冒充可用", async () => {
  const result = await invoke(["doctor", "--json"], {...process.env, SFS_MODEL_DIR:join(import.meta.dir,'nonexistent-models')});
  expect(result.exitCode).toBe(0);
  expect(result.body?.schema_version).toBe("1.0");
  expect(result.body?.data?.capabilities?.extract_all).toBeTrue();
  expect(result.body?.data?.capabilities?.matting).toBeFalse();
  expect(result.body?.warnings).toContain("MODEL_NOT_READY");
});

test("不支持的抽帧mode在创建服务前返回参数错误", async () => {
  const result = await invoke(["extract", "--mode", "fps", "--project", "x", "--clip", "x", "--json"]);
  expect(result.exitCode).toBe(2);
  expect(result.body?.error?.code).toBe("INVALID_ARGUMENT");
});

test("未知命令给结构化错误并不把日志混入stdout", async () => {
  const result = await invoke(["unknown", "--json"]);
  expect(result.exitCode).toBe(2);
  expect(result.body?.ok).toBeFalse();
  expect(result.body?.error?.code).toBe("INVALID_ARGUMENT");
});

test("不开GUI也能完成真实48帧流程，复用服务并返回真实失败退出码", async () => {
  const workspace = join(import.meta.dir, "../../fixtures/generated/cli-integration", crypto.randomUUID());
  mkdirSync(workspace, { recursive: true });
  const command = (args: string[]) => invoke([...args, "--workspace", workspace, "--json"]);
  let info: any;
  try {
    const seeded = Bun.spawn([process.execPath,"-e", "const {db}=await import('./apps/server/src/db.ts'); db.query(\"INSERT INTO jobs(id,project_id,type,status,error,error_code,created_at) VALUES('historical-failed','fixture','extract_frames','error','test failure','JOB_FAILED',1)\").run(); db.close();"], {cwd:join(import.meta.dir,"../.."),env:{...process.env,SFS_WORKSPACE:workspace},stdout:"pipe",stderr:"pipe"});
    const [seedExit,,seedError] = await Promise.all([seeded.exited,new Response(seeded.stdout).text(),new Response(seeded.stderr).text()]);
    expect({seedExit,seedError}).toEqual({seedExit:0,seedError:""});
    const video = join(workspace,"CLI 样例 (48帧).mp4");
    const fixture = Bun.spawn(["ffmpeg","-hide_banner","-nostdin","-n","-f","lavfi","-i","testsrc2=size=64x48:rate=24","-frames:v","48","-c:v","libx264","-pix_fmt","yuv420p",video],{stdout:"pipe",stderr:"pipe"});
    const [fixtureExit,,fixtureError] = await Promise.all([fixture.exited,new Response(fixture.stdout).text(),new Response(fixture.stderr).text()]);
    expect(fixtureExit,fixtureError).toBe(0);
    const created = await command(["project", "create", "--name", "CLI 小兵 (48帧)"]);
    expect(created.exitCode).toBe(0);
    const project = created.body.data.project.id;
    info = JSON.parse(readFileSync(join(workspace, ".sfs/service.json"), "utf8"));
    const imported = await command(["import", "video", "--project", project, "--file", video]);
    expect(imported.exitCode).toBe(0);
    const source = imported.body.data.source_id;
    const clip = await command(["clip", "create", "--project", project, "--source", source, "--name", "attack"]);
    expect(clip.exitCode).toBe(0);
    const extracted = await command(["extract", "--project", project, "--clip", clip.body.data.clip_id, "--mode", "all", "--wait"]);
    expect(extracted.exitCode).toBe(0);
    expect(extracted.body.data.job.result.frame_count).toBe(48);
    expect(extracted.body.data.job.result.source_duration).toEqual({num:2,den:1});
    expect(existsSync(extracted.body.artifacts[0].path)).toBeTrue();
    const inspect = await command(["project", "inspect", "--project", project]);
    expect(inspect.body.data.sources[0].id).toBe(source);
    expect(JSON.parse(readFileSync(join(workspace,".sfs/service.json"),"utf8")).instance_id).toBe(info.instance_id);
    const revision = await command(["extract", "--project", project, "--clip", clip.body.data.clip_id, "--base-revision", "0"]);
    expect(revision.exitCode).toBe(6);
    expect((await fetch(info.url + "/api/v1/projects")).status).toBe(401);
    expect((await fetch(info.url + "/api/v1/projects", {headers:{authorization:`Bearer ${info.token}`,origin:"http://wrong.example"}})).status).toBe(403);
    const disabled = await fetch(info.url + "/api/doctor", {headers:{authorization:`Bearer ${info.token}`}});
    expect(disabled.status).toBe(403);
    const matteForm = new FormData(); matteForm.set("projectId",project); matteForm.set("type","mp4"); matteForm.set("autoMatting","true"); matteForm.set("file",Bun.file(video));
    const matte = await fetch(info.url+"/api/import/upload",{method:"POST",headers:{authorization:`Bearer ${info.token}`},body:matteForm});
    expect(matte.status).toBe(409);
    expect((await matte.json() as any).error.code).toBe('USE_P2_MATTE');
    const libraryForm = new FormData(); libraryForm.set("file",Bun.file(video));
    const library = await fetch(info.url+"/api/materials/upload",{method:"POST",headers:{authorization:`Bearer ${info.token}`},body:libraryForm});
    expect(library.status).toBe(200);
    const libraryQueued = await library.json() as any;
    expect(libraryQueued.mode).toBe('all');
    const libraryWait = await command(['job','wait','--job',libraryQueued.jobId]);
    expect(libraryWait.exitCode).toBe(0);
    expect(libraryWait.body.data.job.result.frame_count).toBe(48);
    const absent = await command(["job", "status", "--job", "missing"]);
    expect(absent.exitCode).toBe(2);
    expect((await command(["job","status","--job","historical-failed"])).exitCode).toBe(0);
    const historicalWait = await command(["job","wait","--job","historical-failed"]);
    expect(historicalWait.exitCode).toBe(1);
    expect(historicalWait.body.status).toBe("failed");
    const [one,two] = await Promise.all([command(["project","inspect","--project",project]),command(["project","inspect","--project",project])]);
    expect(one.exitCode).toBe(0); expect(two.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(workspace,".sfs/service.json"),"utf8")).instance_id).toBe(info.instance_id);
  } finally { if(info?.pid) process.kill(info.pid); }
}, 90_000);

test("缺少ffprobe的真实视频导入返回依赖错误3而不是素材错误2", async () => {
  const workspace=join(import.meta.dir,"../../fixtures/generated/cli-missing-probe",crypto.randomUUID());
  mkdirSync(workspace,{recursive:true});
  // 同时移除 PATH 中的 Bun 和媒体工具，也不提供本机旁置运行时。
  // 源码 CLI 应使用正在运行的 Bun 启动后端，让测试真正走到 ffprobe 缺失。
  const runtimeRoot=join(workspace,"repo-without-bundled-runtime");
  mkdirSync(runtimeRoot,{recursive:true});
  symlinkSync(join(import.meta.dir,"../../apps"),join(runtimeRoot,"apps"),process.platform==="win32"?"junction":"dir");
  const env={...process.env,PATH:"",SFS_REPO_ROOT:runtimeRoot};
  let info:any;
  try {
    const created=await invoke(["project","create","--name","dependency","--workspace",workspace],env);
    expect(created.exitCode).toBe(0);
    info=JSON.parse(readFileSync(join(workspace,".sfs/service.json"),"utf8"));
    const video=join(workspace,"video.mp4");
    const fixture=Bun.spawn(["ffmpeg","-hide_banner","-nostdin","-n","-f","lavfi","-i","testsrc2=size=32x32:rate=24","-frames:v","2","-c:v","libx264",video],{stdout:"pipe",stderr:"pipe"});
    const [fixtureExit,,fixtureError]=await Promise.all([fixture.exited,new Response(fixture.stdout).text(),new Response(fixture.stderr).text()]);
    expect(fixtureExit,fixtureError).toBe(0);
    const imported=await invoke(["import","video","--project",created.body.project_id,"--file",video,"--workspace",workspace],env);
    expect(imported.exitCode).toBe(3);
    expect(imported.body.error.code).toBe("DEPENDENCY_MISSING");
  } finally {if(info?.pid)process.kill(info.pid);}
},60000);
