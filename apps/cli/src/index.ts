import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { CliError, defaultWorkspace, ensureService, repositoryRoot, requestService, waitJob } from "./client";
import { doctor } from "./doctor";

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function run(args: string[]) {
  try {
    const { positionals, values: flags } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      json: { type: "boolean" }, help: { type: "boolean" }, workspace: { type: "string" }, name: { type: "string" },
      project: { type: "string" }, file: { type: "string" }, source: { type: "string" }, clip: { type: "string" },
      mode: { type: "string" }, wait: { type: "boolean" }, job: { type: "string" }, timeout: { type: "string" },
      "base-revision": { type: "string" }, smoke: { type: "boolean" },
    } });
    const command = positionals.join(" ");
    const required = (key: keyof typeof flags) => {
      const value = flags[key];
      if (typeof value !== "string" || !value.trim()) throw new CliError("INVALID_ARGUMENT", `缺少--${key}`);
      return value;
    };
    if (flags.help) return { body: { schema_version: "1.0", ok: true, status: "succeeded", data: { commands: ["doctor", "project create", "project inspect", "import video", "clip create", "extract --mode all", "job status|wait|cancel", "gui"] }, error: null }, exitCode: 0 };
    if (command === "doctor") { const body = await doctor(); return { body, exitCode: body.ok ? 0 : 3 }; }
    if (!["project create", "project inspect", "import video", "clip create", "extract", "job status", "job wait", "job cancel", "gui"].includes(command)) throw new CliError("INVALID_ARGUMENT", `未知命令：${command}`);
    if (command === "extract" && (flags.mode ?? "all") !== "all") throw new CliError("INVALID_ARGUMENT", "P1 CLI只支持--mode all；旧采样仅保留为GUI显式选项");
    const timeout = Number(flags.timeout ?? "60");
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) throw new CliError("INVALID_ARGUMENT", "timeout须为0到3600秒之间的正数");
    const revision = flags["base-revision"] === undefined ? undefined : Number(flags["base-revision"]);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new CliError("INVALID_ARGUMENT", "base-revision须为非负整数");
    // 参数先检查，避免错误命令启动服务。
    if (command === "project create" || command === "clip create") required("name");
    if (["project inspect", "import video", "clip create", "extract"].includes(command)) required("project");
    if (command === "import video" && !existsSync(resolve(required("file")))) throw new CliError("INVALID_INPUT", "视频文件不存在");
    if (command === "clip create") required("source");
    if (command === "extract") required("clip");
    if (command.startsWith("job ")) required("job");
    const workspace = resolve(flags.workspace ?? defaultWorkspace());
    const service = await ensureService(workspace);
    let body: any;
    if (command === "project create") body = await requestService(service, "/api/v1/projects", json({ name: required("name") }));
    else if (command === "project inspect") body = await requestService(service, `/api/v1/projects/${encodeURIComponent(required("project"))}`);
    else if (command === "import video") {
      const file = resolve(required("file"));
      if (!existsSync(file)) throw new CliError("INVALID_INPUT", "视频文件不存在");
      const form = new FormData(); form.set("projectId", required("project")); form.set("file", Bun.file(file));
      body = await requestService(service, "/api/v1/sources/import", { method: "POST", body: form });
    } else if (command === "clip create") body = await requestService(service, "/api/v1/clips", json({ project_id: required("project"), source_id: required("source"), name: required("name") }));
    else if (command === "extract") {
      body = await requestService(service, "/api/v1/extract", json({ project_id: required("project"), clip_id: required("clip"), mode: "all", base_revision: revision }));
      if (flags.wait) return await waitJob(service, body.job_id, timeout);
    } else if (command === "job status") body = await requestService(service, `/api/v1/jobs/${encodeURIComponent(required("job"))}`);
    else if (command === "job wait") return await waitJob(service, required("job"), timeout);
    else if (command === "job cancel") body = await requestService(service, `/api/v1/jobs/${encodeURIComponent(required("job"))}/cancel`, { method: "POST" });
    else if (command === "gui") {
      const root = repositoryRoot();
      const electron = join(root, "probes/desktop/node_modules/electron/dist/electron.exe");
      if (!existsSync(electron)) throw new CliError("BACKEND_UNAVAILABLE", "未准备Electron宿主，请参照P0桌面说明", 3);
      const evidence = join(workspace, ".sfs", "gui-evidence"); mkdirSync(evidence, { recursive: true });
      const log = openSync(join(workspace, ".sfs/gui.log"), "a");
      const child = spawn(electron, [join(root, "probes/desktop"), ...(flags.smoke ? ["--smoke"] : [])], {
        cwd: root, windowsHide: !!flags.smoke, detached: !flags.smoke, stdio: ["ignore", log, log],
        env: { ...process.env, SFS_SERVICE_URL: service.url, SFS_SERVICE_TOKEN: service.token, P0_EVIDENCE_DIR: evidence, P0_PROFILE_DIR: join(workspace, ".sfs/gui-profile") },
      });
      closeSync(log);
      if (flags.smoke) { const exitCode = await new Promise<number>(r => { child.on("error", () => r(3)); child.on("exit", code => r(code ?? 1)); }); return { body: { schema_version: "1.0", ok: exitCode === 0, status: exitCode === 0 ? "succeeded" : "failed", artifacts: [{ kind: "desktop_probe", path: evidence }], warnings: ["P1_DEVELOPMENT_HOST"], error: exitCode === 0 ? null : { code: "DESKTOP_FAILED", message: "请查看gui.log" } }, exitCode }; }
      child.unref();
      body = { schema_version: "1.0", ok: true, status: "accepted", data: { pid: child.pid, workspace }, warnings: ["P1_DEVELOPMENT_HOST"], error: null };
    }
    // status查询的退出码表示查询成功，不把历史失败当查询失败。
    return { body, exitCode: 0 };
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError("INVALID_ARGUMENT", (error as Error).message, 2);
    return { body: failure.result ?? { schema_version: "1.0", ok: false, status: "failed", requires_user_action: false, data: {}, artifacts: [], warnings: [], error: { code: failure.code, message: failure.message } }, exitCode: failure.exitCode };
  }
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  console.log(JSON.stringify(result.body));
  process.exit(result.exitCode);
}
