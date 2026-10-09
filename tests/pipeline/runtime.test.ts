import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

test("鉴权拒绝未授权API、其他Origin、Host和WebSocket", () => {
  expect(typeof runtime.authorizeLocalRequest).toBe("function");
  const authorize = runtime.authorizeLocalRequest;
  const url = "http://127.0.0.1:43219/api/v1/projects";
  expect(authorize(new Request(url), "token", "127.0.0.1:43219")).toBe(401);
  expect(authorize(new Request(url, { headers: { authorization: "Bearer token" } }), "token", "127.0.0.1:43219")).toBeNull();
  expect(authorize(new Request(url, { headers: { cookie: "sfs_token=token", origin: "http://127.0.0.1:43219" } }), "token", "127.0.0.1:43219")).toBeNull();
  expect(authorize(new Request(url, { headers: { authorization: "Bearer token", origin: "https://evil.example" } }), "token", "127.0.0.1:43219")).toBe(403);
  expect(authorize(new Request(url, { headers: { authorization: "Bearer token", host: "evil.example" } }), "token", "127.0.0.1:43219")).toBe(403);
  expect(authorize(new Request("http://127.0.0.1:43219/ws"), "token", "127.0.0.1:43219")).toBe(401);
  expect(authorize(new Request(url, { headers: { cookie: "sfs_token=wrong" } }), "token", "127.0.0.1:43219")).toBe(401);
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
