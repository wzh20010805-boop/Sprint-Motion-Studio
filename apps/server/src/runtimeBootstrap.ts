// CLI/桌面共享的启动入口：取得工作区锁后才加载SQLite和队列。
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireServiceLock } from "./runtime";

const workspace = resolve(process.env.SFS_WORKSPACE ?? join(import.meta.dir, "../../..", "storage"));
const lock = acquireServiceLock(workspace);
process.env.SFS_WORKSPACE = workspace;
process.env.SFS_INSTANCE_ID = lock.instance_id;
process.env.SFS_SERVICE_TOKEN = randomBytes(32).toString("hex");
process.env.PORT ??= "0";
process.env.NODE_ENV ??= "production";
let stopped = false;
process.on("exit", () => lock.release());
try {
  const { server } = await import("./index");
  lock.publish(`http://127.0.0.1:${server.port}`, process.env.SFS_SERVICE_TOKEN);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  lock.release();
  throw error;
}
