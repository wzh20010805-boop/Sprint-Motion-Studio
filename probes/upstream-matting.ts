// 复现无引擎伪成功，仅用于P0隔离合成样例。
const base = "http://127.0.0.1:43187";
const sample = await Bun.file("docs/evidence/p0/upstream-smoke.json").json();
const raw = await (await fetch(`${base}/api/frames/${sample.editedFrame.id}/image?type=raw`)).blob();
const form = new FormData();
form.set("file", raw, "P0_engine_missing.png");
const uploaded = await (await fetch(`${base}/api/materials/upload`, { method: "POST", body: form })).json() as any;
const matted = await (await fetch(`${base}/api/materials/${uploaded.materialId}/matting`, { method: "POST" })).json() as any;
let job: any;
for (let i = 0; i < 100; i++) {
  job = (await (await fetch(`${base}/api/jobs/${matted.jobId}`)).json() as any).job;
  if (["done", "error"].includes(job?.status)) break;
  await Bun.sleep(100);
}
const material = ((await (await fetch(`${base}/api/materials`)).json()) as any).materials.find((m: any) => m.id === uploaded.materialId);
const result = { engine: "none", model_downloaded: false, job, material, result: "上游缺引擎仍标记完成；不是抠图成功" };
await Bun.write("docs/evidence/p0/matting-missing.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
