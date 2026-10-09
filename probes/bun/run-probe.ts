import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const evidence = join(repo, "docs/evidence/p0");
mkdirSync(evidence, { recursive: true });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(), cwd: process.cwd(), runnerBun: Bun.version,
  command: "bun probes/bun/run-probe.ts", results: [],
};
const results = report.results as Record<string, unknown>[];

async function run(name: string, port: number, minimal = false) {
  const executable = join(import.meta.dir, "artifacts", minimal ? "bun-probe.exe" : "framebaker-upstream.exe");
  const dataRoot = join(import.meta.dir, "artifacts", "run-data");
  const child = Bun.spawn([executable], {
    cwd: join(import.meta.dir, "artifacts"),
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), P0_DATA_ROOT: dataRoot },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const result: Record<string, unknown> = { name, executable, port, pid: child.pid, launchCwd: join(import.meta.dir, "artifacts") };
  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break;
      try { health = await fetch(`http://127.0.0.1:${port}/api/health`); if (health.ok) break; } catch {}
      await Bun.sleep(100);
    }
    result.started = !!health?.ok;
    if (health?.ok) {
      result.health = await health.json();
      const paths = minimal ? ["/", "/resource.txt"] : ["/", "/pixi.min.js", "/fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2", "/imageops/imageOps.worker.js"];
      result.resources = [];
      for (const path of paths) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const bytes = await response.arrayBuffer();
        (result.resources as unknown[]).push({ path, status: response.status, bytes: bytes.byteLength, contentType: response.headers.get("content-type") });
      }
    }
  } catch (error) {
    result.error = String(error);
  } finally {
    if (child.exitCode === null) child.kill();
    result.exitCode = await child.exited;
    writeFileSync(join(evidence, `${name}.stdout.log`), await stdout);
    writeFileSync(join(evidence, `${name}.stderr.log`), await stderr);
    try { await fetch(`http://127.0.0.1:${port}/api/health`); result.portClosedAfterStop = false; }
    catch { result.portClosedAfterStop = true; }
    results.push(result);
    console.log(JSON.stringify(result));
  }
}

await run("bun-run", 43211, true);
const minimal = results[0];
// 编译文件应使用 Bun 虚拟目录；先用最小探针核验再运行未改造上游。
const moduleDir = String((minimal.health as any)?.moduleDir ?? "");
if (moduleDir.includes("~BUN") || moduleDir.includes("$bunfs")) await run("bun-upstream-run", 43212);
else results.push({ name: "bun-upstream-run", skipped: "未确认虚拟资源根目录，避免上游写到探针目录之外", moduleDir });
report.completedAt = new Date().toISOString();
writeFileSync(join(evidence, "bun-report.json"), JSON.stringify(report, null, 2));
if (!minimal.started || !(minimal.health as any)?.sqlite || !minimal.portClosedAfterStop) process.exitCode = 1;
