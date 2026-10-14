// CLI/桌面共享的启动入口：取得工作区锁后才加载SQLite和队列。
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireServiceLock } from "./runtime";
import { initializeLocalSessions } from "./localSessions";
import { startDesktopReviewBroker } from "./desktopReviewBroker";
import { existsSync } from 'node:fs';
import { resolveWorkspace } from '../../cli/src/workspaces';

const root = resolve(process.env.SFS_REPO_ROOT ?? join(import.meta.dir, '../../..'));
const workspace = resolveWorkspace({repositoryRoot:root,distributionRoot:existsSync(join(root,'sfs-package.json'))?root:null});
const lock = acquireServiceLock(workspace);
process.env.SFS_WORKSPACE = workspace;
process.env.SFS_INSTANCE_ID = lock.instance_id;
process.env.SFS_SERVICE_TOKEN = randomBytes(32).toString("hex");
process.env.PORT ??= "0";
process.env.NODE_ENV ??= process.argv.includes('--development') ? 'development' : 'production';
initializeLocalSessions(lock.instance_id, process.env.SFS_SERVICE_TOKEN);
let broker: Awaited<ReturnType<typeof startDesktopReviewBroker>> | undefined;
let stopped = false;
process.on("exit", () => { broker?.close(); lock.release(); });
try {
  broker = await startDesktopReviewBroker(lock.instance_id);
  process.env.SFS_STARTUP_RECONCILE='1';
  const queue=await import('./queue');
  const {reconcileCollaborationOperations}=await import('./pipeline/collaboration/operations');
  await reconcileCollaborationOperations();
  queue.startQueue();
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
  broker?.close();
  lock.release();
  throw error;
}
