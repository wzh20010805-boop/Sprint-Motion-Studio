import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const probe = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(probe, "../..");
const evidence = path.join(repo, "docs/evidence/p0");
const output = path.join(probe, "artifacts/framebaker-p0-win-x64");
const runtime = path.join(output, "runtime");
const backend = path.join(runtime, "backend");
const app = path.join(output, "resources/app");
const bun = path.resolve(repo, "../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe");
const electronDist = path.join(probe, "node_modules/electron/dist");
fs.mkdirSync(backend, { recursive: true });
fs.mkdirSync(app, { recursive: true });
const source = path.join(probe, "snapshot");
// 不复制 Bun 隔离安装的 junction；在副本内按锁文件重新生成正确的依赖布局。
for (const directory of ["apps", "packages"]) {
  fs.cpSync(path.join(source, directory), path.join(backend, directory), {
    recursive: true, filter: p => !p.split(path.sep).includes("node_modules"),
  });
}
for (const file of ["package.json", "bun.lock"]) fs.copyFileSync(path.join(source, file), path.join(backend, file));
fs.copyFileSync(bun, path.join(runtime, "bun.exe"));
const install = spawnSync(path.join(runtime, "bun.exe"), ["install", "--frozen-lockfile"], { cwd: backend, windowsHide: true, shell: false, encoding: "utf8" });
fs.writeFileSync(path.join(evidence, "desktop-package-install.log"), `cwd: ${backend}\ncommand: runtime/bun.exe install --frozen-lockfile\nexit: ${install.status}\n${install.stdout || ""}${install.stderr || ""}`);
if (install.status !== 0) throw new Error(`副本冻结安装失败: ${install.status}`);
fs.cpSync(electronDist, output, { recursive: true, filter: p => path.basename(p) !== "electron.exe" });
fs.copyFileSync(path.join(electronDist, "electron.exe"), path.join(output, "FrameBaker-P0.exe"));
for (const file of ["main.cjs", "service.ts"]) fs.copyFileSync(path.join(probe, file), path.join(app, file));
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "framebaker-p0-probe", version: "0.0.0", private: true, main: "main.cjs", description: "P0 实际上游 UI 的 Windows 本机探针，不是正式发布包" }, null, 2));
fs.writeFileSync(path.join(output, "README_FIRST_RUN.txt"), "FrameBaker P0 本机可行性探针。运行 FrameBaker-P0.exe --smoke 自动验证并退出；无 --smoke 显示窗口。仅供开发验证：鉴权、实例锁、用户数据迁移和正式发布条件仍待后续阶段。Bun 运行时与来源副本位于 runtime/backend；不要求用户安装 Node/Bun。\n");
let bytes = 0, files = 0;
function measure(root) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) measure(p);
    else { bytes += fs.statSync(p).size; files++; }
  }
}
measure(output);
function digest(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
const manifest = { at: new Date().toISOString(), command: "node probes/desktop/build-package.mjs", cwd: repo, output, source, node: process.version, electron: JSON.parse(fs.readFileSync(path.join(probe, "node_modules/electron/package.json"))).version, bun: spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout.trim(), installExitCode: install.status, bytesWithoutFollowingJunctions: bytes, regularFiles: files, sha256: { bun: digest(path.join(runtime, "bun.exe")), electron: digest(path.join(output, "FrameBaker-P0.exe")), upstreamDb: digest(path.join(backend, "apps/server/src/db.ts")), upstreamApp: digest(path.join(backend, "apps/server/src/app.ts")) } };
fs.writeFileSync(path.join(evidence, "desktop-package.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
