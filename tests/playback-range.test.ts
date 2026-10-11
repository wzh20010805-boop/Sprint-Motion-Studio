import { describe, expect, test } from "bun:test";
import { normalizePlaybackRange, advancePlaybackTick } from "../apps/web/src/playbackRange";

describe("指定时间轴帧范围预览", () => {
  test("默认包含全部帧，用户帧号对应零起始游标", () => {
    expect(normalizePlaybackRange(48, null)).toEqual({ start: 0, end: 47 });
    expect(normalizePlaybackRange(48, { start: 9, end: 29 })).toEqual({ start: 9, end: 29 });
  });

  test("第 30 帧播完回到第 10 帧，不进入范围外", () => {
    const steps = Array.from({ length: 48 }, () => ({ duration: 1 }));
    expect(advancePlaybackTick(steps, { cursor: 28, tick: 0 }, { start: 9, end: 29 })).toEqual({ cursor: 29, tick: 0 });
    expect(advancePlaybackTick(steps, { cursor: 29, tick: 0 }, { start: 9, end: 29 })).toEqual({ cursor: 9, tick: 0 });
  });

  test("范围内仍按每帧 duration 停留，末帧不会提前跳过", () => {
    const steps = [{ duration: 1 }, { duration: 3 }, { duration: 2 }, { duration: 1 }];
    const range = { start: 1, end: 2 };
    expect(advancePlaybackTick(steps, { cursor: 1, tick: 0 }, range)).toEqual({ cursor: 1, tick: 1 });
    expect(advancePlaybackTick(steps, { cursor: 1, tick: 2 }, range)).toEqual({ cursor: 2, tick: 0 });
    expect(advancePlaybackTick(steps, { cursor: 2, tick: 0 }, range)).toEqual({ cursor: 2, tick: 1 });
    expect(advancePlaybackTick(steps, { cursor: 2, tick: 1 }, range)).toEqual({ cursor: 1, tick: 0 });
  });

  test("只选一帧时始终停留该帧", () => {
    expect(advancePlaybackTick([{ duration: 1 }, { duration: 2 }], { cursor: 1, tick: 1 }, { start: 1, end: 1 })).toEqual({ cursor: 1, tick: 0 });
  });

  test("删帧后范围收缩到剩余帧，越界游标回到起点并重新计时", () => {
    expect(normalizePlaybackRange(3, { start: 9, end: 29 })).toEqual({ start: 2, end: 2 });
    expect(advancePlaybackTick([{ duration: 2 }, { duration: 2 }, { duration: 2 }], { cursor: 8, tick: 1 }, { start: 1, end: 2 })).toEqual({ cursor: 1, tick: 0 });
  });

  test("空时间轴不推进，也不产生负数游标", () => {
    expect(normalizePlaybackRange(0, { start: 2, end: 4 })).toEqual({ start: 0, end: 0 });
    expect(advancePlaybackTick([], { cursor: 4, tick: 3 }, null)).toEqual({ cursor: 0, tick: 0 });
  });

  test("反向、非有限数和小数输入归一到有效整数范围", () => {
    expect(normalizePlaybackRange(8, { start: 5, end: 2 })).toEqual({ start: 5, end: 5 });
    expect(normalizePlaybackRange(8, { start: NaN, end: Infinity })).toEqual({ start: 0, end: 7 });
    expect(normalizePlaybackRange(8, { start: -3, end: 5.9 })).toEqual({ start: 0, end: 5 });
  });
});
