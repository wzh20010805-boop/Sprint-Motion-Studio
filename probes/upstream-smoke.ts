// P0：通过上游真实 HTTP API 留下可重开的合成项目，不进行质量批准。
import { join } from "node:path";
const base = "http://127.0.0.1:43187";
async function request(path: string, init?: RequestInit) {
  const r = await fetch(base + path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
}
const config = await request("/api/config");
const project = await request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "P0 合成基线 48帧→旧采样16帧" }) });
const body = new FormData();
body.set("projectId", project.id);
body.set("file", Bun.file(join(import.meta.dir, "..", "fixtures", "generated", "P0 合成样例 (48帧).mp4")));
body.set("type", "mp4");
body.set("autoMatting", "false");
const imported = await request("/api/import/upload", { method: "POST", body });
let job: any;
const deadline = Date.now() + 60000;
do {
  job = (await request(`/api/jobs/${imported.jobId}`)).job;
  if (["done", "error", "cancelled"].includes(job.status)) break;
  await Bun.sleep(100);
} while (Date.now() < deadline);
if (job.status !== "done") throw new Error(JSON.stringify(job));
const timeline = await request(`/api/projects/${project.id}/timeline`);
const frame = timeline.poolFrames[0];
const edit = await request(`/api/frames/${frame.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset_x: 3, duration: 2 }) });
const result = { upstreamCommit: "f9846c985156f83f750bcc654b56cae2a1960229", sample: "synthetic-testsrc2", originalFrames: 48, importedPoolCount: timeline.poolFrames.length, expectedLegacySampledCount: 16, projectId: project.id, job, editedFrame: edit.frame, matting: config.matting, gui: `${base}/project/${project.id}`, limitations: ["未安装模型；未进行真实角色抠图验收", "旧导入以8 FPS抽样，未保留完整48帧", "导出在浏览器Canvas；后续桌面探针验证"] };
await Bun.write(join(import.meta.dir, "..", "docs", "evidence", "p0", "upstream-smoke.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
