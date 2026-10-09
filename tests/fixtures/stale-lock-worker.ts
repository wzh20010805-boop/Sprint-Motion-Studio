import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
const [workspace, role] = process.argv.slice(2) as [string,string];
const actual = { ...fs };
const lockPath = join(workspace, ".sfs", "service.lock");
let reads = 0;
function pauseUntil(paths: string[]) {
  const deadline = Date.now() + 10000;
  while (!paths.some(path=>actual.existsSync(path))) {
    if (Date.now() > deadline) throw new Error("barrier timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
// 只控制真实跨进程文件读取的时序；不伪造锁内容或成功结果。
mock.module("node:fs", () => ({ ...actual, readFileSync(path: any, ...args: any[]) {
  const result = (actual.readFileSync as any)(path, ...args);
  if (String(path) === lockPath && ++reads === 3) {
    actual.writeFileSync(join(workspace, role + ".checked"), "checked stale contents");
    if (role === "a") pauseUntil([join(workspace, "b.checked"),join(workspace,"b.rejected")]);
    else pauseUntil([join(workspace, "a.acquired"),join(workspace,"a.rejected")]);
  }
  return result;
} }));
const { acquireServiceLock } = await import("../../apps/server/src/runtime");
try {
  const lock = acquireServiceLock(workspace);
  actual.writeFileSync(join(workspace, role + ".acquired"), lock.instance_id);
  console.log(JSON.stringify({role, acquired: true, instance_id: lock.instance_id}));
  await Bun.sleep(500);
} catch (error) {
  actual.writeFileSync(join(workspace,role+".rejected"),String(error));
  console.log(JSON.stringify({role, acquired: false, error: String(error)}));
}
