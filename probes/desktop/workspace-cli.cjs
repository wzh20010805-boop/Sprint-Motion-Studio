const { spawn } = require("node:child_process");
const path = require("node:path");

// 每次重新经过 CLI 握手，不能把旧窗口的服务身份、项目页面或用户配置目录带到目标窗口。
function createWorkspaceCli({ runtime, repositoryRoot, env = process.env }) {
  return args => new Promise((resolve, reject) => {
    const childEnv = { ...env, SFS_REPO_ROOT: repositoryRoot };
    for (const key of Object.keys(childEnv)) {
      if (key === "SFS_WORKSPACE" || /^SFS_(SERVICE_|PROBE_|TEST_|SMOKE_|GUI_)/.test(key) || key.startsWith("P0_")) delete childEnv[key];
    }
    childEnv.SFS_PROBE_PATH = "/";
    const child = spawn(runtime, [path.join(repositoryRoot, "apps/cli/src/index.ts"), ...args, "--json"], {
      cwd: repositoryRoot, windowsHide: true, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", code => {
      let result;
      try { result = JSON.parse(output); }
      catch { reject(new Error("工作区命令未返回有效结果，请检查工作区服务日志。")); return; }
      if (code !== 0 || result.ok !== true) { reject(new Error(result.error?.message || "工作区命令执行失败。")); return; }
      resolve(result);
    });
  });
}

module.exports = { createWorkspaceCli };
