import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { Rational, VideoProbe } from "@framebaker/shared";
import { JobCancelledError } from "../jobs/run";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
type ProbeObject = Record<string, unknown>;

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new JobCancelledError();
}

/** 仅终止本次启动的进程；两条管道同时读取以免长视频阻塞。 */
export async function runPipelineCommand(argv: string[], signal?: AbortSignal): Promise<string> {
  checkCancelled(signal);
  const executable=argv[0]?Bun.which(argv[0],{PATH:process.env.PATH}):null;
  if (!executable) throw Object.assign(new Error(`缺少或无法执行媒体工具：${argv[0]}`), { code: "DEPENDENCY_MISSING" });
  const proc = Bun.spawn([executable,...argv.slice(1)], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const onAbort = () => { try { proc.kill(); } catch { /* 进程已经结束 */ } };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    checkCancelled(signal);
    if (code !== 0) throw new Error(`命令执行失败 (${argv[0]}): ${stderr.trim().slice(-4000) || `退出码 ${code}`}`);
    // ffprobe 遇到部分解码错误可能仍返回 0；错误级别日志也不可当作完整成功。
    if (stderr.trim()) throw new Error(`媒体解码失败 (${argv[0]}): ${stderr.trim().slice(-4000)}`);
    return stdout;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b !== 0n) { const next = a % b; a = b; b = next; }
  return a;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new Error("有理数分母不能为零");
  if (den < 0n) { num = -num; den = -den; }
  const divisor = gcd(num, den); num /= divisor; den /= divisor;
  if (num > MAX_SAFE || num < -MAX_SAFE || den > MAX_SAFE) throw new Error("源时间超出 JSON 安全整数范围");
  return { num: Number(num), den: Number(den) };
}

export function ptsTime(pts: string | bigint, timeBase: Rational): Rational {
  return rational(BigInt(pts) * BigInt(timeBase.num), BigInt(timeBase.den));
}

function integer(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error(`${label} 缺失或不是整数`);
  return BigInt(value);
}

function optionalInteger(value: unknown, label: string): string | null {
  if (value === undefined || value === "N/A") return null;
  return integer(value, label).toString();
}

function safeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result > MAX_SAFE || result < -MAX_SAFE) throw new Error(`${label} 超出安全整数范围`);
  return Number(result);
}

function ratio(value: unknown, label: string, optional = false): Rational | null {
  if (optional && (value === undefined || value === "N/A" || value === "0/0" || value === "0/1")) return null;
  if (typeof value !== "string") throw new Error(`${label} 缺失`);
  const match = /^(-?\d+)[/:](-?\d+)$/.exec(value);
  if (!match) throw new Error(`${label} 无效`);
  const result = rational(BigInt(match[1]!), BigInt(match[2]!));
  if (result.num <= 0) throw new Error(`${label} 必须为正数`);
  return result;
}

