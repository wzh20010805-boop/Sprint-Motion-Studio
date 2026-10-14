import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const evidence = join(repo, "docs/evidence/playback-range");
const workspace = join(repo, "fixtures/generated/playback-workspace", `run-${Date.now()}`);
mkdirSync(evidence, { recursive: true });
const cli = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, join(repo, "apps/cli/src/index.ts"), ...args, "--workspace", workspace, "--json"], { cwd: repo, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit !== 0) throw new Error(`CLI失败: ${stderr} ${stdout}`);
  return JSON.parse(stdout);
};
const report: Record<string, any> = { startedAt: new Date().toISOString(), workspace };
try {
  const project = await cli(["project", "create", "--name", "预览范围隔离验证"]);
  const projectId = project.project_id;
  const source = await cli(["import", "video", "--project", projectId, "--file", join(repo, "fixtures/generated/P0 合成样例 (48帧).mp4")]);
  const clip = await cli(["clip", "create", "--project", projectId, "--source", source.data.source_id, "--name", "48帧"]);
  await cli(["extract", "--project", projectId, "--clip", clip.data.clip_id, "--mode", "all", "--wait"]);
  const service = JSON.parse(readFileSync(join(workspace, ".sfs/service.json"), "utf8"));
  const request = async (endpoint: string, patch?: any) => {
    const response = await fetch(`${service.url}${endpoint}`, { method: patch ? "PATCH" : "GET", headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json" }, body: patch ? JSON.stringify(patch) : undefined });
    if (!response.ok) throw new Error(`探针请求失败 ${endpoint}: ${response.status}`);
    return response.json();
  };
  const timeline: any = await request(`/api/projects/${projectId}/timeline`);
  await request(`/api/axes/${timeline.axis.id}`, { fps: 4 });
  await request(`/api/steps/${timeline.steps[1].id}`, { duration: 3 });
  const child = Bun.spawn([join(import.meta.dir, "node_modules/electron/dist/electron.exe"), import.meta.dir, "--smoke"], {
    cwd: repo, windowsHide: true, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SFS_WORKSPACE: workspace, SFS_SERVICE_URL: service.url, SFS_SERVICE_TOKEN: service.token, SFS_PROBE_PATH: `/project/${projectId}`, SFS_PROBE_SCENARIO: "playback-range", P0_EVIDENCE_DIR: evidence, P0_PROFILE_DIR: join(workspace, ".sfs/desktop-profile") },
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, "host.stdout.log"), stdout);
  writeFileSync(join(evidence, "host.stderr.log"), stderr);
  const desktop = JSON.parse(readFileSync(join(evidence, "desktop-report.json"), "utf8"));
  report.exit = exit;
  report.scenario = desktop.playbackScenario;
  report.error = desktop.error;
  report.passed = exit === 0 && desktop.smokePassed && desktop.playbackScenario?.passed;
} catch (error) { report.error = String(error); report.passed = false; }
report.completedAt = new Date().toISOString();
writeFileSync(join(evidence, "smoke.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
