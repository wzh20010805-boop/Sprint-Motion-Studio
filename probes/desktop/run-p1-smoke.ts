import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(import.meta.dir, "../..");
const evidence = join(repo, "docs/evidence/p1/desktop-live");
// 每轮使用新的源运行时实例，不能把旧进程的前端 bundle 当成本轮源码。
const workspace = join(repo, "fixtures/generated/p1-desktop-workspace", `run-${Date.now()}`);
const video = join(repo, "fixtures/generated/P0 合成样例 (48帧).mp4");
const cli = join(repo, "apps/cli/src/index.ts");
const electron = join(import.meta.dir, "node_modules/electron/dist/electron.exe");
mkdirSync(evidence, { recursive: true });
if (!existsSync(video)) throw new Error("缺少已有48帧合成素材");
let commandIndex = 0;
const report: Record<string, any> = { startedAt: new Date().toISOString(), command: "bun probes/desktop/run-p1-smoke.ts", cwd: repo, bun: Bun.version, workspace, video, commands: [] };

function compareGuiCliSources(smoke: Record<string, any>) {
  const fields = ["source_index", "pts", "time_base", "presentation_time", "display_duration", "duration_origin", "decode_status"];
  const comparisonWorkspace = resolve(smoke.workspace);
  const workspaceRoot = join(repo, "fixtures/generated/p1-desktop-workspace");
  if (comparisonWorkspace !== workspaceRoot && !comparisonWorkspace.startsWith(`${workspaceRoot}\\`)) throw new Error("比较工作区不属于桌面探针");
  const sourceIds = { cli: smoke.cliExtraction?.sourceId, gui: smoke.gui?.scenario?.guiUpload?.sourceId };
  const sources = Object.fromEntries(Object.entries(sourceIds).map(([role, sourceId]) => {
    if (typeof sourceId !== "string" || !/^[a-f0-9-]{36}$/.test(sourceId)) throw new Error(`无效 ${role} source_id`);
    const directory = join(comparisonWorkspace, "sources", sourceId);
    const timingPath = join(directory, "timing.json");
    const timing = JSON.parse(readFileSync(timingPath, "utf8"));
    if (timing.source_id !== sourceId) throw new Error(`${role} timing.json 来源不一致`);
    return [role, { directory, timingPath, timing }];
  })) as Record<string, any>;
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const selectedTiming = (frame: Record<string, any>) => Object.fromEntries(fields.map(field => {
    if (!Object.hasOwn(frame, field)) throw new Error(`缺少帧字段 ${field}`);
    return [field, frame[field]];
  }));
  const mismatches: any[] = [];
  const frames = sources.cli.timing.frames.map((cliFrame: any, index: number) => {
    const guiFrame = sources.gui.timing.frames[index];
    if (!guiFrame) throw new Error(`GUI 缺少第 ${index} 帧`);
    const expectedFile = `raw/frame_${String(index).padStart(6, "0")}.png`;
    if (cliFrame.file !== expectedFile || guiFrame.file !== expectedFile) throw new Error(`第 ${index} 帧路径不符合原始帧目录`);
    const cliTiming = selectedTiming(cliFrame);
    const guiTiming = selectedTiming(guiFrame);
    const cliHash = sha256(join(sources.cli.directory, expectedFile));
    const guiHash = sha256(join(sources.gui.directory, expectedFile));
    const timingEqual = JSON.stringify(cliTiming) === JSON.stringify(guiTiming);
    const pngEqual = cliHash === guiHash;
    const sourceIndexContinuous = cliFrame.source_index === index && guiFrame.source_index === index;
    if (!timingEqual || !pngEqual || !sourceIndexContinuous) mismatches.push({ index, timingEqual, pngEqual, sourceIndexContinuous });
    return { index, cli: cliTiming, gui: guiTiming, timingEqual, cliPngSha256: cliHash, guiPngSha256: guiHash, pngEqual, sourceIndexContinuous };
  });
  const originalVideoHashes = { cli: sha256(join(sources.cli.directory, "original.mp4")), gui: sha256(join(sources.gui.directory, "original.mp4")) };
  const originalVideoEqual = originalVideoHashes.cli === originalVideoHashes.gui;
  const frameCounts = { cli: sources.cli.timing.frames.length, gui: sources.gui.timing.frames.length };
  const totalDuration = { cli: sources.cli.timing.duration, gui: sources.gui.timing.duration };
  const totalDurationEqual = JSON.stringify(totalDuration.cli) === JSON.stringify(totalDuration.gui);
  const equality = {
    checkedAt: new Date().toISOString(), command: `bun probes/desktop/run-p1-smoke.ts${process.argv.includes("--compare-only") ? " --compare-only" : ""}`, cwd: repo, bun: Bun.version,
    comparisonMode: "read existing source timing and PNG bytes; no service startup or GUI rerun", workspace: comparisonWorkspace,
    projectId: smoke.cliExtraction?.projectId, sourceIds, timingPaths: { cli: sources.cli.timingPath, gui: sources.gui.timingPath },
    comparedFields: fields, ignoredFields: ["source_id", "source_frame_id"], frameCounts, originalVideoHashes, originalVideoEqual,
    totalDuration, totalDurationEqual, allTimingEqual: frames.every((frame: any) => frame.timingEqual), allPngBytesEqual: frames.every((frame: any) => frame.pngEqual),
    sourceIndicesContinuous: frames.every((frame: any) => frame.sourceIndexContinuous), mismatches, frames,
    passed: frameCounts.cli === 48 && frameCounts.gui === 48 && originalVideoEqual && totalDurationEqual && mismatches.length === 0,
  };
  const equalityPath = join(evidence, "desktop-gui-cli-equality.json");
  writeFileSync(equalityPath, JSON.stringify(equality, null, 2));
  smoke.guiCliEquality = { evidence: equalityPath, checkedAt: equality.checkedAt, passed: equality.passed, frameCounts, originalVideoEqual, totalDuration, totalDurationEqual, allTimingEqual: equality.allTimingEqual, allPngBytesEqual: equality.allPngBytesEqual, sourceIndicesContinuous: equality.sourceIndicesContinuous, mismatchCount: mismatches.length };
  return equality;
}

