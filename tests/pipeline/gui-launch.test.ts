import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

// Win32 批处理和可见性必须由 Windows CI 实测，Linux 无对应原生接口。
const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("Start-SFS.cmd从其他目录启动时实际显示窗口，不只创建隐藏进程", async () => {
  const workspace = join(import.meta.dir,"../../fixtures/generated/gui-visible-start",crypto.randomUUID());
  mkdirSync(workspace,{recursive:true});
  const launcher = join(import.meta.dir,"../../Start-SFS.cmd");
  const child = spawn(process.env.ComSpec ?? "cmd.exe",["/d","/s","/c",`""${launcher}" --workspace "${workspace}" --json"`],{windowsVerbatimArguments:true,cwd:process.env.SystemRoot,env:{...process.env,SFS_TEST_VISIBLE_START:"1"},stdio:["ignore","pipe","pipe"]});
  let out="",err="";
  child.stdout!.on("data",chunk=>out+=chunk);
  child.stderr!.on("data",chunk=>err+=chunk);
  const exit=await new Promise<number|null>((resolve,reject)=>{child.on("error",reject);child.on("close",resolve);});
  let info:any;
  try {
    expect(exit,err).toBe(0);
    info = JSON.parse(readFileSync(join(workspace,".sfs/service.json"),"utf8"));
    const reportPath = join(workspace,".sfs/gui-evidence/desktop-report.json");
    let report:any;
    for(let i=0;i<100;i++) {
      try { report=JSON.parse(readFileSync(reportPath,"utf8"));break; } catch { await Bun.sleep(100); }
    }
    expect(report?.visibleStart?.visible).toBeTrue();
    expect(report?.workspaceMenu?.visible).toBeTrue();
    expect(report?.workspaceMenu?.switchLabel).toBe("切换工作区");
    expect(report?.workspaceMenu?.workspace).toBe(workspace);
    expect(report?.exitCode).toBe(0);
  } finally {if(info?.pid)process.kill(info.pid);}
},45000);

windowsTest("普通源码窗口在系统不可截图时仍保持打开，不执行烟测截图", async () => {
  const repo = join(import.meta.dir, "../..");
  const workspace = join(repo, "fixtures/generated/gui-no-capture", crypto.randomUUID());
  mkdirSync(workspace, { recursive: true });
  const cli = Bun.spawn([process.execPath, join(repo, "apps/cli/src/index.ts"), "project", "create", "--name", "截图不可用", "--workspace", workspace, "--json"], { cwd: repo, env: { ...process.env }, windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const cliOut = new Response(cli.stdout).text(), cliErr = new Response(cli.stderr).text();
  expect(await cli.exited, await cliErr).toBe(0); await cliOut;
  const service = JSON.parse(readFileSync(join(workspace, ".sfs/service.json"), "utf8"));
  const evidence = join(workspace, ".sfs/gui-evidence");
  const electron = Bun.spawn([join(repo, "probes/desktop/node_modules/electron/dist/electron.exe"), join(repo, "tests/fixtures/source-desktop-no-capture.cjs")], {
    cwd: repo, windowsHide: false, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, SFS_REPO_ROOT: repo, SFS_WORKSPACE: workspace, SFS_SERVICE_URL: service.url, SFS_SERVICE_TOKEN: service.token, P0_PROFILE_DIR: join(workspace, ".sfs/gui-profile"), P0_EVIDENCE_DIR: evidence },
  });
  try {
    const receipt = join(evidence, "workspace-menu.json");
    for (let i = 0; i < 100 && !existsSync(receipt); i++) await Bun.sleep(100);
    expect(existsSync(receipt)).toBeTrue();
    await Bun.sleep(2500);
    let alive = true;
    try { process.kill(electron.pid, 0); } catch { alive = false; }
    expect(alive).toBeTrue();
    expect(existsSync(join(evidence, "desktop-report.json"))).toBeFalse();
  } finally {
    try { electron.kill(); } catch {}
    try { process.kill(service.pid); } catch {}
  }
}, 45000);
