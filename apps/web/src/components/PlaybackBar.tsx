import { useEffect, useState, type RefObject } from "react";
import { motion, useDragControls } from "motion/react";
import { GripHorizontal, Pause, Play } from "lucide-react";
import { useT } from "../i18n";
import IconBtn from "./IconBtn";
import type { PlaybackRange } from "../playbackRange";

interface Props {
  dragConstraints: RefObject<HTMLDivElement | null>;
  fps: number;
  paused: boolean;
  cursor: number;
  total: number;
  zoom: number;
  range: PlaybackRange | null;
  onRangeChange: (range: PlaybackRange | null) => void;
  onTogglePause: () => void;
  onFpsChange: (fps: number) => void;
}

/** 播放控制条：覆盖在画布内部且可拖动（不挤占布局），仅播放时显示 */
export default function PlaybackBar({ dragConstraints, fps, paused, cursor, total, zoom, range, onRangeChange, onTogglePause, onFpsChange }: Props) {
  const t = useT();
  const dragControls = useDragControls();
  const start = (range?.start ?? 0) + 1;
  const end = (range?.end ?? Math.max(0, total - 1)) + 1;
  const [startDraft, setStartDraft] = useState(String(start));
  const [endDraft, setEndDraft] = useState(String(end));
  useEffect(() => { setStartDraft(String(start)); setEndDraft(String(end)); }, [start, end, range === null]);
  // 提交后才校验，允许连续输入多位帧号；空值取消，越界值限于当前时间轴。
  const commit = (which: "start" | "end", draft: string) => {
    if (!draft.trim() || !Number.isFinite(Number(draft))) {
      setStartDraft(String(start)); setEndDraft(String(end));
      return;
    }
    const value = Math.min(total, Math.max(1, Math.trunc(Number(draft))));
    const next = which === "start"
      ? { start: value - 1, end: Math.max(value, end) - 1 }
      : { start: Math.min(start, value) - 1, end: value - 1 };
    setStartDraft(String(next.start + 1)); setEndDraft(String(next.end + 1));
    onRangeChange(next);
  };
  return (
    <motion.div
      className="playback-bar"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.15 }}
      drag
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={dragConstraints}
      dragElastic={0}
      dragMomentum={false}
    >
      <button
        type="button"
        className="playback-drag-handle"
        title={t("msg.drag_playback_controls")}
        aria-label={t("msg.drag_playback_controls")}
        onPointerDown={(event) => dragControls.start(event)}
      >
        <GripHorizontal size={15} />
      </button>
      <IconBtn onClick={onTogglePause} title={paused ? t("msg.continue") : t("msg.pause")}>
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </IconBtn>
      <label className="fps-ctl">
        FPS
        <input type="range" min={1} max={24} value={fps} onChange={(e) => onFpsChange(Number(e.target.value))} />
        <span>{fps}</span>
      </label>
      <div className="playback-range" title={t("playback.rangeHint")}>
        <select aria-label={t("playback.mode")} value={range === null ? "all" : "range"} disabled={total === 0}
          onChange={(event) => onRangeChange(event.target.value === "all" ? null : { start: 0, end: total - 1 })}>
          <option value="all">{t("playback.all")}</option>
          <option value="range">{t("playback.range")}</option>
        </select>
        {range !== null && <>
          <label>{t("playback.start")}<input type="number" min={1} max={total} step={1} aria-label={t("playback.start")}
            value={startDraft} onChange={(event) => setStartDraft(event.target.value)} onBlur={() => commit("start", startDraft)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
          <label>{t("playback.end")}<input type="number" min={1} max={total} step={1} aria-label={t("playback.end")}
            value={endDraft} onChange={(event) => setEndDraft(event.target.value)} onBlur={() => commit("end", endDraft)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
        </>}
      </div>
      <span className="frame-indicator">{total ? `${cursor + 1} / ${total}` : "0 / 0"}</span>
      <span className="fps-ctl" title={t("msg.toolbar_or_cmd_ctrl_wheel_to_zoom")}>{t("msg.zoom_pct", { pct: Math.round(zoom * 100) })}</span>
    </motion.div>
  );
}
