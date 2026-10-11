export interface PlaybackRange { start: number; end: number }
export interface PlaybackPosition { cursor: number; tick: number }

export function normalizePlaybackRange(total: number, requested: PlaybackRange | null): PlaybackRange {
  const last = Math.max(0, total - 1);
  const clamp = (value: number, fallback: number) => Number.isFinite(value) ? Math.min(last, Math.max(0, Math.trunc(value))) : fallback;
  const start = clamp(requested?.start ?? 0, 0);
  return { start, end: Math.max(start, clamp(requested?.end ?? last, last)) };
}

export function advancePlaybackTick(steps: readonly { duration: number }[], position: PlaybackPosition, requested: PlaybackRange | null): PlaybackPosition {
  if (steps.length === 0) return { cursor: 0, tick: 0 };
  const { start, end } = normalizePlaybackRange(steps.length, requested);
  if (position.cursor < start || position.cursor > end) return { cursor: start, tick: 0 };
  const tick = position.tick + 1;
  const duration = Math.max(1, steps[position.cursor]?.duration ?? 1);
  return tick >= duration
    ? { cursor: position.cursor >= end ? start : position.cursor + 1, tick: 0 }
    : { cursor: position.cursor, tick };
}
