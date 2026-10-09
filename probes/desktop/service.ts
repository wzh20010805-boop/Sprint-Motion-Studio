import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 探针启动器仅组装上游模块，未重写业务、数据库或工作队列。
const backendRoot = process.env.P0_BACKEND_ROOT;
if (!backendRoot) throw new Error("P0_BACKEND_ROOT 必须由可信 Electron 主进程提供");
const { default: index } = await import(pathToFileURL(join(backendRoot, "apps/web/index.html")).href);
const { app } = await import(pathToFileURL(join(backendRoot, "apps/server/src/app.ts")).href);
const { wsHandlers } = await import(pathToFileURL(join(backendRoot, "apps/server/src/ws.ts")).href);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 0),
  routes: {
    "/": index,
    "/project/:id": index,
    "/materials": index,
    "/motions": index,
    "/settings": index,
  },
  fetch(req, server) {
    if (new URL(req.url).pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket 升级失败", { status: 400 });
    }
    return app.handle(req);
  },
  websocket: wsHandlers,
  development: false,
});
console.log(JSON.stringify({ event: "ready", url: server.url.href, pid: process.pid, bun: Bun.version, backendRoot }));
