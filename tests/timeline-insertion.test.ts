import { expect, test } from "bun:test";
import { insertionBoundary, insertionOrder, TIMELINE_STRIDE } from "../apps/web/src/timelineInsertion";

test("插入前后边界保留全序列，不交换或覆盖，源位和紧邻后方不改变顺序", () => {
  const items = ["a", "b", "c", "d"];
  expect(insertionOrder(items, 0, 4)).toEqual(["b", "c", "d", "a"]);
  expect(insertionOrder(items, 3, 0)).toEqual(["d", "a", "b", "c"]);
  expect(insertionOrder(items, 1, 3)).toEqual(["a", "c", "b", "d"]);
  expect(insertionOrder(items, 1, 1)).toEqual(items);
  expect(insertionOrder(items, 1, 2)).toEqual(items);
  expect(items).toEqual(["a", "b", "c", "d"]);
});

test("鼠标左右半格映射原始插入边界，水平滚动后仍正确", () => {
  const left = 20, first = left + 194;
  expect(insertionBoundary(first + 8, left, 4)).toBe(0);
  expect(insertionBoundary(first + 48, left, 4)).toBe(1);
  expect(insertionBoundary(first + 2 * TIMELINE_STRIDE + 8, left, 4)).toBe(2);
  expect(insertionBoundary(first + 2 * TIMELINE_STRIDE + 48, left, 4)).toBe(3);
  expect(insertionBoundary(first + 3 * TIMELINE_STRIDE + 48, left, 4)).toBe(4);
  expect(insertionBoundary(first + 48 - 120, left - 120, 4)).toBe(1);
  expect(insertionBoundary(-500, left, 4)).toBe(0);
  expect(insertionBoundary(5000, left, 4)).toBe(4);
});
