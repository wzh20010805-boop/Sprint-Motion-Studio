const { app, BrowserWindow, session, Menu, dialog } = require("electron");
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
const externalService = process.env.SFS_SERVICE_URL;
const externalToken = process.env.SFS_SERVICE_TOKEN;
const pagePath = process.env.SFS_PROBE_PATH || "/materials";
if (!/^\/(?:materials|settings|motions|project\/[\w-]+)?$/.test(pagePath)) throw new Error("SFS_PROBE_PATH 必须是受支持的本地页面路径");
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-background-timer-throttling");

let desktopSession;
let child, window, origin, quitting = false, childExited = false;
const report = { startedAt: new Date().toISOString(), command: process.argv, cwd: process.cwd(), packageRoot, packed, runtime, backendRoot, profile, pagePath, serviceManagement: externalService ? "attach-existing" : "owned-p0-child", versions: process.versions, events: [], console: [], blockedRequests: [] };
const event = (kind, details = {}) => report.events.push({ kind, at: new Date().toISOString(), ...details });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const serviceFetch = url => fetch(url, externalToken ? { headers: { Authorization: `Bearer ${externalToken}` } } : undefined);
async function saveScreenshot(name) {
  const screenshot = await window.webContents.capturePage();
  const screenshotPath = path.join(evidenceRoot, name);
  fs.writeFileSync(screenshotPath, screenshot.toPNG());
  return { path: screenshotPath, size: screenshot.getSize(), bytes: fs.statSync(screenshotPath).size };
}

