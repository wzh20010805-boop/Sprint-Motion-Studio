import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const generatedRoot = resolve(import.meta.dir, "../../fixtures/generated", `p1-${Date.now()}-${crypto.randomUUID()}`);

export async function command(argv: string[]) {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`${argv[0]} (${code}): ${stderr}`);
  return stdout;
}

export async function makeVideo(name: string, count: number, extra: string[] = [], input = "testsrc2=size=64x48:rate=24") {
  await mkdir(generatedRoot, { recursive: true });
  const path = join(generatedRoot, name);
  await command(["ffmpeg", "-hide_banner", "-nostdin", "-n", "-f", "lavfi", "-i", input, "-frames:v", String(count), "-c:v", "libx264", "-pix_fmt", "yuv420p", ...extra, path]);
  return path;
}

export async function sourceDirectory(input: string, name: string) {
  const directory = join(generatedRoot, `source-${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const original = join(directory, "original.mp4");
  await copyFile(input, original);
  return { directory, original, bytes: await readFile(original) };
}

export async function makeFixtures() {
  const cfr = new Map<number, string>();
  for (const count of [48, 61, 120, 300]) cfr.set(count, await makeVideo(`cfr-${count}.mp4`, count));
  const duplicate = await makeVideo("duplicates.mp4", 48, [], "color=c=red:size=64x48:rate=24");
  // 4 个显示帧的 PTS 为 0、1、3、6 个 1/24 秒，末帧另有 1 个 tick。
  const vfr = await makeVideo("vfr.mp4", 4, ["-bf", "0", "-vf", "setpts='if(eq(N,0),0,if(eq(N,1),1,if(eq(N,2),3,6)))'", "-fps_mode:v", "passthrough"]);
  const special = join(generatedRoot, "小兵 空格 & $(命令);[素材].mp4");
  await copyFile(cfr.get(48)!, special);
  const multiStream = join(generatedRoot, "audio-first-two-videos.mp4");
  await command(["ffmpeg", "-hide_banner", "-nostdin", "-n", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-i", cfr.get(48)!, "-f", "lavfi", "-i", "color=c=blue:size=64x48:rate=24:duration=2", "-map", "0:a:0", "-map", "1:v:0", "-map", "2:v:0", "-c:v", "libx264", "-c:a", "aac", multiStream]);
  const hdr = await makeVideo("hdr.mp4", 3, ["-x264-params", "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"]);
  const sar = await makeVideo("nonsquare.mp4", 3, ["-vf", "setsar=2/1"]);
  const interlaced = await makeVideo("interlaced.mp4", 3, ["-flags", "+ilme+ildct", "-x264-params", "tff=1"]);
  const rotation = join(generatedRoot, "rotation.mp4");
  await command(["ffmpeg", "-hide_banner", "-nostdin", "-n", "-display_rotation", "90", "-i", cfr.get(48)!, "-c", "copy", rotation]);
  const audio = join(generatedRoot, "audio-only.m4a");
  await command(["ffmpeg", "-hide_banner", "-nostdin", "-n", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "aac", audio]);
  const corrupt = join(generatedRoot, "corrupt.mp4");
  const bytes = await readFile(cfr.get(48)!);
  await writeFile(corrupt, bytes.subarray(0, Math.floor(bytes.length / 2)));
  return { cfr, duplicate, vfr, special, multiStream, hdr, sar, interlaced, rotation, audio, corrupt };
}
