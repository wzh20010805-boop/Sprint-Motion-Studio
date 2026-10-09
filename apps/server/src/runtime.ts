import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

export interface ServiceInfo {
  schema_version: "1.0";
  instance_id: string;
  pid: number;
  started_at: string;
  workspace: string;
  url: string;
  token: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** 在导入db.ts之前加锁。失效锁只在原PID确定不存在时清除。 */
export function acquireServiceLock(workspace: string) {
  const directory = join(resolve(workspace), ".sfs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "service.lock");
  const infoPath = join(directory, "service.json");
  const recoveryPath = join(directory, "service.recovery");
  const instance_id = randomUUID();
  // 所有获取者先持有同一个排他恢复锁，覆盖核验、清理和新锁创建全过程。
  // 进程崩溃留下恢复锁时保守报错，由用户核查；不猜测并删除另一进程的锁。
  let recoveryFd: number;
  try { recoveryFd = openSync(recoveryPath, "wx", 0o600); } catch {
    throw new Error("WORKSPACE_LOCKED: 服务正在取得实例锁，或恢复锁需要人工检查");
  }
  try { writeFileSync(recoveryFd, JSON.stringify({ instance_id, pid: process.pid })); } finally { closeSync(recoveryFd); }
  try {
  if (existsSync(lockPath)) {
    const previousText = readFileSync(lockPath, "utf8");
    const previous = readJson(lockPath);
    if (!previous?.instance_id || !Number.isSafeInteger(previous.pid) || isProcessAlive(previous.pid)) {
      throw new Error("WORKSPACE_LOCKED: 工作区已有服务，或锁文件需要人工检查");
    }
    // 保留原锁的核验内容，避免盲目清理新的锁。
    if (readFileSync(lockPath, "utf8") !== previousText) throw new Error("WORKSPACE_LOCKED: 实例正在变化");
    unlinkSync(lockPath);
  }
  const owner = { instance_id, pid: process.pid, started_at: new Date().toISOString() };
  let descriptor: number;
  try { descriptor = openSync(lockPath, "wx", 0o600); } catch {
    throw new Error("WORKSPACE_LOCKED: 工作区已有服务");
  }
  try { writeFileSync(descriptor, JSON.stringify(owner)); } finally { closeSync(descriptor); }
  return {
    instance_id,
    publish(url: string, token: string): ServiceInfo {
      const info: ServiceInfo = { schema_version: "1.0", ...owner, workspace: resolve(workspace), url, token };
      writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
      return info;
    },
    release() {
      if (readJson(infoPath)?.instance_id === instance_id) unlinkSync(infoPath);
      if (readJson(lockPath)?.instance_id === instance_id) unlinkSync(lockPath);
    },
  };
  } finally {
    if (readJson(recoveryPath)?.instance_id === instance_id) unlinkSync(recoveryPath);
  }
}

function equalSecret(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 健康检查公开；其余API/WS以Bearer或HttpOnly本地Cookie鉴权。 */
export function authorizeLocalRequest(request: Request, token: string, authority: string): 401 | 403 | null {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  if (host !== authority || url.host !== authority) return 403;
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${authority}`) return 403;
  if (url.pathname === "/api/health") return null;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const cookie = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).find(v => v.startsWith("sfs_token="))?.slice(10) ?? "";
  return equalSecret(bearer, token) || equalSecret(cookie, token) ? null : 401;
}
