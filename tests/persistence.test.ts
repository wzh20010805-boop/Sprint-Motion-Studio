import { expect, test } from "bun:test";
import { discardPersistence, flushPersistence, trackPersistence } from "../apps/web/src/persistence";

test("保存等待写入完成，已被调用者处理的失败仍禁止假成功，重试成功可恢复", async () => {
  let complete!: () => void;
  let flushed = false;
  const write = trackPersistence("test:write", () => new Promise<void>(resolve => { complete = resolve; }));
  const flush = flushPersistence().then(() => { flushed = true; });
  await Promise.resolve(); expect(flushed).toBe(false);
  complete(); await write; await flush; expect(flushed).toBe(true);
  await trackPersistence("test:write", async () => { throw new Error("磁盘写入失败"); }).catch(() => {});
  await expect(flushPersistence()).rejects.toThrow("磁盘写入失败");
  await trackPersistence("test:write", async () => true);
  await expect(flushPersistence()).resolves.toBeUndefined();
});

test("当前页面保存不受其他页面失败污染，重复保存失败不能冒充成功", async () => {
  await trackPersistence("materials:gone", async () => { throw new Error("旧素材已删除"); }).catch(() => {});
  await expect(flushPersistence(key => key.startsWith("project:"))).resolves.toBeUndefined();
  await expect(flushPersistence(key => key.startsWith("materials:"))).rejects.toThrow("旧素材已删除");
  await expect(flushPersistence(key => key.startsWith("materials:"))).rejects.toThrow("旧素材已删除");
  discardPersistence(key => key === "materials:gone");
  await expect(flushPersistence(key => key.startsWith("materials:"))).resolves.toBeUndefined();
});

test("自动保存失败后显式保存会重试真实写入，仅成功才显示完成", async () => {
  let fail = true, persisted = 8;
  const write = async () => { if (fail) throw new Error("FPS写入失败"); persisted = 12; };
  await trackPersistence("project:fps", write).catch(() => {});
  await expect(flushPersistence(key => key === "project:fps")).rejects.toThrow("FPS写入失败");
  expect(persisted).toBe(8);
  fail = false;
  await flushPersistence(key => key === "project:fps");
  expect(persisted).toBe(12);
});

test("放弃在途编辑使迟到错误失效，不得在之后保存时复活旧写入", async () => {
  let reject!: (error: Error) => void, calls = 0;
  const work = trackPersistence("discard:late", () => { calls++; return new Promise<void>((_, fail) => { reject = fail; }); }).catch(() => {});
  discardPersistence(key => key === "discard:late");
  reject(new Error("迟到错误")); await work;
  await flushPersistence(key => key === "discard:late");
  expect(calls).toBe(1);
});

test("手动图片确认失败只报告错误，页面保存不得重放旧图片", async () => {
  let calls = 0;
  await trackPersistence("manual:image", async () => { calls++; throw new Error("图片替换失败"); }, true, false).catch(() => {});
  await expect(flushPersistence(key => key === "manual:image")).rejects.toThrow("图片替换失败");
  expect(calls).toBe(1);
  discardPersistence(key => key === "manual:image");
});
