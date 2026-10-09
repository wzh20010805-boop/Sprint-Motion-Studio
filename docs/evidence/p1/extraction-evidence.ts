import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../.."), generated = join(root, "fixtures/generated");
const runs = (await readdir(generated)).filter(name => /^p1-\d+-/.test(name)).sort().reverse();
let fixture = "";
for (const name of runs) {
  const directories = await readdir(join(generated, name));
  if (directories.some(directory => directory.startsWith("source-cfr-300-"))) { fixture = join(generated, name); break; }
}
if (!fixture) throw new Error("没有完整抽帧样本证据");
const directoryNames = await readdir(fixture);
for (const count of [48, 61, 120, 300]) {
  for (const name of [`extraction-timing-cfr${count}.json`, `extraction-contact-cfr${count}.png`]) {
    if (existsSync(join(import.meta.dir, name))) throw new Error(`证据已存在，拒绝覆盖：${name}`);
  }
}
const records = [];
for (const [count, columns, rows] of [[48, 8, 6], [61, 8, 8], [120, 12, 10], [300, 20, 15]]) {
  const name = directoryNames.find(name => name.startsWith(`source-cfr-${count}-`));
  if (!name) throw new Error(`缺少 ${count} 帧产物`);
  const directory = join(fixture, name), raw = join(directory, "raw");
  const timing = JSON.parse(await readFile(join(directory, "timing.json"), "utf8"));
  const timingFile = join(import.meta.dir, `extraction-timing-cfr${count}.json`);
  const contact = join(import.meta.dir, `extraction-contact-cfr${count}.png`);
  await copyFile(join(directory, "timing.json"), timingFile, constants.COPYFILE_EXCL);
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-start_number", "0", "-i", join(raw, "frame_%06d.png"), "-vf", `tile=${columns}x${rows}`, "-frames:v", "1", contact], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  records.push({ count, actualPngCount: (await readdir(raw)).length, duration: timing.duration, fixture: relative(root, directory).replaceAll("\\", "/"), timing: relative(root, timingFile).replaceAll("\\", "/"), contactSheet: relative(root, contact).replaceAll("\\", "/") });
}
await writeFile(join(import.meta.dir, "extraction-matrix.json"), JSON.stringify({ createdAt: new Date().toISOString(), runtime: Bun.version, platform: process.platform, ffmpeg: "8.1.1-118-g1034b144ff-20260615", records }, null, 2) + "\n");
console.log(JSON.stringify(records, null, 2));
