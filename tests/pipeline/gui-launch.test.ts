import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

test("Start-SFS.cmd从其他目录启动时实际显示窗口，不只创建隐藏进程", async () => {
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
    expect(report?.exitCode).toBe(0);
  } finally {if(info?.pid)process.kill(info.pid);}
},45000);
