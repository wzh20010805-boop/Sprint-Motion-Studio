import { serve } from "bun";
import index from "../../web/index.html";
import { app } from "./app";
import { wsHandlers } from "./ws";
import { authenticateLocalRequest, validateLocalAuthority, LocalAuthError } from "./localSessions";
import { db } from "./db";
import { maskBackend } from './pipeline/masks';
import { PRODUCTION_API_VERSION } from '@framebaker/shared';
import { retainExistingImports } from './materialRetention';
import { backfillMaterialProjects } from './materialProjects';
import {MULTIPART_BODY_BYTES} from './mcp/request';

// 升级时先独立保留旧项目资料，用户以后删除库素材不会被重复补登记。
retainExistingImports();
backfillMaterialProjects(db);

const port = Number(process.env.PORT ?? 3000);
const token = process.env.SFS_SERVICE_TOKEN;
let lastActivity = Date.now();

export const server = serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize:MULTIPART_BODY_BYTES,
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
      try {
        validateLocalAuthority(req, `127.0.0.1:${server.port}`);
        if (url.pathname !== "/api/health") authenticateLocalRequest(req, `127.0.0.1:${server.port}`);
      } catch (error) {
        const failure = error instanceof LocalAuthError ? error : new LocalAuthError('UNAUTHORIZED', 401);
        return Response.json({ ok: false, error: { code: failure.code, message: "本地服务请求未授权" } }, { status: failure.status });
      }
      if (url.pathname === "/api/health") return Response.json({ ok: true, name: "Sprite Motion Studio", instance_id: process.env.SFS_INSTANCE_ID, pid: process.pid });
      if (url.pathname === "/api/config") return Response.json({
        sfs: { phase: "P5", production_api_version: PRODUCTION_API_VERSION, extraction_mode: "all", matting_ready: maskBackend().ready },
        matting: { engine: maskBackend().ready ? 'rembg-bundled' : 'none', model: 'u2netp', hint: maskBackend().ready ? null : '运行 scripts/setup_p2.ps1 准备本地模型；现有遮罩仍可修正', modelCached: maskBackend().ready },
        imageLayers: { configured: false, model: "" }, gen: { providers: [] }, promptEnhancers: [], queueConcurrency: 2,
      });
      // SFS简化入口禁用云生成、可配置外部命令和上游宽权限MCP。
      if (url.pathname.startsWith("/mcp/") || /\/(generate|enhance-prompt|provider|doctor|layers|recommend-background)(\/|$)/.test(url.pathname)) {
        return Response.json({ ok: false, error: { code: "FEATURE_DISABLED", message: "P1本地模式未开放该功能" } }, { status: 403 });
      }
      if (/\/(matting|batch-matting)(\/|$)/.test(url.pathname)) {
        return Response.json({ ok: false, error: { code: "USE_P2_MATTE", message: "请使用项目中的场景抠图与修正，批量任务通过 /api/v1/matte 提交" } }, { status: 409 });
      }
      if (req.method === "POST" && ["/api/import/upload", "/api/materials/upload"].includes(url.pathname)) {
        const form = await req.clone().formData();
        if (form.get("autoMatting") === "true") return Response.json({ ok: false, error: { code: "USE_P2_MATTE", message: "导入先保留原素材；请在项目中使用场景抠图与修正" } }, { status: 409 });
      }
      if (req.method === "POST" && /^\/api\/materials\/[^/]+\/extract$/.test(url.pathname)) {
        const payload = await req.clone().json().catch(() => ({}));
        const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        if (body.autoMatting) return Response.json({ ok: false, error: { code: 'USE_P2_MATTE', message: '请在项目中使用场景抠图与修正' } }, { status: 409 });
        if (Array.isArray(body.timestamps) && body.timestamps.length) return Response.json({ ok: false, error: { code: 'FEATURE_DISABLED', message: '桌面素材库保留完整原始帧，不支持定点采样' } }, { status: 409 });
      }
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
