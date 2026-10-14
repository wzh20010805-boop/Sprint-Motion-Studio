import { existsSync, renameSync } from "node:fs";
import { mkdir, readdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtractionResult, SourceFrameTiming, SourceTiming, VideoProbe } from "@framebaker/shared";
import { checkCancelled, probeVideo, ptsTime, rational, runPipelineCommand } from "./probe";

const activeSources = new Set<string>();
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function makeSourceTiming(sourceId: string, probe: VideoProbe): SourceTiming {
  const warnings = [...probe.warnings];
  const frames: SourceFrameTiming[] = probe.frames.map((frame, index) => {
    let ticks: bigint;
    let origin: SourceFrameTiming["duration_origin"];
    if (index + 1 < probe.frames.length) {
      ticks = BigInt(probe.frames[index + 1]!.pts) - BigInt(frame.pts); origin = "next_pts";
    } else if (frame.duration !== null && BigInt(frame.duration) > 0n) {
      ticks = BigInt(frame.duration); origin = "frame_duration";
    } else if (probe.streamStartPts !== null && probe.streamDurationPts !== null && BigInt(probe.streamStartPts) + BigInt(probe.streamDurationPts) > BigInt(frame.pts)) {
      ticks = BigInt(probe.streamStartPts) + BigInt(probe.streamDurationPts) - BigInt(frame.pts); origin = "stream_end";
    } else {
      if (index === 0) throw new Error("唯一帧没有可信时长，无法估算源播放时间");
      ticks = BigInt(frame.pts) - BigInt(probe.frames[index - 1]!.pts); origin = "estimated";
      warnings.push(`第 ${index} 帧末帧时长根据前一显示间隔估算，导出前需要确认`);
    }
    if (ticks <= 0n) throw new Error(`第 ${index} 帧显示时长必须为正数`);
    return {
      source_frame_id: `${sourceId}:${String(index).padStart(6, "0")}`, source_index: index,
      file: `raw/frame_${String(index).padStart(6, "0")}.png`, pts: frame.pts, time_base: probe.timeBase,
      presentation_time: ptsTime(frame.pts, probe.timeBase), display_duration: ptsTime(ticks, probe.timeBase), duration_origin: origin, decode_status: "ok",
    };
  });
  let num = 0n, den = 1n;
  for (const frame of frames) {
    const duration = frame.display_duration;
    num = num * BigInt(duration.den) + BigInt(duration.num) * den; den *= BigInt(duration.den);
    const reduced = rational(num, den); num = BigInt(reduced.num); den = BigInt(reduced.den);
  }
  return { schema_version: "1.0", source_id: sourceId, frames, duration: rational(num, den), warnings };
}

async function diskPreflight(directory: string, probe: VideoProbe) {
  const disk = await statfs(directory, { bigint: true });
  // PNG 无损编码的保守容量上界与缓冲余量；不以有损视频体积推断输出容量。
  const required = BigInt(probe.width) * BigInt(probe.height) * 8n * BigInt(probe.frames.length) + 16n * 1024n * 1024n;
  if (disk.bavail * disk.bsize < required) throw new Error(`磁盘空间不足，完整原始帧至少需要预留 ${required.toString()} 字节`);
}

