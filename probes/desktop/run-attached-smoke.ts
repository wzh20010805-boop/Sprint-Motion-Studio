import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// 只启动并回收本脚本拥有的 P0 fixture；用于验证附着模式不会停止既有服务。
const probe = import.meta.dir;
const repo = resolve(probe, "../..");
const packageRoot = join(probe, "artifacts/framebaker-p0-win-x64");
const evidence = join(repo, "docs/evidence/p0/desktop-attach");
mkdirSync(evidence, { recursive: true });
const backendRoot = join(packageRoot, "runtime/backend");
const child = Bun.spawn([join(packageRoot, "runtime/bun.exe"), join(packageRoot, "resources/app/service.ts")], {
  cwd: backendRoot, env: { ...process.env, P0_BACKEND_ROOT: backendRoot, PORT: "0", NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe",
});
const errorLog = new Response(child.stderr).text();
let backendLog = "", readyResolve: (value: any) => void;
const ready = new Promise<any>(resolve => { readyResolve = resolve; });
const reading = (async () => {
  const reader = child.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    backendLog += new TextDecoder().decode(value);
    for (const line of backendLog.split("\n")) {
      try { const event = JSON.parse(line); if (event.event === "ready") readyResolve(event); } catch {}
    }
  }
})();
const test: Record<string, unknown> = { command: "bun probes/desktop/run-attached-smoke.ts", startedAt: new Date().toISOString(), fixture: "P0 上游服务，无鉴权；P1 真实鉴权由根任务另测", servicePid: child.pid };
let bootTimer: ReturnType<typeof setTimeout>;
try {
  const timeout = new Promise<never>((_, reject) => { bootTimer = setTimeout(() => reject(new Error("fixture 启动超时")), 30000); });
  const service = await Promise.race([ready, timeout]);
  clearTimeout(bootTimer);
  const electron = Bun.spawn([join(packageRoot, "FrameBaker-P0.exe"), "--smoke"], {
    cwd: packageRoot, env: { ...process.env, SFS_SERVICE_URL: service.url, SFS_SERVICE_TOKEN: "p0-attach-cookie-test", P0_EVIDENCE_DIR: evidence, P0_PROFILE_DIR: join(probe, "artifacts/attach-profile") }, stdout: "pipe", stderr: "pipe",
  });
  const hostOut = new Response(electron.stdout).text(), hostError = new Response(electron.stderr).text();
  test.hostExit = await electron.exited;
  writeFileSync(join(evidence, "desktop-host.stdout.log"), await hostOut);
  writeFileSync(join(evidence, "desktop-host.stderr.log"), await hostError);
  const reportText = readFileSync(join(evidence, "desktop-report.json"), "utf8");
  const report = JSON.parse(reportText);
  test.smokePassed = report.smokePassed;
  test.serviceAliveAfterHost = (await fetch(`${service.url}api/health`)).ok && child.exitCode === null;
  test.cookieAttributes = report.authCookieAttributes;
  test.noTokenInReport = !reportText.includes("p0-attach-cookie-test");
  test.passed = test.hostExit === 0 && test.smokePassed && test.serviceAliveAfterHost && test.noTokenInReport && report.authCookieConfigured;
} catch (error) { test.error = String(error); test.passed = false; }
finally {
  clearTimeout(bootTimer);
  if (child.exitCode === null) child.kill();
  test.fixtureExit = await child.exited;
  await reading;
  writeFileSync(join(evidence, "desktop-fixture.stdout.log"), backendLog);
  writeFileSync(join(evidence, "desktop-fixture.stderr.log"), await errorLog);
  test.completedAt = new Date().toISOString();
  writeFileSync(join(evidence, "desktop-attach-test.json"), JSON.stringify(test, null, 2));
  console.log(JSON.stringify(test));
  if (!test.passed) process.exitCode = 1;
}
