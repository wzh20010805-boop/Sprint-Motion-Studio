export const TIMELINE_LABEL_WIDTH = 190;
export const TIMELINE_CELL_WIDTH = 64;
export const TIMELINE_GAP = 4;
export const TIMELINE_STRIDE = TIMELINE_CELL_WIDTH + TIMELINE_GAP;

/** 插入边界以原序列为准；先取出源项，再插入，避免向右移动时多算一格。 */
export function insertionOrder<T>(items: readonly T[], from: number, boundary: number): T[] {
  const order = [...items];
  if (!Number.isInteger(from) || from < 0 || from >= items.length || !Number.isInteger(boundary) || boundary < 0 || boundary > items.length) return order;
  const [item] = order.splice(from, 1);
  order.splice(boundary > from ? boundary - 1 : boundary, 0, item!);
  return order;
}

/** 始终按原网格坐标命中，已让位的卡片不会把鼠标目标推来推去。 */
export function insertionBoundary(clientX: number, gridLeft: number, count: number): number {
  const x = clientX - gridLeft - TIMELINE_LABEL_WIDTH - TIMELINE_GAP;
  const index = Math.floor(x / TIMELINE_STRIDE);
  const after = x - index * TIMELINE_STRIDE >= TIMELINE_CELL_WIDTH / 2;
  return Math.max(0, Math.min(count, index + (after ? 1 : 0)));
}