async function validatePngs(rawDirectory: string, probe: VideoProbe, ffmpeg: string, signal?: AbortSignal) {
  const files = await readdir(rawDirectory);
  if (files.length !== probe.frames.length) throw new Error(`PNG 数量 ${files.length} 与探测显示帧数量 ${probe.frames.length} 不一致`);
  const indexes = files.map(file => {
    const match = /^frame_(\d{6,})\.png$/.exec(file);
    if (!match) throw new Error(`暂存目录出现未知帧文件：${file}`);
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || file !== `frame_${String(index).padStart(6, "0")}.png`) throw new Error(`PNG 源索引无效：${file}`);
    return index;
  }).sort((a, b) => a - b);
  for (let index = 0; index < indexes.length; index++) {
    checkCancelled(signal);
    if (indexes[index] !== index) throw new Error(`PNG 源序列缺少或重复第 ${index} 帧`);
    const bytes = await readFile(join(rawDirectory, `frame_${String(index).padStart(6, "0")}.png`));
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error(`第 ${index} 帧 PNG 头无效`);
    if (bytes.readUInt32BE(16) !== probe.width || bytes.readUInt32BE(20) !== probe.height) throw new Error(`第 ${index} 帧 PNG 尺寸与视频不一致`);
  }
  // 验证完整压缩数据与 CRC；仅检查 IHDR 无法发现截断的 IDAT。
  await runPipelineCommand([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-start_number", "0", "-i", join(rawDirectory, "frame_%06d.png"), "-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode:v", "passthrough", "-f", "null", "-"], signal);
}

/** 缓存复用与首次提取使用同一完整性门槛，任何产物都不因已有文件名而被信任。 */
export async function validateSourceArtifacts(directory: string, sourceId: string, probe: VideoProbe, signal?: AbortSignal): Promise<SourceTiming> {
  checkCancelled(signal);
  const expected = makeSourceTiming(sourceId, probe);
  let actual: unknown;
  try {
    actual = JSON.parse(await readFile(join(directory, "timing.json"), "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`INVALID_TIMING：源时间清单无法读取或解析：${error instanceof Error ? error.message : String(error)}`), { code: "INVALID_TIMING" });
  }
  if (!isDeepStrictEqual(actual, expected)) throw Object.assign(new Error("INVALID_TIMING：源时间清单与已保存的逐帧探测结果不一致"), { code: "INVALID_TIMING" });
  await validatePngs(join(directory, "raw"), probe, "ffmpeg", signal);
  checkCancelled(signal);
  return expected;
}

export async function extractAll(input: string, sourceDirectory: string, options: { sourceId: string; signal?: AbortSignal; onProgress?: (msg: string) => void; ffmpeg?: string; ffprobe?: string; onCheckpoint?:(phase:'prepared'|'raw_renamed'|'timing_renamed',stage:string,timing:SourceTiming,probe:VideoProbe)=>void }): Promise<ExtractionResult> {
  checkCancelled(options.signal);
  if (!options.sourceId?.trim()) throw new Error("sourceId 不能为空");
  const directory = resolve(sourceDirectory), rawDirectory = join(directory, "raw"), timingPath = join(directory, "timing.json");
  if (!(await stat(directory)).isDirectory()) throw new Error("源目录必须已存在");
  if (existsSync(rawDirectory) || existsSync(timingPath)) throw new Error("原始帧 raw 或 timing.json 已存在，拒绝覆盖");
  if (activeSources.has(directory)) throw new Error("同一原始素材已有完整抽帧任务");
  activeSources.add(directory);
  const stage = join(directory, `staging-${crypto.randomUUID()}`), stagedRaw = join(stage, "raw");
  let publishedRaw = false;
  try {
    options.onProgress?.("探测视频与逐帧时间戳");
    const probe = await probeVideo(input, { signal: options.signal, ffprobe: options.ffprobe });
    const timing = makeSourceTiming(options.sourceId, probe);
    await diskPreflight(directory, probe);
    checkCancelled(options.signal);
    await mkdir(stagedRaw, { recursive: true });
    options.onProgress?.(`解码全部 ${probe.frames.length} 个显示帧`);
    await runPipelineCommand([options.ffmpeg ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-xerror", "-noautorotate", "-i", resolve(input), "-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode:v", "passthrough", "-start_number", "0", join(stagedRaw, "frame_%06d.png")], options.signal);
    options.onProgress?.("校验 PNG 数量、源索引、尺寸和完整解码");
    await validatePngs(stagedRaw, probe, options.ffmpeg ?? "ffmpeg", options.signal);
    await writeFile(join(stage, "timing.json"), JSON.stringify(timing, null, 2) + "\n", { flag: "wx" });
    checkCancelled(options.signal);
    if (existsSync(rawDirectory) || existsSync(timingPath)) throw new Error("原始帧 raw 或 timing.json 已存在，拒绝覆盖");
    options.onCheckpoint?.('prepared',stage,timing,probe);
    // 服务为唯一业务写入者；同一进程的重复任务由 activeSources 拦截。
    // 同步发布两项防止取消在二者之间进入，失败将 raw 移回暂存并保留证据。
    renameSync(stagedRaw, rawDirectory); publishedRaw = true;
    options.onCheckpoint?.('raw_renamed',stage,timing,probe);
    renameSync(join(stage, "timing.json"), timingPath);
    publishedRaw = false;
    options.onCheckpoint?.('timing_renamed',stage,timing,probe);
    return { sourceId: options.sourceId, frameCount: timing.frames.length, rawDirectory, timing, probe, warnings: timing.warnings };
  } catch (error) {
    if (publishedRaw) renameSync(rawDirectory, stagedRaw);
    throw error;
  } finally {
    activeSources.delete(directory);
  }
}
