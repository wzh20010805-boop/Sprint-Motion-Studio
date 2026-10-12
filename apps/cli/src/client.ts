import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { isProcessAlive, type ServiceInfo } from "../../server/src/runtime";
import { distributionRoot,configureDistribution } from './distribution';
import { PRODUCTION_API_VERSION } from '../../../packages/shared/src/pipeline/alignment';

export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 2, public result?: any) { super(message); }
}

export function repositoryRoot(): string {
  const packed=distributionRoot();if(packed){configureDistribution(packed);return packed;}
  const candidates = [process.env.SFS_REPO_ROOT, resolve(import.meta.dir, "../../.."), dirname(process.execPath), resolve(dirname(process.execPath), "..")];
  const root = candidates.find(value => value && existsSync(join(value, "apps/server/src/runtimeBootstrap.ts")));
  if (!root) throw new CliError("BACKEND_UNAVAILABLE", "找不到工具源码运行时；P1编译CLI需邻接源码目录或SFS_REPO_ROOT", 3);
  return resolve(root);
}

export function defaultWorkspace() { const packed=distributionRoot();return packed?join(process.env.LOCALAPPDATA??packed,'SpriteMotionStudio','workspaces','default'):join(repositoryRoot(), "workspaces", "default"); }

export function readService(workspace: string): ServiceInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(workspace, ".sfs", "service.json"), "utf8")) as ServiceInfo;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) || !/^[a-f0-9]{64}$/.test(info.token) || resolve(info.workspace) !== resolve(workspace) || !isProcessAlive(info.pid)) return null;
    return info;
  } catch { return null; }
}

async function healthy(info: ServiceInfo) {
  try {
    const response = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as any;
    return response.ok && health.instance_id === info.instance_id && health.pid === info.pid;
  } catch { return false; }
}

async function compatibleService(info:ServiceInfo) {
 const response=await fetch(info.url+'/api/config',{headers:{Authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(2000)});
 const config=await response.json() as any;
 if(!response.ok||config.sfs?.production_api_version!==PRODUCTION_API_VERSION)throw new CliError('BACKEND_VERSION_CONFLICT','工作区仍运行旧版或不兼容服务。请保存并关闭旧GUI，待后台任务完成后重启；当前服务和任务未被强行关闭。',6);
 return info;
}

/** CLI只调用HTTP，进程锁在后端加载DB前取得。并发启动的失败者等待赢家。 */
export async function ensureService(workspaceInput: string): Promise<ServiceInfo> {
  const workspace = resolve(workspaceInput);
  const current = readService(workspace);
  if (current && await healthy(current)) return compatibleService(current);
  const root = repositoryRoot();
  mkdirSync(join(workspace, ".sfs"), { recursive: true });
  let existingOwner = false;
  try { existingOwner = isProcessAlive(JSON.parse(readFileSync(join(workspace, ".sfs", "service.lock"), "utf8")).pid); } catch { /* 启动入口处理损坏锁 */ }
  if (!existingOwner) {
    const packed=distributionRoot();if(packed)configureDistribution(packed);
    const sourceBun = /^(bun|bun\.exe)$/i.test(basename(process.execPath)) ? process.execPath : null;
    const bun = process.platform === "win32" && existsSync(join(root, "../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe"))
      ? resolve(root, "../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe")
      : sourceBun ?? Bun.which("bun");
    if (!bun&&!packed) throw new CliError("BACKEND_UNAVAILABLE", "未找到隔离Bun运行时，请执行工具setup脚本", 3);
    const log = openSync(join(workspace, ".sfs", "service.log"), "a");
    try {
      const child = spawn(packed?join(packed,'runtime/sfs-service.exe'):bun!, packed?[]:[join(root, "apps/server/src/runtimeBootstrap.ts")], {
        cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log, log],
        env: { ...process.env, SFS_WORKSPACE: workspace, PORT: "0", NODE_ENV: "production" },
      });
      child.on("error", () => {});
      child.unref();
    } finally { closeSync(log); }
  }
  const deadline = Date.now() + 30000;
  do {
    const info = readService(workspace);
    if (info && await healthy(info)) return compatibleService(info);
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new CliError(existingOwner ? "WORKSPACE_LOCKED" : "BACKEND_UNAVAILABLE", `服务未就绪，请查看 ${join(workspace, ".sfs/service.log")}`, existingOwner ? 6 : 3);
}

export function errorExit(code: string | undefined): number {
  if (/REVISION|STALE|LOCKED|CONFLICT|BUSY|ALREADY_EXTRACTED|NOT_EMPTY|NOT_CANCELLABLE/.test(code ?? "")) return 6;
  if (/BACKEND|MODEL|DEPENDENCY/.test(code ?? "")) return 3;
  if (/REVIEW|WAITING_USER/.test(code ?? "")) return 4;
  if (/CANCEL/.test(code ?? "")) return 5;
  if (/INVALID|INPUT|NOT_FOUND|UNSUPPORTED/.test(code ?? "")) return 2;
  return 1;
}

export async function requestService(info: ServiceInfo, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${info.token}`);
  let response: Response;
  try { response = await fetch(info.url + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30000) }); }
  catch (error) { throw new CliError("BACKEND_UNAVAILABLE", `本地服务请求失败：${(error as Error).message}`, 3); }
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { throw new CliError("BACKEND_UNAVAILABLE", `服务返回非JSON (${response.status})`, 3); }
  if (!response.ok) throw new CliError(body.error?.code ?? "EXECUTION_ERROR", body.error?.message ?? `HTTP ${response.status}`, errorExit(body.error?.code), body);
  return body;
}

export async function waitJob(info: ServiceInfo, id: string, timeoutSeconds: number) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const body = await requestService(info, `/api/v1/jobs/${encodeURIComponent(id)}`);
    const status = body.status;
    if (["succeeded", "done", "failed", "error", "cancelled", "interrupted", "waiting_user"].includes(status)) {
      const exitCode = ["succeeded", "done"].includes(status) ? 0 : status === "cancelled" ? 5 : status === "waiting_user" ? 4 : errorExit(body.error?.code ?? body.data?.job?.error_code);
      return { body, exitCode };
    }
    await Bun.sleep(100);
  }
  throw new CliError("WAIT_TIMEOUT", "等待超时；任务仍在后台，可查询job status", 1);
}
