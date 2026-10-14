import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { authenticateLocalRequest, clearLocalSessions, initializeLocalSessions, LocalAuthError } from "../../apps/server/src/localSessions";
const runtime = await import("../../apps/server/src/runtime").catch(() => ({})) as any;

const root = join(import.meta.dir, "../../fixtures/generated/runtime-tests", crypto.randomUUID());
mkdirSync(root, { recursive: true });

test("服务实例锁在加载业务数据库之前拒绝第二个写入者", () => {
  expect(typeof runtime.acquireServiceLock).toBe("function");
  const lock = runtime.acquireServiceLock(root);
  expect(() => runtime.acquireServiceLock(root)).toThrow("WORKSPACE_LOCKED");
  lock.release();
  const next = runtime.acquireServiceLock(root);
  next.release();
});

test("服务释放不能移除新实例的描述文件", () => {
  expect(typeof runtime.acquireServiceLock).toBe("function");
  const workspace = join(root, "ownership");
  const lock = runtime.acquireServiceLock(workspace);
  lock.publish("http://127.0.0.1:43219", "secret-test-value");
  const path = join(workspace, ".sfs", "service.json");
  const other = { instance_id: "another-instance", pid: process.pid, url: "http://127.0.0.1:43220" };
  writeFileSync(path, JSON.stringify(other));
  lock.release();
  expect(existsSync(path)).toBeTrue();
});

test("实际会话鉴权拒绝未授权API、其他Origin、Host和WebSocket", () => {
  const instance = crypto.randomUUID(), authority = "127.0.0.1:43219", url = `http://${authority}/api/v1/projects`;
  initializeLocalSessions(instance, "token");
  const authorize = (request: Request) => {
    try { return authenticateLocalRequest(request, authority).role; }
    catch (error) { if (error instanceof LocalAuthError) return error.status; throw error; }
  };
  try {
    expect(authorize(new Request(url))).toBe(401);
    expect(authorize(new Request(url, { headers: { authorization: "Bearer token" } }))).toBe("maker");
    expect(authorize(new Request(url, { headers: { cookie: "sfs_token=token", origin: `http://${authority}` } }))).toBe("maker");
    expect(authorize(new Request(url, { headers: { authorization: "Bearer token", origin: "https://evil.example" } }))).toBe(403);
    expect(authorize(new Request(url, { headers: { authorization: "Bearer token", host: "evil.example" } }))).toBe(403);
    expect(authorize(new Request(`http://${authority}/ws`))).toBe(401);
    expect(authorize(new Request(url, { headers: { cookie: "sfs_token=wrong" } }))).toBe(401);
  } finally { clearLocalSessions(instance); }
});

test("两个进程并发恢复失效锁时只有一个持有者", async () => {
  const workspace = join(root,"stale-concurrent");
  mkdirSync(join(workspace,".sfs"),{recursive:true});
  writeFileSync(join(workspace,".sfs/service.lock"),JSON.stringify({instance_id:"dead-owner",pid:2147483647}));
  const results = await Promise.all(["a","b"].map(async role=>{
    const child=Bun.spawn([process.execPath,join(import.meta.dir,"../fixtures/stale-lock-worker.ts"),workspace,role],{stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stderr}).toEqual({exit:0,stderr:""});
    return JSON.parse(stdout);
  }));
  expect(results.filter(result=>result.acquired).length).toBe(1);
},20000);
