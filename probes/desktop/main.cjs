const { app, BrowserWindow, session } = require("electron");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// P0 探针：仅验证受限渲染器、真实上游服务、路径和生命周期。
const probeRoot = __dirname;
const packageRoot = path.resolve(process.resourcesPath, "..");
const packed = fs.existsSync(path.join(packageRoot, "runtime", "bun.exe"));
const runtime = packed ? path.join(packageRoot, "runtime", "bun.exe") : path.resolve(probeRoot, "../../../.runtime/node_modules/@oven/bun-windows-x64/bin/bun.exe");
const backendRoot = packed ? path.join(packageRoot, "runtime", "backend") : path.join(probeRoot, "snapshot");
const evidenceRoot = path.resolve(process.env.P0_EVIDENCE_DIR || path.join(probeRoot, "artifacts", "evidence"));
const profile = path.resolve(process.env.P0_PROFILE_DIR || path.join(probeRoot, "artifacts", "profile"));
const smoke = process.argv.includes("--smoke");
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-background-timer-throttling");

let child, window, origin, quitting = false, childExited = false;
const report = { startedAt: new Date().toISOString(), command: process.argv, cwd: process.cwd(), packageRoot, packed, runtime, backendRoot, profile, versions: process.versions, events: [], console: [], blockedRequests: [] };
const event = (kind, details = {}) => report.events.push({ kind, at: new Date().toISOString(), ...details });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function startBackend() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("后端启动超过 30 秒")), 30000);
    const stdout = fs.createWriteStream(path.join(evidenceRoot, "desktop-backend.stdout.log"));
    const stderr = fs.createWriteStream(path.join(evidenceRoot, "desktop-backend.stderr.log"));
    child = spawn(runtime, [path.join(probeRoot, "service.ts")], {
      cwd: backendRoot, windowsHide: true, shell: false,
      env: { ...process.env, P0_BACKEND_ROOT: backendRoot, NODE_ENV: "production", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    event("backend-spawn", { pid: child.pid });
    let text = "";
    child.stdout.on("data", chunk => {
      stdout.write(chunk); text += chunk.toString();
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline === -1) break;
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        try {
          const ready = JSON.parse(line);
          if (ready.event === "ready") {
            clearTimeout(timeout); report.backend = ready; origin = new URL(ready.url).origin;
            event("backend-ready", ready); resolve(ready);
          }
        } catch {}
      }
    });
    child.stderr.on("data", chunk => stderr.write(chunk));
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => { childExited = true; clearTimeout(timeout); stdout.end(); stderr.end(); event("backend-exit", { code, signal }); if (!origin) reject(new Error(`后端提前退出: ${code}/${signal}`)); });
  });
}

async function stopBackend() {
  if (!child || childExited) return;
  event("backend-stop-requested", { pid: child.pid });
  child.kill();
  for (let i = 0; i < 100 && !childExited; i++) await delay(50);
  if (!childExited) throw new Error("探针后端未在 5 秒内停止");
  try { await fetch(`${origin}/api/health`); report.portClosedAfterStop = false; }
  catch { report.portClosedAfterStop = true; }
}

async function run() {
  await app.whenReady();
  await startBackend();
  const health = await fetch(`${origin}/api/health`);
  report.health = { status: health.status, body: await health.json() };
  const html = await (await fetch(`${origin}/materials`)).text();
  // 保留上游首屏主题/语言脚本，以内容哈希授权内联代码。
  const hashes = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
    .map(match => match[1].replace(/\r\n?/g, "\n")).filter(Boolean)
    .map(script => `'sha256-${createHash("sha256").update(script).digest("base64")}'`);
  const csp = `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${origin.replace("http:", "ws:")}; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'self'`;
  report.csp = csp;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`) || details.url.startsWith(`${origin.replace("http:", "ws:")}/`) || details.url.startsWith("data:") || details.url.startsWith("blob:");
    if (!allowed) report.blockedRequests.push({ url: details.url, resourceType: details.resourceType });
    callback({ cancel: !allowed });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } }));
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1360, height: 900, show: !smoke, autoHideMenuBar: true, title: "FrameBaker P0 本机探针", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
  window.webContents.on("console-message", (consoleEvent) => report.console.push({ level: consoleEvent.level, message: consoleEvent.message }));
  window.webContents.on("render-process-gone", (_event, details) => event("renderer-gone", details));
  report.preferences = window.webContents.getLastWebPreferences();
  await window.loadURL(`${origin}/materials`);
  event("page-loaded", { url: window.webContents.getURL() });
  await delay(1500);
  report.renderer = await window.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    const resources = [];
    for (const pathname of ['/api/health','/pixi.min.js','/fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2','/imageops/imageOps.worker.js']) {
      const response = await fetch(pathname); const data = await response.arrayBuffer();
      resources.push({pathname,status:response.status,bytes:data.byteLength,contentType:response.headers.get('content-type')});
    }
    const webSocketOk = await new Promise(resolve => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws');
      const timer = setTimeout(() => { socket.close(); resolve(false); }, 1500);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(true); };
      socket.onerror = () => { clearTimeout(timer); resolve(false); };
    });
    return { title:document.title, rootText:document.querySelector('#root')?.innerText, requireType:typeof require, processType:typeof process, globalType:typeof global, fontsStatus:document.fonts.status, webSocketOk, resources };
  })()`);
  const screenshot = await window.webContents.capturePage();
  const screenshotPath = path.join(evidenceRoot, "desktop-framebaker.png");
  fs.writeFileSync(screenshotPath, screenshot.toPNG());
  report.screenshot = { path: screenshotPath, size: screenshot.getSize(), bytes: fs.statSync(screenshotPath).size };
  const r = report.renderer;
  report.smokePassed = report.health.status === 200 && r.rootText?.length > 20 && r.requireType === "undefined" && r.processType === "undefined" && r.webSocketOk && r.resources.every(resource => resource.status === 200 && resource.bytes > 0) && report.preferences.contextIsolation && report.preferences.sandbox && !report.preferences.nodeIntegration && report.screenshot.bytes > 10000 && report.blockedRequests.length === 0 && !report.console.some(message => message.level === "error" || message.level === 3);
  event("smoke-completed", { passed: report.smokePassed });
  if (smoke) { window.destroy(); await finish(report.smokePassed ? 0 : 1); }
  else window.on("closed", () => finish(0));
}

async function finish(exitCode) {
  if (quitting) return;
  quitting = true;
  try { await stopBackend(); } catch (error) { report.stopError = String(error); exitCode = 1; }
  if (smoke && !report.portClosedAfterStop) exitCode = 1;
  report.completedAt = new Date().toISOString(); report.exitCode = exitCode;
  fs.writeFileSync(path.join(evidenceRoot, "desktop-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ smokePassed: report.smokePassed, portClosedAfterStop: report.portClosedAfterStop, exitCode, evidenceRoot }));
  app.exit(exitCode);
}

// 窗口销毁不能抢先把失败烟测改写为成功退出。
app.on("window-all-closed", () => {});
app.on("before-quit", e => { if (!quitting) { e.preventDefault(); finish(0); } });
run().catch(error => { report.error = error.stack || String(error); console.error(error); finish(1); });
