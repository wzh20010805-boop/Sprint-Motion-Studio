import { existsSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "./client";

async function version(bin: string, flag: string) {
  const path = Bun.which(bin);
  if (!path) return { available: false, path: null, version: null };
  const child = Bun.spawn([path, flag], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { available: code === 0, path, version: (out || err).split(/\r?\n/)[0] };
}

export async function doctor() {
  const [ffmpeg, ffprobe] = await Promise.all([version("ffmpeg", "-version"), version("ffprobe", "-version")]);
  const ok = ffmpeg.available && ffprobe.available;
  return {
    schema_version: "1.0", ok, status: ok ? "succeeded" : "failed", requires_user_action: !ok,
    data: { bun: Bun.version, platform: process.platform, ffmpeg, ffprobe,
      isolated_python: existsSync(join(repositoryRoot(), process.platform === "win32" ? ".venv-image/Scripts/python.exe" : ".venv-image/bin/python")),
      capabilities: { extract_all: ok, matting: false, cocos_integration: false, cli_requires_gui: false } },
    artifacts: [], warnings: ["MODEL_NOT_READY", "P1_ONLY"],
    error: ok ? null : { code: "DEPENDENCY_MISSING", message: "需要可用FFmpeg和ffprobe" },
  };
}
