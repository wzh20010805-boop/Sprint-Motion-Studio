import { expect, test } from "bun:test";
import { GroupedSettingsHistory, SettingsWriteError } from "../../apps/web/src/settingsEditHistory";

const initial = { providers: [{ name: "first" }], matting: { model: "u2net" }, queue: 2 };
const keys = ["providers", "matting", "queue"] as const;
function history() {
  return new GroupedSettingsHistory(initial, keys, (key, value) => {
    if (key === "queue" && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 16)) throw new Error("INVALID_QUEUE");
    return structuredClone(value);
  });
}

test("本地逐次撤销不写后端，保存只提交脏组", async () => {
  const h = history(), writes: string[] = [];
  h.reset(initial, initial);
  h.edit("matting", { model: "birefnet" });
  h.edit("queue", 4);
  await h.undo(async key => { writes.push(key); });
  expect(h.current.queue).toBe(2);
  expect(h.current.matting.model).toBe("birefnet");
  expect(writes).toEqual([]);
  await h.save(keys, async key => { writes.push(key); });
  expect(writes).toEqual(["matting"]);
  expect(h.dirty).toBeFalse();
  expect(h.canUndo).toBeTrue();
});

test("分组保存后撤销真实写回原始配置，保留旧版隐藏字段", async () => {
  const h = history(), writes: Array<[string, unknown]> = [];
  const raw = { ...initial, providers: [{ name: "first", legacyField: "preserve-existing-field" }] };
  h.reset(initial, raw);
  h.edit("providers", [{ name: "changed" }]);
  h.edit("queue", 3);
  await h.save(["providers"], async (key, value) => { writes.push([key, value]); });
  expect(h.dirtyKeys).toEqual(["queue"]);
  await h.undo(async (key, value) => { writes.push([key, value]); });
  expect(h.current.queue).toBe(2);
  expect(writes).toHaveLength(1);
  await h.undo(async (key, value) => { writes.push([key, value]); });
  expect(writes).toEqual([["providers", [{ name: "changed" }]], ["providers", raw.providers]]);
  expect(h.current).toEqual(initial);
  expect(h.dirty).toBeFalse();
  expect(h.canUndo).toBeFalse();
});

test("保存部分失败维护已写入基线，重试不重复提交已完成的组", async () => {
  const h = history(), writes: string[] = [];
  h.reset(initial, initial);
  h.edit("providers", [{ name: "changed" }]);
  h.edit("matting", { model: "new" });
  h.edit("queue", 6);
  let failure: unknown;
  try { await h.save(keys, async key => { writes.push(key); if (key === "matting") throw new Error("network unavailable"); }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SettingsWriteError);
  expect((failure as SettingsWriteError).completed).toEqual(["providers"]);
  expect((failure as SettingsWriteError).remaining).toEqual(["matting", "queue"]);
  expect(h.dirtyKeys).toEqual(["matting", "queue"]);
  await h.save(keys, async key => { writes.push(key); });
  expect(writes).toEqual(["providers", "matting", "matting", "queue"]);
  expect(h.dirty).toBeFalse();
});

test("保存前完整验证，失败不写任何分组且 false 响应不得标成成功", async () => {
  const h = history(), writes: string[] = [];
  h.reset(initial, initial);
  h.edit("providers", [{ name: "changed" }]);
  h.edit("queue", 0);
  await expect(h.save(keys, async key => { writes.push(key); })).rejects.toThrow("INVALID_QUEUE");
  expect(writes).toEqual([]);
  expect(h.dirtyKeys).toEqual(["providers", "queue"]);
  h.edit("queue", 2);
  await expect(h.save(keys, async () => false)).rejects.toBeInstanceOf(SettingsWriteError);
  expect(h.dirtyKeys).toEqual(["providers"]);
});

test("已保存编辑撤销失败不丢历史或草稿，重试成功才消费步骤", async () => {
  const h = history();
  h.reset(initial, initial);
  h.edit("queue", 8);
  await h.save(["queue"], async () => true);
  await expect(h.undo(async () => { throw new Error("not saved"); })).rejects.toBeInstanceOf(SettingsWriteError);
  expect(h.current.queue).toBe(8);
  expect(h.canUndo).toBeTrue();
  const writes: unknown[] = [];
  await h.undo(async (_key, value) => { writes.push(value); });
  expect(writes).toEqual([2]);
  expect(h.current.queue).toBe(2);
  expect(h.canUndo).toBeFalse();
});

test("正在写入时禁止并发编辑和保存，避免覆盖不明的配置基线", async () => {
  const h = history();
  h.reset(initial, initial);
  h.edit("queue", 4);
  let release!: () => void;
  const saving = h.save(["queue"], () => new Promise<void>(resolve => { release = resolve; }));
  expect(h.busy).toBeTrue();
  expect(() => h.edit("queue", 5)).toThrow("SETTINGS_BUSY");
  await expect(h.save(keys, async () => true)).rejects.toThrow("SETTINGS_BUSY");
  release(); await saving;
  expect(h.current.queue).toBe(4);
  expect(h.busy).toBeFalse();
});