async function runP1EditorScenario() {
  if (!externalService || !pagePath.startsWith("/project/")) throw new Error("P1 场景需要显式附着项目页面");
  const projectId = pagePath.slice("/project/".length);
  const readJson = async endpoint => {
    const response = await serviceFetch(`${origin}${endpoint}`);
    if (!response.ok) throw new Error(`P1 场景请求失败 ${response.status}: ${endpoint}`);
    return response.json();
  };
  const scenario = report.p1Scenario = { projectId, steps: [] };
  const initial = await readJson(`/api/projects/${projectId}/timeline`);
  const before = await readJson(`/api/v1/projects/${projectId}`);
  const config = await readJson("/api/config");
  scenario.phase = config.sfs?.phase;
  scenario.initialFrames = initial.frames.length;
  scenario.initialRevision = before.data.project.revision;
  scenario.protectedApiStatus = await window.webContents.executeJavaScript("fetch('/api/v1/projects').then(response => response.status)");
  scenario.editorScreenshot = await saveScreenshot("desktop-p1-editor.png");
  const clickButton = async (selector, text) => {
    const clicked = await window.webContents.executeJavaScript(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.innerText.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) return false; button.click(); return true; })()`);
    if (!clicked) throw new Error(`找不到可点击的界面按钮: ${text}`);
    await delay(350);
    scenario.steps.push({ action: "click", text });
  };
  await clickButton(".topbar button", "导入素材");
  await clickButton(".import-modal .import-tabs button", "上传文件");
  const importDefaultsScript = `(() => {
    const modal = document.querySelector('.import-modal');
    const select = modal?.querySelector('[data-testid="sfs-extraction-mode"] select');
    return { mode:select?.value, selectedLabel:select?.selectedOptions[0]?.textContent, noCheckedMatting:![...(modal?.querySelectorAll('input[type=checkbox]') || [])].some(input => input.checked), mattingPending:modal?.innerText.includes('等待 P2'), tabs:[...(modal?.querySelectorAll('.import-tabs button') || [])].map(b => ({text:b.innerText,disabled:b.disabled})) };
  })()`;
  for (let attempt = 0; attempt < 50; attempt++) {
    scenario.importDefaults = await window.webContents.executeJavaScript(importDefaultsScript);
    if (scenario.importDefaults.mattingPending && scenario.importDefaults.tabs.some(tab => tab.text === "生成" && tab.disabled)) break;
    await delay(100);
  }
  scenario.importScreenshot = await saveScreenshot("desktop-p1-import-defaults.png");
  report.renderer.fullFrameOptionVisible = scenario.importDefaults.mode === "all";
  if (scenario.phase !== "P1" || scenario.protectedApiStatus !== 200 || scenario.initialFrames !== 48 || scenario.importDefaults.mode !== "all" || !scenario.importDefaults.noCheckedMatting || !scenario.importDefaults.mattingPending) throw new Error("P1 默认导入/鉴权/48帧基线断言失败");

  const video = process.env.SFS_PROBE_VIDEO_FILE;
  if (video) {
    if (!path.isAbsolute(video) || !fs.existsSync(video)) throw new Error("SFS_PROBE_VIDEO_FILE 必须是已存在的绝对路径");
    window.webContents.debugger.attach("1.3");
    try {
      const document = await window.webContents.debugger.sendCommand("DOM.getDocument");
      const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: document.root.nodeId, selector: ".import-modal input[type=file]" });
      if (!nodeId) throw new Error("导入文件输入框不存在");
      await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [video] });
    } finally { window.webContents.debugger.detach(); }
    await delay(400);
    await clickButton(".import-modal .modal-actions button", "导入 1 个文件");
    const previous = new Set(before.data.clips.map(clip => clip.id));
    let imported;
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = await readJson(`/api/v1/projects/${projectId}`);
      imported = current.data.clips.find(clip => !previous.has(clip.id) && clip.status === "extracted");
      if (imported) break;
      await delay(300);
    }
    if (!imported) throw new Error("实际 GUI 视频导入未在 45 秒内完成");
    const importedTimeline = await readJson(`/api/projects/${projectId}/timeline?axisId=${encodeURIComponent(imported.axis_id)}`);
    scenario.guiUpload = { clipId: imported.id, sourceId: imported.source_id, frames: importedTimeline.frames.length, steps: importedTimeline.steps.length, statuses: [...new Set(importedTimeline.frames.map(frame => frame.status))] };
    for (let attempt = 0; attempt < 30; attempt++) {
      const finished = await window.webContents.executeJavaScript("[...document.querySelectorAll('.import-modal .modal-actions button')].some(b => b.innerText.trim() === '完成，关闭面板')");
      if (finished) break;
      await delay(100);
    }
    scenario.uploadScreenshot = await saveScreenshot("desktop-p1-upload-complete.png");
    await clickButton(".import-modal .modal-actions button", "完成，关闭面板");
    if (scenario.guiUpload.frames !== 48 || scenario.guiUpload.steps !== 48 || scenario.guiUpload.statuses.some(status => status === "matted")) throw new Error("GUI 完整48帧/未抠图状态断言失败");
  } else await clickButton(".import-modal button", "关闭");

  const clickedCell = await window.webContents.executeJavaScript("(() => { const cell = document.querySelector('.tl-cell.draggable'); if (!cell) return false; cell.click(); return true; })()");
  if (!clickedCell) throw new Error("找不到真实时间轴帧单元格");
  const stepId = initial.steps[0].id;
  const originalDuration = initial.steps[0].duration;
  await delay(100);
  await clickButton(".tl-controls button", "+ 时长");
  let edited;
  for (let attempt = 0; attempt < 30; attempt++) {
    const timeline = await readJson(`/api/projects/${projectId}/timeline?axisId=${encodeURIComponent(initial.axis.id)}`);
    edited = timeline.steps.find(step => step.id === stepId);
    if (edited?.duration === originalDuration + 1) break;
    await delay(100);
  }
  await window.loadURL(`${origin}${pagePath}`);
  await delay(900);
  const reopened = await window.webContents.executeJavaScript("({firstStep:document.querySelector('.tl-step small')?.textContent,canvasCount:document.querySelectorAll('.pixi-wrap canvas').length,projectName:document.querySelector('.proj-name')?.textContent})");
  const after = await readJson(`/api/v1/projects/${projectId}`);
  scenario.edit = { stepId, originalDuration, savedDuration: edited?.duration, reopened, revision: after.data.project.revision, persisted: edited?.duration === originalDuration + 1 && reopened.firstStep === `×${originalDuration + 1}` && reopened.canvasCount > 0 };
  scenario.reopenedScreenshot = await saveScreenshot("desktop-p1-editor-reopened.png");
  scenario.passed = scenario.edit.persisted && scenario.edit.revision > scenario.initialRevision;
  if (!scenario.passed) throw new Error("真实页面编辑/保存/重开断言失败");
}

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
  if (externalService) {
    report.externalServicePreserved = true;
    report.serviceAliveAfterDetach = (await serviceFetch(`${origin}/api/health`)).ok;
    event("external-service-detached", { serviceAlive: report.serviceAliveAfterDetach });
    return;
  }
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
  if (externalService) {
    const address = new URL(externalService);
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || !address.port || address.username || address.password || address.search || address.hash || address.pathname !== "/") throw new Error("SFS_SERVICE_URL 必须是明确的 127.0.0.1 HTTP 服务根地址");
    origin = address.origin;
    report.backend = { url: `${origin}/`, owned: false };
    if (!process.env.SFS_WORKSPACE || !externalToken) throw new Error("DESKTOP_SERVICE_IDENTITY");
    const { initializeDesktopSession } = require("../../apps/desktop/review-bootstrap.cjs");
    const attached = await initializeDesktopSession(session, process.env.SFS_WORKSPACE, { url: origin, token: externalToken });
    if (attached.info.url !== origin || attached.info.token !== externalToken) throw new Error("DESKTOP_SERVICE_IDENTITY");
    desktopSession = attached.session;
    report.authCookieConfigured = true;
    report.reviewerSessionConfigured = true;
    event("external-service-attached", { url: `${origin}/`, cookieConfigured: !!externalToken });
  } else { await startBackend(); desktopSession = session.defaultSession; }
  const health = await serviceFetch(`${origin}/api/health`);
  report.health = { status: health.status, body: await health.json() };
  const html = await (await serviceFetch(`${origin}${pagePath}`)).text();
  // 保留上游首屏主题/语言脚本，以内容哈希授权内联代码。
  const hashes = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
    .map(match => match[1].replace(/\r\n?/g, "\n")).filter(Boolean)
    .map(script => `'sha256-${createHash("sha256").update(script).digest("base64")}'`);
  const csp = `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data: blob: ${origin.replace("http:", "ws:")}; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'self'`;
  report.csp = csp;
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`) || details.url.startsWith(`${origin.replace("http:", "ws:")}/`) || details.url.startsWith("data:") || details.url.startsWith("blob:");
    if (!allowed) report.blockedRequests.push({ url: details.url, resourceType: details.resourceType });
    callback({ cancel: !allowed });
  });
  desktopSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } }));
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1360, height: 900, show: !smoke, autoHideMenuBar: false, title: "素材创意工坊 · Sprite Motion Studio", webPreferences: { session: desktopSession, contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true, backgroundThrottling: false, offscreen: smoke && ["p1-editor", "playback-range", "p2-masks", "onion-preview", "material-retention"].includes(process.env.SFS_PROBE_SCENARIO) } });
  if (externalService) {
    const { createWorkspaceCli } = require("./workspace-cli.cjs");
    const { installWorkspaceMenu } = require("./workspace-menu.cjs");
    const runCli = createWorkspaceCli({ runtime, repositoryRoot: process.env.SFS_REPO_ROOT || path.resolve(probeRoot, "../..") });
    const menu = await installWorkspaceMenu({
      Menu, dialog, window, workspace: process.env.SFS_WORKSPACE, runCli,
      onSwitched: target => event("workspace-opened", { workspace: target }),
      onError: error => dialog.showErrorBox("工作区切换失败", error.message || String(error)),
    });
    window.setMenuBarVisibility(true);
    report.workspaceMenu = { pid: process.pid, visible: window.isMenuBarVisible(), switchLabel: Menu.getApplicationMenu()?.getMenuItemById("switch-workspace")?.label, workspace: process.env.SFS_WORKSPACE, currentName: menu.currentName, pagePath };
    const title = `素材创意工坊 · Sprite Motion Studio — ${menu.currentName}`;
    window.on("page-title-updated", event => { event.preventDefault(); window.setTitle(title); });
    window.setTitle(title);
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); });
  window.webContents.on("console-message", (consoleEvent) => report.console.push({ level: consoleEvent.level, message: consoleEvent.message }));
  window.webContents.on("render-process-gone", (_event, details) => event("renderer-gone", details));
  report.preferences = window.webContents.getLastWebPreferences();
  await window.loadURL(`${origin}${pagePath}`);
  event("page-loaded", { url: window.webContents.getURL() });
  if (report.workspaceMenu) fs.writeFileSync(path.join(evidenceRoot, "workspace-menu.json"), JSON.stringify(report.workspaceMenu, null, 2));
  if (process.env.SFS_TEST_VISIBLE_START === "1") {
    report.visibleStart = { visible: window.isVisible(), minimized: window.isMinimized(), bounds: window.getBounds() };
    event("visible-start", report.visibleStart);
    window.destroy();
    await finish(report.visibleStart.visible ? 0 : 1);
    return;
  }
  // 日常窗口不执行开发烟测；远程桌面或暂不可截图时仍应保留用户的编辑窗口。
  if (!smoke && !process.env.SFS_PROBE_SCENARIO) {
    window.on("closed", () => finish(0));
    return;
  }
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
    const rootText = document.querySelector('#root')?.innerText;
    return { title:document.title, rootText, fullFrameOptionVisible:/完整.*逐帧|完整抽帧|全部帧/.test(rootText || ''), buttonLabels:[...document.querySelectorAll('button')].map(b => b.innerText || b.title).filter(Boolean), requireType:typeof require, processType:typeof process, globalType:typeof global, fontsStatus:document.fonts.status, webSocketOk, resources };
  })()`);
  if (process.env.SFS_PROBE_SCENARIO === "p1-editor") await runP1EditorScenario();
  if (process.env.SFS_PROBE_SCENARIO === 'p2-masks') report.p2Scenario=await require('./p2-scenario.cjs')({window,origin,pagePath,serviceFetch,saveScreenshot,delay});
  if (process.env.SFS_PROBE_SCENARIO === 'onion-preview') report.onionScenario=await require('./onion-scenario.cjs')({window,saveScreenshot,delay});
  if (process.env.SFS_PROBE_SCENARIO === 'material-retention') report.materialRetentionScenario=await require('./material-retention-scenario.cjs')({window,origin,pagePath,serviceFetch,saveScreenshot,delay});
  if (process.env.SFS_PROBE_SCENARIO === "playback-range") {
    report.playbackScenario = await require("./playback-scenario.cjs")({ window, origin, pagePath, serviceFetch, saveScreenshot, delay });
  }
  const screenshot = await window.webContents.capturePage();
  const screenshotPath = path.join(evidenceRoot, "desktop-framebaker.png");
  fs.writeFileSync(screenshotPath, screenshot.toPNG());
  report.screenshot = { path: screenshotPath, size: screenshot.getSize(), bytes: fs.statSync(screenshotPath).size };
  const r = report.renderer;
  report.smokePassed = report.health.status === 200 && r.rootText?.length > 20 && r.requireType === "undefined" && r.processType === "undefined" && r.webSocketOk && r.resources.every(resource => resource.status === 200 && resource.bytes > 0) && report.preferences.contextIsolation && report.preferences.sandbox && !report.preferences.nodeIntegration && report.screenshot.bytes > 10000 && report.blockedRequests.length === 0 && !report.console.some(message => message.level === "error" || message.level === 3);
  if (process.env.SFS_PROBE_REQUIRE_FULL_FRAMES === "1") report.smokePassed = report.smokePassed && r.fullFrameOptionVisible;
  event("smoke-completed", { passed: report.smokePassed });
  if (smoke) { window.destroy(); await finish(report.smokePassed ? 0 : 1); }
  else window.on("closed", () => finish(0));
}

async function finish(exitCode) {
  if (quitting) return;
  quitting = true;
  try { await stopBackend(); } catch (error) { report.stopError = String(error); exitCode = 1; }
  if (smoke && (externalService ? !report.serviceAliveAfterDetach : !report.portClosedAfterStop)) exitCode = 1;
  report.completedAt = new Date().toISOString(); report.exitCode = exitCode;
  fs.writeFileSync(path.join(evidenceRoot, "desktop-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ smokePassed: report.smokePassed, portClosedAfterStop: report.portClosedAfterStop, exitCode, evidenceRoot }));
  app.exit(exitCode);
}

// 窗口销毁不能抢先把失败烟测改写为成功退出。
app.on("window-all-closed", () => {});
app.on("before-quit", e => { if (!quitting) { e.preventDefault(); finish(0); } });
run().catch(error => { report.error = error.stack || String(error); console.error(error); finish(1); });
