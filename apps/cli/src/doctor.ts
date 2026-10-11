import { existsSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "./client";

async function version(bin: string, flag: string) {
  const path = Bun.which(bin,{PATH:process.env.PATH});
  if (!path) return { available: false, path: null, version: null };
  const child = Bun.spawn([path, flag], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { available: code === 0, path, version: (out || err).split(/\r?\n/)[0] };
}

export async function doctor() {
  const [ffmpeg, ffprobe] = await Promise.all([version("ffmpeg", "-version"), version("ffprobe", "-version")]);
  const ok = ffmpeg.available && ffprobe.available;
  const python=process.env.SFS_IMAGE_PYTHON ?? join(repositoryRoot(),process.platform==='win32'?'.venv-image/Scripts/python.exe':'.venv-image/bin/python');
  const model=join(process.env.SFS_MODEL_DIR ?? join(repositoryRoot(),'.models'),'u2netp.onnx');
  const matting=existsSync(python)&&existsSync(model);
  return {
    schema_version: "1.0", ok, status: ok ? "succeeded" : "failed", requires_user_action: !ok,
    data: { bun: Bun.version, platform: process.platform, ffmpeg, ffprobe,
      isolated_python: existsSync(python), matting_backend:{model:'u2netp',model_path:model,python,model_cached:existsSync(model)},
      capabilities: { extract_all: ok, matting, mask_editing:existsSync(python), cocos_integration: false, cli_requires_gui: false } },
    artifacts: [], warnings: matting?[]:['MODEL_NOT_READY'],
    error: ok ? null : { code: "DEPENDENCY_MISSING", message: "需要可用FFmpeg和ffprobe" },
  };
}
