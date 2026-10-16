import { expect, test } from "bun:test";
import { EditingCommandStore } from "../apps/web/src/editingCommandStore";

test("保存等待当前工作台完成，期间不重复提交", async () => {
  const store = new EditingCommandStore();
  let resolve!: () => void;
  let persisted = false;
  store.register(() => ({ label: "项目", save: async () => { await new Promise<void>(r => { resolve = r; }); persisted = true; } }));
  const saving = store.execute("save");
  expect(store.getSnapshot().busy).toBe(true);
  expect(persisted).toBe(false);
  expect(await store.execute("save")).toBe(false);
  resolve();
  expect(await saving).toBe(true);
  expect(persisted).toBe(true);
  expect(store.getSnapshot().result).toBe("saved");
});

test("活动弹窗优先且隐藏工作台不抢父页面的撤销", async () => {
  const store = new EditingCommandStore();
  const actions: string[] = [];
  store.register(() => ({ label: "项目", undo: () => { actions.push("project"); } }));
  let visible = true;
  const close = store.register(() => ({ label: "图片编辑", priority: 100, available: () => visible, undo: () => { actions.push("image"); } }));
  await store.execute("undo");
  visible = false;
  store.refresh();
  await store.execute("undo");
  expect(actions).toEqual(["image", "project"]);
  close();
});

test("失败保存不可显示已保存，且不能自动回退到父上下文", async () => {
  const store = new EditingCommandStore();
  store.register(() => ({ label: "项目", save: () => { throw new Error("不应调用父页"); } }));
  store.register(() => ({ label: "设置", priority: 100, save: async () => false }));
  await expect(store.execute("save")).rejects.toThrow("EDIT_COMMAND_INCOMPLETE");
  expect(store.getSnapshot().result).toBe("failed");
  expect(store.getSnapshot().busy).toBe(false);
});

test("不支持撤销的当前上下文屏蔽父页面，离开页面后不显示旧保存结果", async () => {
  const store = new EditingCommandStore();
  let completed!: () => void;
  const unregister = store.register(() => ({ label: "旧页面", save: () => new Promise<void>(r => { completed = r; }) }));
  const work = store.execute("save");
  unregister();
  store.register(() => ({ label: "审核", priority: 100 }));
  completed(); await work;
  expect(store.getSnapshot().label).toBe("审核");
  expect(store.getSnapshot().result).toBe("idle");
  expect(await store.execute("undo")).toBe(false);
});
