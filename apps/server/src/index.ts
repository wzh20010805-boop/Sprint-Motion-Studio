import { serve } from "bun";
import index from "../../web/index.html";
import { app } from "./app";
import { wsHandlers } from "./ws";
import { authorizeLocalRequest } from "./runtime";
import { db } from "./db";

const port = Number(process.env.PORT ?? 3000);
const token = process.env.SFS_SERVICE_TOKEN;
let lastActivity = Date.now();

export const server = serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": index,
    "/project/:id": index, // 编辑器页复用同一 HTML，前端读 location.pathname
    "/materials": index, // 素材库页同
    "/motions": index, // 动作工作台同
    "/settings": index, // 设置页同
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    lastActivity = Date.now();
    if (token) {
      const rejected = authorizeLocalRequest(req, token, `127.0.0.1:${server.port}`);
      if (rejected) return Response.json({ schema_version: "1.0", ok: false, status: "failed", error: { code: rejected === 401 ? "UNAUTHORIZED" : "INVALID_ORIGIN", message: "本地服务请求未授权" } }, { status: rejected });
      if (url.pathname === "/api/health") return Response.json({ ok: true, name: "Sprite Motion Studio", instance_id: process.env.SFS_INSTANCE_ID, pid: process.pid });
      if (url.pathname === "/api/config") return Response.json({
        sfs: { phase: "P1", extraction_mode: "all", matting_ready: false },
        matting: { engine: "none", model: "", hint: "P1仅完整抽帧，场景抠图等待P2模型准备", modelCached: false },
        imageLayers: { configured: false, model: "" }, gen: { providers: [] }, promptEnhancers: [], queueConcurrency: 2,
      });
      // SFS简化入口禁用云生成、可配置外部命令和上游宽权限MCP。
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") || /\/(generate|enhance-prompt|provider|doctor|layers|recommend-background)(\/|$)/.test(url.pathname)) {
        return Response.json({ ok: false, error: { code: "FEATURE_DISABLED", message: "P1本地模式未开放该功能" } }, { status: 403 });
      }
      if (/\/(matting|batch-matting)(\/|$)/.test(url.pathname)) {
        return Response.json({ ok: false, error: { code: "BACKEND_UNAVAILABLE", message: "P1尚未准备场景抠图后端，请在P2配置模型" } }, { status: 503 });
      }
      if (req.method === "POST" && ["/api/import/upload", "/api/materials/upload"].includes(url.pathname)) {
        const form = await req.clone().formData();
        if (form.get("autoMatting") === "true") return Response.json({ ok: false, error: { code: "MODEL_NOT_READY", message: "P1抠图模型尚未准备，请关闭自动抠图" } }, { status: 503 });
        const file = form.get("file");
        if (url.pathname === "/api/materials/upload" && file instanceof File && /\.(mp4|mov|webm|gif)$/i.test(file.name)) return Response.json({ ok: false, error: { code: "FEATURE_DISABLED", message: "请在项目的上传文件页选择全部原始帧；P1素材库视频采样入口尚未接入完整时序" } }, { status: 403 });
      }
      if (req.method === "POST" && /^\/api\/materials\/[^/]+\/extract$/.test(url.pathname)) return Response.json({ ok: false, error: { code: "FEATURE_DISABLED", message: "P1请从项目导入完整视频帧" } }, { status: 403 });
    }
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket 升级失败", { status: 400 });
    }
    return app.handle(req);
  },
  websocket: wsHandlers,
  // Bun 1.3 Windows 的浏览器 HMR 会打乱 PixiJS 聚合入口的循环依赖初始化顺序。
  // Windows 使用稳定的前端 bundle；bun --watch 仍会重启服务端，前端改动后手动刷新。
  development: process.env.NODE_ENV !== "production" && process.platform !== "win32",
});

console.log(`FrameBaker → http://127.0.0.1:${server.port}`);

if (token) {
  const idleMs = Math.max(1000, Number(process.env.SFS_IDLE_TIMEOUT_MS ?? 300000));
  setInterval(() => {
    const active = db.query("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')").get() as { n: number };
    if (Date.now() - lastActivity > idleMs && !active.n && !server.pendingWebSockets) {
      server.stop(true);
      process.exit(0);
    }
  }, Math.min(1000, idleMs));
}
