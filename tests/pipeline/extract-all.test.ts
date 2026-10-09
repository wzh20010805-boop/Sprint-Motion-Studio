import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { command, generatedRoot, makeFixtures, sourceDirectory } from "./fixtures";

let api: typeof import("../../apps/server/src/pipeline/extractAll");
let probeApi: typeof import("../../apps/server/src/pipeline/probe");
let media: Awaited<ReturnType<typeof makeFixtures>>;

beforeAll(async () => {
  media = await makeFixtures();
  try { api = await import("../../apps/server/src/pipeline/extractAll"); } catch { /* RED：能力尚未实现 */ }
  try { probeApi = await import("../../apps/server/src/pipeline/probe"); } catch { /* RED：能力尚未实现 */ }
}, 120_000);

function requireApi() {
  expect(api?.extractAll).toBeFunction();
  expect(probeApi?.probeVideo).toBeFunction();
}

describe("完整显示帧提取（真实 FFmpeg）", () => {
  for (const count of [48, 61, 120, 300]) test(`${count} 帧无截断并以源整数索引保存`, async () => {
    requireApi();
    const source = await sourceDirectory(media.cfr.get(count)!, `cfr-${count}`);
    const result = await api.extractAll(source.original, source.directory, { sourceId: `cfr-${count}` });
    expect(result.frameCount).toBe(count);
    expect((await readdir(result.rawDirectory)).length).toBe(count);
    expect(result.timing.frames[0]).toMatchObject({ source_frame_id: `cfr-${count}:000000`, source_index: 0, file: "raw/frame_000000.png", pts: "0", presentation_time: { num: 0, den: 1 }, display_duration: { num: 1, den: 24 }, duration_origin: "next_pts", decode_status: "ok" });
    expect(result.timing.frames.at(-1)).toMatchObject({ source_index: count - 1, file: `raw/frame_${String(count - 1).padStart(6, "0")}.png`, display_duration: { num: 1, den: 24 } });
    if (count === 48) expect(result.timing.duration).toEqual({ num: 2, den: 1 });
    expect(JSON.parse(await readFile(join(source.directory, "timing.json"), "utf8"))).toEqual(result.timing);
    expect(await readFile(source.original)).toEqual(source.bytes);
  }, 60_000);

  test("重复画面仍保留全部 48 个显示帧和 2 秒停顿", async () => {
    requireApi();
    const source = await sourceDirectory(media.duplicate, "duplicates");
    const result = await api.extractAll(source.original, source.directory, { sourceId: "duplicates" });
    expect(result.frameCount).toBe(48);
    expect(result.timing.duration).toEqual({ num: 2, den: 1 });
    expect(await readFile(join(result.rawDirectory, "frame_000000.png"))).toEqual(await readFile(join(result.rawDirectory, "frame_000047.png")));
  });

  test("真正 VFR 保留 1/24、1/12、1/8、1/24 秒时长", async () => {
    requireApi();
    const source = await sourceDirectory(media.vfr, "vfr");
    const result = await api.extractAll(source.original, source.directory, { sourceId: "vfr" });
    expect(result.frameCount).toBe(4);
    expect(result.timing.frames.map(frame => frame.presentation_time)).toEqual([{ num: 0, den: 1 }, { num: 1, den: 24 }, { num: 1, den: 8 }, { num: 1, den: 4 }]);
    expect(result.timing.frames.map(frame => frame.display_duration)).toEqual([{ num: 1, den: 24 }, { num: 1, den: 12 }, { num: 1, den: 8 }, { num: 1, den: 24 }]);
    expect(result.timing.frames.at(-1)?.duration_origin).toBe("frame_duration");
    expect(result.timing.duration).toEqual({ num: 7, den: 24 });
  });

  test("Unicode、空格和 shell 元字符是普通文件名", async () => {
    requireApi();
    const source = await sourceDirectory(media.special, "special");
    const result = await api.extractAll(media.special, source.directory, { sourceId: "special" });
    expect(result.frameCount).toBe(48);
    expect(await readFile(media.special)).toEqual(source.bytes);
  });

  test("音频位于全局流 0 时仍映射首个视频流并逐帧保持解码顺序", async () => {
    requireApi();
    const source = await sourceDirectory(media.multiStream, "multi-stream");
    const result = await api.extractAll(source.original, source.directory, { sourceId: "multi-stream" });
    expect(result.probe.streamIndex).toBe(1);
    expect(result.frameCount).toBe(48);
    const decodeHashes = (output: string) => output.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1)!.trim());
    const original = await command(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", source.original, "-map", "0:v:0", "-an", "-sn", "-dn", "-pix_fmt", "rgb24", "-fps_mode:v", "passthrough", "-f", "framemd5", "-"]);
    const pngs = await command(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-start_number", "0", "-i", join(result.rawDirectory, "frame_%06d.png"), "-pix_fmt", "rgb24", "-fps_mode:v", "passthrough", "-f", "framemd5", "-"]);
    expect(decodeHashes(pngs)).toEqual(decodeHashes(original));
  });

  test("已有 raw 拒绝覆盖且原文件不变", async () => {
    requireApi();
    const source = await sourceDirectory(media.cfr.get(48)!, "existing");
    await mkdir(join(source.directory, "raw"));
    await writeFile(join(source.directory, "raw", "keep.png"), "不可覆盖");
    await expect(api.extractAll(source.original, source.directory, { sourceId: "existing" })).rejects.toThrow(/raw|原始帧/);
    expect(await readFile(join(source.directory, "raw", "keep.png"), "utf8")).toBe("不可覆盖");
  });

  test("提取取消保留暂存并且不发布 raw 或 timing", async () => {
    requireApi();
    const source = await sourceDirectory(media.cfr.get(300)!, "cancel");
    const controller = new AbortController();
    const pending = api.extractAll(source.original, source.directory, { sourceId: "cancel", signal: controller.signal, onProgress: message => { if (message.includes("解码")) setTimeout(() => controller.abort(), 5); } });
    await expect(pending).rejects.toMatchObject({ name: "JobCancelledError" });
    const files = await readdir(source.directory);
    expect(files.some(file => file.startsWith("staging-"))).toBe(true);
    expect(files).not.toContain("raw");
    expect(files).not.toContain("timing.json");
    expect(await readFile(source.original)).toEqual(source.bytes);
  });

  test("预先取消探测时不启动输出", async () => {
    requireApi();
    const controller = new AbortController(); controller.abort();
    await expect(probeApi.probeVideo(media.cfr.get(48)!, { signal: controller.signal })).rejects.toMatchObject({ name: "JobCancelledError" });
  });

  for (const [label, key, pattern] of [
    ["损坏媒体", "corrupt", /失败|损坏|解码|probe/],
    ["无视频流", "audio", /视频流/],
    ["HDR", "hdr", /HDR/],
    ["旋转", "rotation", /旋转/],
    ["非方形像素", "sar", /像素|SAR/],
    ["交错", "interlaced", /交错/],
  ] as const) test(`${label} 明确失败且无伪完成目录`, async () => {
    requireApi();
    const source = await sourceDirectory(media[key], key);
    await expect(api.extractAll(source.original, source.directory, { sourceId: key })).rejects.toThrow(pattern);
    expect(await readdir(source.directory)).not.toContain("raw");
    expect(await readdir(source.directory)).not.toContain("timing.json");
  });

  test("缺失和非单调 PTS 不用平均 FPS 掩盖，超安全整数有理数明确拒绝", async () => {
    requireApi();
    const document = JSON.parse(await command(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-show_frames", "-select_streams", "v:0", "-of", "json", media.vfr]));
    const missing = structuredClone(document); delete missing.frames[1].pts;
    expect(() => probeApi.parseVideoProbe(JSON.stringify(missing))).toThrow(/PTS|时间戳/);
    const unordered = structuredClone(document); unordered.frames[1].pts = unordered.frames[0].pts;
    expect(() => probeApi.parseVideoProbe(JSON.stringify(unordered))).toThrow(/单调|PTS/);
    const unsafe = structuredClone(document); unsafe.frames[3].pts = "900719925474099300000";
    expect(() => probeApi.parseVideoProbe(JSON.stringify(unsafe))).toThrow(/安全整数|范围/);
  });

  test("JSON 中超安全整数 PTS 先以 BigInt 读取，约分后才转 JSON 数值", async () => {
    requireApi();
    const document = JSON.parse(await command(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-show_frames", "-select_streams", "v:0", "-of", "json", media.vfr]));
    document.streams[0].time_base = "1/3";
    document.frames = document.frames.slice(0, 2);
    document.frames[0].pts = "MARKER_0"; document.frames[1].pts = "MARKER_1";
    const json = JSON.stringify(document).replace('"MARKER_0"', "9007199254740993").replace('"MARKER_1"', "9007199254740996");
    const probe = probeApi.parseVideoProbe(json);
    expect(probe.frames.map(frame => frame.pts)).toEqual(["9007199254740993", "9007199254740996"]);
    expect(api.makeSourceTiming("large-pts", probe).frames[0]?.presentation_time).toEqual({ num: 3002399751580331, den: 1 });
  });

  test("末帧优先可信帧时长，其次流终点，无依据时明确 estimated", async () => {
    requireApi();
    const original = await probeApi.probeVideo(media.vfr);
    const streamEnd = structuredClone(original);
    streamEnd.frames.at(-1)!.duration = null;
    const timing = api.makeSourceTiming("stream-end", streamEnd);
    expect(timing.frames.at(-1)).toMatchObject({ duration_origin: "stream_end", display_duration: { num: 1, den: 24 } });
    const estimated = structuredClone(streamEnd);
    estimated.streamDurationPts = null;
    const estimateTiming = api.makeSourceTiming("estimate", estimated);
    expect(estimateTiming.frames.at(-1)).toMatchObject({ duration_origin: "estimated", display_duration: { num: 1, den: 8 } });
    expect(estimateTiming.warnings.length).toBe(1);
    const oneFrame = structuredClone(estimated);
    oneFrame.frames = [oneFrame.frames.at(-1)!];
    expect(() => api.makeSourceTiming("unknown-single", oneFrame)).toThrow(/时长/);
  });

  test("逐帧 SAR 改变与异常显示矩阵也明确拒绝", async () => {
    requireApi();
    const document = JSON.parse(await command(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-show_frames", "-select_streams", "v:0", "-of", "json", media.vfr]));
    const changingSar = structuredClone(document);
    changingSar.frames[1].sample_aspect_ratio = "2:1";
    expect(() => probeApi.parseVideoProbe(JSON.stringify(changingSar))).toThrow(/像素|SAR/);
    const reflected = structuredClone(document);
    reflected.streams[0].side_data_list = [{ side_data_type: "Display Matrix", rotation: 0, displaymatrix: "\n00000000: -65536 0 0\n00000001: 0 65536 0\n00000002: 0 0 1073741824\n" }];
    expect(() => probeApi.parseVideoProbe(JSON.stringify(reflected))).toThrow(/矩阵|旋转/);
  });

  test("输出 PNG 数据损坏必须完整解码失败，不能只检查 IHDR", async () => {
    requireApi();
    const source = await sourceDirectory(media.cfr.get(48)!, "png-corrupt");
    await expect(api.extractAll(source.original, source.directory, { sourceId: "png-corrupt", onProgress: message => {
      if (!message.includes("校验 PNG")) return;
      const paths = readdirSync(source.directory);
      const staging = paths.find(name => name.startsWith("staging-"))!;
      const path = join(source.directory, staging, "raw", "frame_000010.png");
      const bytes = readFileSync(path);
      writeFileSync(path, bytes.subarray(0, 40));
    } })).rejects.toThrow(/PNG|失败|解码/);
    expect(await readdir(source.directory)).not.toContain("raw");
  });

  test("每张 PNG 必须与源宽高一致，失败仍保留暂存", async () => {
    requireApi();
    const smaller = join(generatedRoot, "smaller.png");
    await command(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=green:size=32x24", "-frames:v", "1", smaller]);
    const source = await sourceDirectory(media.cfr.get(48)!, "png-size");
    await expect(api.extractAll(source.original, source.directory, { sourceId: "png-size", onProgress: message => {
      if (!message.includes("校验 PNG")) return;
      const staging = readdirSync(source.directory).find(name => name.startsWith("staging-"))!;
      writeFileSync(join(source.directory, staging, "raw", "frame_000017.png"), readFileSync(smaller));
    } })).rejects.toThrow(/尺寸/);
    const files = await readdir(source.directory);
    expect(files).not.toContain("raw");
    expect(files).not.toContain("timing.json");
    expect(files.some(name => name.startsWith("staging-"))).toBe(true);
  });
});
