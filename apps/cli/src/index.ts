import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, openSync, closeSync,readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { CliError, defaultWorkspace, ensureService, repositoryRoot, requestService, waitJob } from "./client";
import { doctor } from "./doctor";
import { productionCommands,runProduction,schemas,compactResult } from './production';
import { distributionRoot,configureDistribution } from './distribution';
import {collaborationCommands,runCollaboration} from './collaboration';

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function run(args: string[]) {
  const packed=distributionRoot();if(packed)configureDistribution(packed);
  try {
    const { positionals, values: flags } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      json: { type: "boolean" }, help: { type: "boolean" }, workspace: { type: "string" }, name: { type: "string" },
      project: { type: "string" }, file: { type: "string" }, source: { type: "string" }, clip: { type: "string" },
      mode: { type: "string" }, wait: { type: "boolean" }, job: { type: "string" }, timeout: { type: "string" },
      "base-revision": { type: "string" }, smoke: { type: "boolean" },
      'expected-acceptance-epoch':{type:'string'},task:{type:'string'},candidate:{type:'string'},parent:{type:'string'},operation:{type:'string'},'request-key':{type:'string'},'base-content':{type:'string'},'base-mask-version':{type:'string'},cursor:{type:'string'},limit:{type:'string'},'content-hash':{type:'string'},fps:{type:'string'},
      frames: { type:'string' }, frame: { type:'string' }, region: { type:'string' }, strokes: { type:'string' }, 'background-points': {type:'string'},
      axis:{type:'string'},config:{type:'string'},patch:{type:'string'},recipe:{type:'string'},output:{type:'string'},format:{type:'string'},draft:{type:'boolean'},timing:{type:'string'},'max-texture':{type:'string'},stdio:{type:'boolean'},directory:{type:'string'},
    } });
    const command = positionals.join(" ");
    if(command==='schema'){const name=String(flags.name??'recipe');if(!schemas[name])throw new CliError('INVALID_ARGUMENT','未知schema');return {body:{schema_version:'1.0',ok:true,status:'succeeded',data:schemas[name],error:null},exitCode:0};}
    const required = (key: keyof typeof flags) => {
      const value = flags[key];
      if (typeof value !== "string" || !value.trim()) throw new CliError("INVALID_ARGUMENT", `缺少--${key}`);
      return value;
    };
    if (flags.help) return { body: { schema_version: "1.0", ok: true, status: "succeeded", data: { commands: [...collaborationCommands,"doctor", "project create|list|inspect", "import video|images", "clip create", "extract --mode all", "matte --project ID (--frames ID,ID | --clip ID) [--region x,y,w,h] --wait", "mask show|edit|undo|review --frame ID", "align --project ID --axis ID --config alignment.json", "review apply --project ID --axis ID --patch review.json --base-revision N", "preview --project ID --axis ID --frame ID --output preview.png", "export --project ID --axis ID [--draft] [--output DIRECTORY] --wait", "pipeline run --project ID --axis ID --recipe recipe.json", "schema --name recipe|alignment|manifest|task_brief|candidate_manifest|review_issue_page|impact", "job status|wait|cancel|resume", "mcp --stdio", "gui"] }, error: null }, exitCode: 0 };
    if (command === "doctor") { const body = await doctor(); return { body, exitCode: body.ok ? 0 : 3 }; }
    if (![...collaborationCommands,...productionCommands,"import images","mcp","project create", "project inspect", "import video", "clip create", "extract", "matte", "mask show", "mask edit", "mask undo", "mask review", "job status", "job wait", "job cancel", "gui"].includes(command)) throw new CliError("INVALID_ARGUMENT", `未知命令：${command}`);
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
    let region: number[] | undefined;
    if(command==='matte'){required('project');if(!flags.frames&&!flags.clip)throw new CliError('INVALID_ARGUMENT','需要--frames或--clip');if(flags.region){region=flags.region.split(',').map(Number);if(region.length!==4||region.some(v=>!Number.isSafeInteger(v))||region[0]!<0||region[1]!<0||region[2]!<=0||region[3]!<=0)throw new CliError('INVALID_ARGUMENT','region须为x,y,width,height');}}
    if(command.startsWith('mask '))required('frame');
    let strokes:unknown;
    if(command==='mask edit'){const path=resolve(required('strokes'));if(!existsSync(path))throw new CliError('INVALID_INPUT','画笔JSON不存在');strokes=await Bun.file(path).json();if(!Array.isArray(strokes))throw new CliError('INVALID_INPUT','画笔JSON须为数组');}
    const workspace = resolve(flags.workspace ?? defaultWorkspace());
    const service = await ensureService(workspace);
    if(collaborationCommands.includes(command))return await runCollaboration(command,flags,service,timeout);
    if(command==='mcp'){if(!flags.stdio)throw new CliError('INVALID_ARGUMENT','MCP需要--stdio');await (await import('./mcpBridge')).bridgeStdio(service);return {body:null,exitCode:0};}
    if(productionCommands.includes(command)){const result=await runProduction(command,flags,service,revision,timeout);return result.exitCode!==undefined?result:{body:result,exitCode:0};}
    let body: any;
    if(command==='import images'){const directory=resolve(required('directory'));const files=readdirSync(directory,{withFileTypes:true}).filter(f=>f.isFile()&&f.name.toLowerCase().endsWith('.png'));if(!files.length)throw new CliError('INVALID_INPUT','目录没有PNG序列');const form=new FormData();form.set('projectId',required('project'));form.set('name',String(flags.name??'PNG序列'));for(const f of files)form.append('files',Bun.file(join(directory,f.name)),f.name);if(flags.axis){form.delete('projectId');form.delete('name');form.set('project_id',required('project'));form.set('axis_id',required('axis'));form.set('options',await Bun.file(resolve(required('file'))).text());}body=await requestService(service,flags.axis?'/api/v1/collaboration/images':'/api/v1/images/import',{method:'POST',body:form});return {body,exitCode:0};}
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
    } else if(command==='matte'){
      let frameIds=flags.frames?.split(',');if(!frameIds){const project=await requestService(service,`/api/v1/projects/${required('project')}`);const clip=project.data.clips.find((c:any)=>c.id===flags.clip);if(!clip)throw new CliError('INVALID_INPUT','动作不存在');frameIds=project.data.editor_frames.filter((f:any)=>f.track_id===clip.track_id&&f.step_id).map((f:any)=>f.id);}
      const background_points=flags['background-points']?await Bun.file(resolve(required('background-points'))).json():undefined;
      body=await requestService(service,'/api/v1/matte',json({project_id:required('project'),frame_ids:frameIds,region,background_points,base_revision:revision}));
      if(flags.wait)return await waitJob(service,body.job_id,timeout);
    } else if(command.startsWith('mask ')){
      if(flags.axis&&(command==='mask edit'||command==='mask undo')){
        let baseContent:unknown;try{baseContent=JSON.parse(required('base-content'));}catch{throw new CliError('INVALID_INPUT','base-content必须为JSON');}
        const version=required('base-mask-version');if(revision===undefined)throw new CliError('INVALID_ARGUMENT','协作遮罩编辑需要--base-revision');
        body=await requestService(service,'/api/v1/collaboration/maker/'+(command==='mask edit'?'edit_mask':'undo_mask'),json({project_id:required('project'),axis_id:required('axis'),frame_id:required('frame'),base_content:baseContent,base_mask_version:version==='null'?null:version,base_revision:revision,...(command==='mask edit'?{strokes}:{})}));return {body,exitCode:0};
      }
      const path=`/api/v1/masks/${encodeURIComponent(required('frame'))}`;
      body=await requestService(service,path);
      if(command!=='mask show')body=await requestService(service,path+(command==='mask edit'?'/strokes':command==='mask undo'?'/undo':'/review'),json({version_id:flags['base-mask-version']??body.data.version_id,revision:revision??body.data.revision,...(command==='mask edit'?{strokes}:{})}));
    } else if (command === "job status") body = await requestService(service, `/api/v1/jobs/${encodeURIComponent(required("job"))}`);
    else if (command === "job wait") return await waitJob(service, required("job"), timeout);
    else if (command === "job cancel") body = await requestService(service, `/api/v1/jobs/${encodeURIComponent(required("job"))}/cancel`, { method: "POST" });
    else if (command === "gui") {
      const root = repositoryRoot();
      const electron = packed?join(packed,'SpriteMotionStudio.exe'):join(root, "probes/desktop/node_modules/electron/dist/electron.exe");
      if (!existsSync(electron)) throw new CliError("BACKEND_UNAVAILABLE", "未准备Electron宿主，请参照P0桌面说明", 3);
      const evidence = join(workspace, ".sfs", "gui-evidence"); mkdirSync(evidence, { recursive: true });
      const log = openSync(join(workspace, ".sfs/gui.log"), "a");
      const child = spawn(electron, [...(packed?[]:[join(root, "probes/desktop")]), ...(flags.smoke ? ["--smoke"] : [])], {
        cwd: root, windowsHide: !!flags.smoke, detached: !flags.smoke, stdio: ["ignore", log, log],
        env: { ...process.env,SFS_WORKSPACE:workspace, SFS_SERVICE_URL: service.url, SFS_SERVICE_TOKEN: service.token, ...(packed?{SFS_SMOKE_EVIDENCE:evidence}:{}), P0_EVIDENCE_DIR: evidence, P0_PROFILE_DIR: join(workspace, ".sfs/gui-profile") },
      });
      closeSync(log);
      if (flags.smoke) { const exitCode = await new Promise<number>(r => { child.on("error", () => r(3)); child.on("exit", code => r(code ?? 1)); }); return { body: { schema_version: "1.0", ok: exitCode === 0, status: exitCode === 0 ? "succeeded" : "failed", artifacts: [{ kind: "desktop_probe", path: evidence }], warnings: packed ? [] : ["P1_DEVELOPMENT_HOST"], error: exitCode === 0 ? null : { code: "DESKTOP_FAILED", message: "请查看gui.log" } }, exitCode }; }
      child.unref();
      body = { schema_version: "1.0", ok: true, status: "accepted", data: { pid: child.pid, workspace }, warnings: packed ? [] : ["P1_DEVELOPMENT_HOST"], error: null };
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
  if(result.body!==null)console.log(JSON.stringify(result.body));
  process.exit(result.exitCode);
}