async function runCli(args: string[]) {
  const argv = [process.execPath, cli, ...args, "--workspace", workspace, "--json"];
  const child = Bun.spawn(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const sequence = String(++commandIndex).padStart(2, "0");
  writeFileSync(join(evidence, `desktop-cli-${sequence}.stdout.json`), stdout);
  writeFileSync(join(evidence, `desktop-cli-${sequence}.stderr.log`), stderr);
  const body = JSON.parse(stdout.trim());
  report.commands.push({ argv, cwd: repo, exitCode, status: body.status, ok: body.ok, project_id: body.project_id, job_id: body.job_id });
  if (exitCode !== 0 || !body.ok) throw new Error(`CLI 失败: ${args.join(" ")}，退出 ${exitCode}: ${body.error?.message}`);
  return body;
}

if (process.argv.includes("--compare-only")) {
  const savedReportPath = join(evidence, "desktop-p1-smoke.json");
  const savedReport = JSON.parse(readFileSync(savedReportPath, "utf8"));
  const equality = compareGuiCliSources(savedReport);
  savedReport.passed = savedReport.passed && equality.passed;
  writeFileSync(savedReportPath, JSON.stringify(savedReport, null, 2));
  console.log(JSON.stringify(savedReport.guiCliEquality));
  if (!equality.passed) process.exitCode = 1;
} else {
try {
  const project = await runCli(["project", "create", "--name", `P1 desktop ${new Date().toISOString()}`]);
  const projectId = project.project_id;
  const source = await runCli(["import", "video", "--project", projectId, "--file", video]);
  const clip = await runCli(["clip", "create", "--project", projectId, "--source", source.data.source_id, "--name", "CLI 完整48帧动作"]);
  const extracted = await runCli(["extract", "--project", projectId, "--clip", clip.data.clip_id, "--mode", "all", "--wait", "--timeout", "60"]);
  report.cliExtraction = { projectId, sourceId: source.data.source_id, clipId: clip.data.clip_id, frameCount: extracted.data.job.result.frame_count, status: extracted.status };
  if (report.cliExtraction.frameCount !== 48) throw new Error("CLI 完整抽帧不是48帧");
  const before = await runCli(["project", "inspect", "--project", projectId]);
  const descriptor = JSON.parse(readFileSync(join(workspace, ".sfs/service.json"), "utf8"));
  report.service = { url: descriptor.url, pid: descriptor.pid, instance_id: descriptor.instance_id, workspace: descriptor.workspace };
  report.unauthenticatedApiStatus = (await fetch(`${descriptor.url}/api/v1/projects`)).status;
  report.unauthenticatedWsStatus = (await fetch(`${descriptor.url}/ws`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": Buffer.from("p1-smoke-ws-probe").toString("base64"), Origin: descriptor.url } })).status;
  const host = Bun.spawn([electron, import.meta.dir, "--smoke"], {
    cwd: repo, env: { ...process.env, SFS_SERVICE_URL: descriptor.url, SFS_SERVICE_TOKEN: descriptor.token, SFS_PROBE_PATH: `/project/${projectId}`, SFS_PROBE_SCENARIO: "p1-editor", SFS_PROBE_VIDEO_FILE: video, SFS_PROBE_REQUIRE_FULL_FRAMES: "1", P0_EVIDENCE_DIR: evidence, P0_PROFILE_DIR: join(workspace, ".sfs/desktop-profile") }, stdout: "pipe", stderr: "pipe",
  });
  const [hostExit, stdout, stderr] = await Promise.all([host.exited, new Response(host.stdout).text(), new Response(host.stderr).text()]);
  report.hostExit = hostExit;
  writeFileSync(join(evidence, "desktop-host.stdout.log"), stdout);
  writeFileSync(join(evidence, "desktop-host.stderr.log"), stderr);
  const desktopText = readFileSync(join(evidence, "desktop-report.json"), "utf8");
  const desktop = JSON.parse(desktopText);
  report.gui = { smokePassed: desktop.smokePassed, scenario: desktop.p1Scenario, authCookieAttributes: desktop.authCookieAttributes, websocket: desktop.renderer?.webSocketOk, serviceAliveAfterDetach: desktop.serviceAliveAfterDetach, error: desktop.error, console: desktop.console, blockedRequests: desktop.blockedRequests };
  report.noTokenInDesktopReport = !desktopText.includes(descriptor.token);
  const after = await runCli(["project", "inspect", "--project", projectId]);
  report.cliAfterGui = { projectId: after.project_id, initialRevision: before.data.project.revision, finalRevision: after.data.project.revision, sources: after.data.sources.length, clips: after.data.clips.map((clip: any) => ({ id: clip.id, status: clip.status, source_id: clip.source_id })) };
  const liveDescriptor = JSON.parse(readFileSync(join(workspace, ".sfs/service.json"), "utf8"));
  report.sameServiceAfterWindowClose = liveDescriptor.pid === descriptor.pid && liveDescriptor.instance_id === descriptor.instance_id && (await fetch(`${descriptor.url}/api/health`)).ok;
  const equality = compareGuiCliSources(report);
  report.passed = report.hostExit === 0 && report.gui.smokePassed && report.gui.scenario?.passed && report.gui.scenario?.guiUpload?.frames === 48 && report.gui.websocket && report.gui.serviceAliveAfterDetach && report.sameServiceAfterWindowClose && report.unauthenticatedApiStatus === 401 && report.unauthenticatedWsStatus === 401 && report.cliAfterGui.sources === 2 && report.cliAfterGui.clips.length === 2 && report.cliAfterGui.finalRevision > report.cliAfterGui.initialRevision && report.noTokenInDesktopReport && equality.passed;
} catch (error) { report.error = String(error); report.passed = false; }
report.completedAt = new Date().toISOString();
writeFileSync(join(evidence, "desktop-p1-smoke.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, hostExit: report.hostExit, cliFrames: report.cliExtraction?.frameCount, guiFrames: report.gui?.scenario?.guiUpload?.frames, unauthorizedApi: report.unauthenticatedApiStatus, unauthorizedWS: report.unauthenticatedWsStatus, servicePreserved: report.sameServiceAfterWindowClose, evidence, error: report.error, hostError: report.gui?.error }));
if (!report.passed) process.exitCode = 1;
}