function object(value: unknown, label: string): ProbeObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 无效`);
  return value as ProbeObject;
}

/** 在 JSON.parse 前保护整数 token；reviver 在数字已舍入后才执行，不能保护原始 PTS。 */
function parseExactJson(json: string): unknown {
  let output = "", quoted = false, escaped = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index]!;
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (char === "-" || /\d/.test(char)) {
      const token = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(index))?.[0];
      if (!token) throw new Error("ffprobe JSON 数值无效");
      output += /^-?\d+$/.test(token) ? JSON.stringify(token) : token;
      index += token.length - 1;
    } else output += char;
  }
  return JSON.parse(output);
}

function assertSupported(stream: ProbeObject, frames: ProbeObject[]) {
  const transfers = new Set(["smpte2084", "arib-std-b67"]);
  const sideData = [stream, ...frames].flatMap(entry => Array.isArray(entry.side_data_list) ? entry.side_data_list as ProbeObject[] : []);
  if ([stream, ...frames].some(entry => transfers.has(String(entry.color_transfer))) || sideData.some(entry => /mastering display|content light|dovi|dolby vision|hdr/i.test(String(entry.side_data_type)))) throw new Error("首版不支持 HDR 输入，请明确转换为 SDR 后导入");
  if (typeof stream.field_order === "string" && !["progressive", "unknown"].includes(stream.field_order) || frames.some(frame => frame.interlaced_frame === "1")) throw new Error("首版不支持交错视频");
  const tags = stream.tags && typeof stream.tags === "object" ? stream.tags as ProbeObject : {};
  const rotations = [tags.rotate, ...sideData.filter(entry => entry.side_data_type === "Display Matrix").map(entry => entry.rotation)].filter(value => value !== undefined);
  if (rotations.some(value => !Number.isFinite(Number(value)) || Number(value) % 360 !== 0)) throw new Error("首版不支持带旋转信息的视频");
  const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  for (const entry of sideData.filter(value => value.side_data_type === "Display Matrix")) {
    const values = String(entry.displaymatrix ?? "").split(/\r?\n/).filter(line => line.includes(":")).flatMap(line => line.split(":").slice(1).join(":").trim().split(/\s+/).map(Number));
    if (values.length !== identity.length || values.some((value, index) => value !== identity[index])) throw new Error("首版不支持旋转、反射或异常显示矩阵");
  }
}

/** 纯解析边界也用于验证损坏／缺失的时间戳，绝不以平均 FPS 补齐源时间。 */
export function parseVideoProbe(json: string): VideoProbe {
  const document = object(parseExactJson(json), "ffprobe 输出");
  const streams = Array.isArray(document.streams) ? document.streams.map(value => object(value, "视频流")) : [];
  const stream = streams.find(value => value.codec_type === "video");
  if (!stream) throw new Error("输入没有可解码的视频流");
  const timeBase = ratio(stream.time_base, "time_base")!;
  const sampleAspectRatio = ratio(stream.sample_aspect_ratio, "像素长宽比 SAR")!;
  if (sampleAspectRatio.num !== sampleAspectRatio.den) throw new Error("首版不支持非方形像素（SAR 必须为 1:1）");
  const width = safeInteger(stream.width, "视频宽度"), height = safeInteger(stream.height, "视频高度");
  if (width <= 0 || height <= 0) throw new Error("视频宽高必须为正数");
  const streamIndex = safeInteger(stream.index, "视频流索引");
  const rawFrames = Array.isArray(document.frames) ? document.frames.map(value => object(value, "显示帧")).filter(frame => frame.media_type === "video") : [];
  if (rawFrames.length === 0) throw new Error("视频没有可解码的显示帧");
  assertSupported(stream, rawFrames);
  let previous: bigint | null = null;
  const frames = rawFrames.map((frame, index) => {
    if (safeInteger(frame.stream_index, "帧流索引") !== streamIndex) throw new Error("探测帧清单混入其他视频流");
    if (safeInteger(frame.width, "帧宽度") !== width || safeInteger(frame.height, "帧高度") !== height) throw new Error("视频帧尺寸不一致");
    if (frame.sample_aspect_ratio !== undefined) {
      const frameSar = ratio(frame.sample_aspect_ratio, `第 ${index} 帧像素长宽比 SAR`)!;
      if (frameSar.num !== frameSar.den) throw new Error(`第 ${index} 帧含非方形像素 SAR`);
    }
    const pts = integer(frame.pts, `第 ${index} 帧 PTS 时间戳`);
    if (previous !== null && pts <= previous) throw new Error(`第 ${index} 帧 PTS 不严格单调递增`);
    ptsTime(pts, timeBase);
    previous = pts;
    const duration = optionalInteger(frame.duration ?? frame.pkt_duration, "帧时长");
    return { pts: pts.toString(), duration: duration !== null && BigInt(duration) > 0n ? duration : null };
  });
  const format = document.format ? object(document.format, "媒体格式") : {};
  return {
    streamIndex, width, height, codec: String(stream.codec_name ?? "unknown"), pixelFormat: String(stream.pix_fmt ?? "unknown"),
    timeBase, averageFrameRate: ratio(stream.avg_frame_rate, "平均帧率", true), nominalFrameRate: ratio(stream.r_frame_rate, "标称帧率", true), sampleAspectRatio,
    streamStartPts: optionalInteger(stream.start_pts, "流起点"), streamDurationPts: optionalInteger(stream.duration_ts, "流时长"),
    frames, formatName: String(format.format_name ?? "unknown"), warnings: [],
  };
}

export async function probeVideo(input: string, options: { signal?: AbortSignal; ffprobe?: string } = {}): Promise<VideoProbe> {
  checkCancelled(options.signal);
  const path = resolve(input);
  await access(path, constants.R_OK);
  if (!(await stat(path)).isFile()) throw new Error("输入必须是可读媒体文件");
  const json = await runPipelineCommand([options.ffprobe ?? "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-show_frames", "-of", "json", path], options.signal);
  checkCancelled(options.signal);
  return parseVideoProbe(json);
}
