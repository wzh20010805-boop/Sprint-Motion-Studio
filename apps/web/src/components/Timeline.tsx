import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, LockOpen, Plus, Sparkles, Trash2, Undo2 } from "lucide-react";
import { frameImageUrl, type AnimationAxis, type AnimationTrack, type AttackEffectCell, type Frame, type TimelineStep } from "../api";
import { useT } from "../i18n";
import IconBtn from "./IconBtn";
import PxSelect from "./PxSelect";
import { insertionBoundary, insertionOrder, TIMELINE_CELL_WIDTH, TIMELINE_GAP, TIMELINE_LABEL_WIDTH, TIMELINE_STRIDE } from "../timelineInsertion";

interface Props {
  axes: AnimationAxis[]; axis: AnimationAxis; tracks: AnimationTrack[]; steps: TimelineStep[]; frames: Frame[]; effects: AttackEffectCell[];
  activeTrackId: string | null; activeStepId: string | null; activeId: string | null; v: number; height?: number;
  onAxis: (id: string) => void; onAddAxis: () => void; onDeleteAxis: () => void;
  canDeleteFrame: boolean; undoDisabled: boolean; onDeleteFrame: () => void; onUndo: () => void;
  onPruneEmpty: () => void; pruneDisabled: boolean;
  onCell: (trackId: string, stepId: string, frameId: string | null) => void;
  onMoveCell: (frameId: string, trackId: string, stepId: string, copy?: boolean) => void;
  onInsertCell: (frameId: string, beforeStepId?: string) => void;
  dragDisabled?: boolean;
  onPlaceBatch: (frameIds: string[], trackId: string, stepId?: string) => void;
  onAddTrack: () => void; onPatchTrack: (track: AnimationTrack, patch: Partial<AnimationTrack>) => void;
  onDeleteTrack: (track: AnimationTrack) => void; onMoveTrack: (track: AnimationTrack, delta: number) => void;
  onAddStep: () => void; onDeleteStep: () => void; onReorderSteps: (from: number, to: number) => void; onStepDuration: (duration: number) => void;
  onContextMenu: (id: string, pos: { x: number; y: number }) => void;
}

type TimelineDrag = { kind: "step"; stepId: string; from: number } | { kind: "frame"; frameId: string; trackId: string; stepId: string; from: number };

export default function Timeline(p: Props) {
  const t = useT();
  const footerRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<TimelineDrag | null>(null);
  const [drag, setDrag] = useState<TimelineDrag | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [justDropped, setJustDropped] = useState(false);
  const hoverPoint = useRef<{ x: number; y: number } | null>(null);
  const autoScroll = useRef<number | null>(null);
  const settleAnimation = useRef<number | null>(null);
  const frameDrag = useRef<{ frameId: string; trackId: string; stepId: string; copy?: boolean } | null>(null);
  const [draggingFrameId, setDraggingFrameId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rows = [...p.tracks].sort((a, b) => b.idx - a.idx);
  const cells = useMemo(
    () => new Map(p.frames.filter((f) => f.track_id && f.step_id).map((f) => [`${f.track_id}:${f.step_id}`, f] as const)),
    [p.frames]
  );
  const effects = useMemo(() => new Map(p.effects.map((effect) => [`${effect.track_id}:${effect.step_id}`, effect] as const)), [p.effects]);
  const previewPositions = useMemo(() => new Map(
    drag && insertAt !== null ? insertionOrder(p.steps, drag.from, insertAt).map((step, index) => [step.id, index]) : []
  ), [drag, insertAt, p.steps]);
  const previewStyle = (stepId: string, index: number, trackId?: string): CSSProperties | undefined => {
    if (!drag || insertAt === null || drag.kind === "frame" && trackId !== drag.trackId) return undefined;
    const next = previewPositions.get(stepId) ?? index;
    return { transform: `translateX(${(next - index) * TIMELINE_STRIDE}px)` };
  };
  const resetDrag = (committed = false) => {
    dragRef.current = null; frameDrag.current = null; hoverPoint.current = null;
    setDrag(null); setInsertAt(null); setDraggingFrameId(null); setDropTarget(null);
    if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current);
    autoScroll.current = null;
    if (committed) {
      // 松手时数据已乐观落位，清除临时位移不能再反向播放一次。
      setJustDropped(true);
      settleAnimation.current = requestAnimationFrame(() => {
        settleAnimation.current = requestAnimationFrame(() => { setJustDropped(false); settleAnimation.current = null; });
      });
    }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && dragRef.current) resetDrag(); };
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current);
      if (settleAnimation.current !== null) cancelAnimationFrame(settleAnimation.current);
    };
  }, []);
  useEffect(() => { resetDrag(); }, [p.axis.id]);
  const startDrag = (next: TimelineDrag) => {
    if (settleAnimation.current !== null) cancelAnimationFrame(settleAnimation.current);
    settleAnimation.current = null; setJustDropped(false);
    dragRef.current = next; setDrag(next); setInsertAt(null);
  };
  const boundaryAt = (clientX: number) => insertionBoundary(clientX, gridRef.current!.getBoundingClientRect().left, p.steps.length);
  const scrollWhileDragging = () => {
    const tick = () => {
      const footer = footerRef.current, point = hoverPoint.current;
      if (!footer || !point || !dragRef.current) { autoScroll.current = null; return; }
      const box = footer.getBoundingClientRect();
      const speed = point.x < box.left + 36 ? -Math.min(16, Math.ceil((box.left + 36 - point.x) / 3))
        : point.x > box.right - 36 ? Math.min(16, Math.ceil((point.x - box.right + 36) / 3)) : 0;
      if (speed) { footer.scrollLeft += speed; if (gridRef.current) setInsertAt(boundaryAt(point.x)); }
      autoScroll.current = requestAnimationFrame(tick);
    };
    if (autoScroll.current === null) autoScroll.current = requestAnimationFrame(tick);
  };
  const internalTarget = (event: DragEvent<HTMLDivElement>) => {
    const source = dragRef.current;
    if (!source || p.dragDisabled) return null;
    if (source.kind === "step") return source;
    // 插入线位于格子间隙，event.target 可能是网格；按固定行的 Y 范围命中。
    const row = gridRef.current?.querySelector<HTMLElement>(`.tl-track[data-track-id="${CSS.escape(source.trackId)}"]`);
    const bounds = row?.getBoundingClientRect();
    return bounds && event.clientY >= bounds.top && event.clientY <= bounds.bottom && !p.tracks.find(track => track.id === source.trackId)?.locked ? source : null;
  };
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (!internalTarget(event)) { setInsertAt(null); hoverPoint.current = null; return; }
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    hoverPoint.current = { x: event.clientX, y: event.clientY };
    setInsertAt(boundaryAt(event.clientX)); setDropTarget(null); scrollWhileDragging();
  };
  const dropInsertion = (event: DragEvent<HTMLDivElement>) => {
    const source = internalTarget(event);
    if (!source) return;
    event.preventDefault(); event.stopPropagation();
    const boundary = boundaryAt(event.clientX);
    const destination = boundary > source.from ? boundary - 1 : boundary;
    const beforeStepId = p.steps[boundary]?.id;
    resetDrag(true);
    if (destination === source.from) return;
    if (source.kind === "step") p.onReorderSteps(source.from, destination);
    else p.onInsertCell(source.frameId, beforeStepId);
  };
  const assetFrameIds = (dataTransfer: DataTransfer): string[] => {
    try {
      const payload = JSON.parse(dataTransfer.getData("application/x-framebaker-frame-cell"));
      return Array.isArray(payload?.frameIds) ? payload.frameIds.filter((id: unknown): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const markerRow = drag?.kind === "frame" ? gridRef.current?.querySelector<HTMLElement>(`.tl-track[data-track-id="${CSS.escape(drag.trackId)}"]`) : null;
  const markerStyle: CSSProperties = { left: TIMELINE_LABEL_WIDTH + TIMELINE_GAP + (insertAt ?? 0) * TIMELINE_STRIDE - TIMELINE_GAP / 2,
    top: markerRow && gridRef.current ? markerRow.getBoundingClientRect().top - gridRef.current.getBoundingClientRect().top : 0,
    height: markerRow ? markerRow.getBoundingClientRect().height : "100%" };
  return <footer ref={footerRef} className="timeline timeline-matrix pixel-bar" style={p.height ? { height: p.height } : undefined}>
    <div className="tl-controls">
      <div className="tl-axis-picker">
        <span>{t("timeline.axis")}</span>
        <PxSelect
          className="tl-axis-select"
          value={p.axis.id}
          options={p.axes.map((axis) => ({ value: axis.id, label: axis.name }))}
          onChange={p.onAxis}
        />
      </div>
      <IconBtn title={t("timeline.addAxis")} disabled={p.dragDisabled} onClick={p.onAddAxis}><Plus size={13}/></IconBtn>
      <button className="px-btn" data-timeline-delete-frame title={t("timeline.deleteFrameHint")} disabled={!p.canDeleteFrame} onClick={p.onDeleteFrame}><Trash2 size={13}/>{t("timeline.deleteFrame")}</button>
      <button className="px-btn" data-timeline-undo title={t("timeline.undoHint")} disabled={p.undoDisabled} onClick={p.onUndo}><Undo2 size={13}/>{t("timeline.undo")}</button>
      <button className="px-btn" data-timeline-prune-empty disabled={p.pruneDisabled} title={t("timeline.pruneEmptyConfirm")} onClick={p.onPruneEmpty}>{t("timeline.pruneEmpty")}</button>
      <span>{t("timeline.backToFront")}</span>
      <button className="px-btn" disabled={p.dragDisabled} onClick={p.onAddTrack}><Plus size={13}/>{t("timeline.addTrack")}</button>
      <button className="px-btn" disabled={p.dragDisabled} onClick={p.onAddStep}><Plus size={13}/>{t("timeline.addStep")}</button>
      <button className="px-btn" title={t("timeline.confirmDeleteStep")} disabled={p.dragDisabled || !p.activeStepId} onClick={p.onDeleteStep}><Trash2 size={13}/>{t("timeline.deleteStep")}</button>
      <button className="px-btn" disabled={p.dragDisabled || !p.activeStepId} onClick={()=>p.onStepDuration(Math.max(1,(p.steps.find(s=>s.id===p.activeStepId)?.duration??1)-1))}>− {t("timeline.duration")}</button>
      <button className="px-btn" disabled={p.dragDisabled || !p.activeStepId} onClick={()=>p.onStepDuration(Math.min(600,(p.steps.find(s=>s.id===p.activeStepId)?.duration??1)+1))}>+ {t("timeline.duration")}</button>
    </div>
    <div ref={gridRef} className={`tl-grid ${drag && insertAt !== null ? "tl-inserting" : ""} ${justDropped ? "tl-insert-settled" : ""}`}
      style={{ gridTemplateColumns: `${TIMELINE_LABEL_WIDTH}px repeat(${p.steps.length}, ${TIMELINE_CELL_WIDTH}px)` }}
      onDragOverCapture={dragOver} onDropCapture={dropInsertion} onDragEnd={()=>resetDrag()}
      onDragLeave={(event)=>{const box=event.currentTarget.getBoundingClientRect(),footer=footerRef.current?.getBoundingClientRect();if(event.clientX<Math.max(box.left,footer?.left??box.left)||event.clientX>Math.min(box.right,footer?.right??box.right)||event.clientY<box.top||event.clientY>Math.min(box.bottom,footer?.bottom??box.bottom)){setInsertAt(null);hoverPoint.current=null;}}}>
      <div className="tl-corner">{t("timeline.topmostFirst")}</div>
      {p.steps.map((s, i) => <div key={s.id} data-step-id={s.id} className={`tl-step ${s.id === p.activeStepId ? "active" : ""} ${drag?.kind === "step" && drag.stepId === s.id ? "dragging-step" : ""}`} style={previewStyle(s.id,i)} draggable={!p.dragDisabled} title={t("timeline.dragStepInsert")}
        onDragStart={(event)=>{if(p.dragDisabled){event.preventDefault();return;}frameDrag.current=null;startDrag({kind:"step",stepId:s.id,from:i});const trackId=p.activeTrackId??p.tracks.find(track=>track.is_primary)?.id??p.tracks[0]?.id;if(trackId)p.onCell(trackId,s.id,p.frames.find(frame=>frame.track_id===trackId&&frame.step_id===s.id)?.id??null);event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("application/x-framebaker-step",JSON.stringify({stepId:s.id,axisId:p.axis.id}));}}
        onDragEnd={()=>resetDrag()}>#{i+1}<small>×{s.duration}</small></div>)}
      {rows.map((track) => <div className="tl-row" key={track.id} style={{ display: "contents" }}>
        <div
          className={`tl-track ${track.id === p.activeTrackId ? "active" : ""} ${dropTarget === `track:${track.id}` ? "drop-target" : ""}`}
          data-track-id={track.id}
          onDragOver={(e) => {
            if (p.dragDisabled || track.locked || frameDrag.current || !Array.from(e.dataTransfer.types).includes("application/x-framebaker-frame-cell")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDropTarget(`track:${track.id}`);
          }}
          onDragLeave={() => setDropTarget((current) => current === `track:${track.id}` ? null : current)}
          onDrop={(e) => {
            e.preventDefault();
            setDropTarget(null);
            if (p.dragDisabled || track.locked || frameDrag.current) return;
            const frameIds = assetFrameIds(e.dataTransfer);
            if (frameIds.length) p.onPlaceBatch(frameIds, track.id);
          }}
        >
          <span title={track.name}>{track.name}</span>
          <IconBtn title={track.visible ? t("timeline.hideTrack") : t("timeline.showTrack")} disabled={p.dragDisabled} onClick={() => p.onPatchTrack(track,{visible:track.visible?0:1})}>{track.visible?<Eye size={12}/>:<EyeOff size={12}/>}</IconBtn>
          <IconBtn title={track.locked ? t("timeline.unlockTrack") : t("timeline.lockTrack")} disabled={p.dragDisabled} onClick={() => p.onPatchTrack(track,{locked:track.locked?0:1})}>{track.locked?<Lock size={12}/>:<LockOpen size={12}/>}</IconBtn>
          <IconBtn title={t("timeline.raiseTrack")} disabled={p.dragDisabled} onClick={() => p.onMoveTrack(track,1)}><ArrowUp size={12}/></IconBtn>
          <IconBtn title={t("timeline.lowerTrack")} disabled={p.dragDisabled} onClick={() => p.onMoveTrack(track,-1)}><ArrowDown size={12}/></IconBtn>
          {!!track.is_primary && <IconBtn data-timeline-delete-axis title={t(p.axes.length <= 1 ? "timeline.onlyAxis" : "timeline.deleteWholeAxis", { name: p.axis.name })} aria-label={t("timeline.deleteWholeAxis", { name: p.axis.name })} disabled={p.dragDisabled || p.axes.length <= 1} onClick={p.onDeleteAxis}><Trash2 size={12}/></IconBtn>}
          {!track.is_primary && <IconBtn title={t("timeline.deleteTrack")} disabled={p.dragDisabled} onClick={() => p.onDeleteTrack(track)}><Trash2 size={12}/></IconBtn>}
        </div>
        {p.steps.map((step, index) => {
          const f=cells.get(`${track.id}:${step.id}`) ?? null; const effect=effects.get(`${track.id}:${step.id}`) ?? null; const targetKey=`${track.id}:${step.id}`;
          return <div
            key={step.id}
            data-track-id={track.id} data-step-id={step.id} data-frame-id={f?.id??""}
            className={`tl-cell ${track.id===p.activeTrackId&&step.id===p.activeStepId?"active":""} ${effect?"has-effect":""} ${f&&!track.locked?"draggable":""} ${f?.id===draggingFrameId?"dragging":""} ${dropTarget===targetKey?"drop-target":""}`}
            style={previewStyle(step.id,index,track.id)}
            draggable={!!f&&!track.locked&&!p.dragDisabled}
            onDragStart={(e)=>{if(!f||track.locked||p.dragDisabled){e.preventDefault();return;}frameDrag.current={frameId:f.id,trackId:track.id,stepId:step.id};startDrag({kind:"frame",frameId:f.id,trackId:track.id,stepId:step.id,from:index});setDraggingFrameId(f.id);p.onCell(track.id,step.id,f.id);e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("application/x-framebaker-frame-cell",JSON.stringify(frameDrag.current));}}
            onDragOver={(e)=>{if(!p.dragDisabled&&!track.locked&&(frameDrag.current||Array.from(e.dataTransfer.types).includes("application/x-framebaker-frame-cell"))){e.preventDefault();e.dataTransfer.dropEffect=frameDrag.current?"move":"copy";setDropTarget(targetKey);}}}
            onDragLeave={()=>{if(!dragRef.current)setDropTarget((current)=>current===targetKey?null:current);}}
            onDrop={(e)=>{e.preventDefault();if(p.dragDisabled){resetDrag();return;}const reset=()=>{frameDrag.current=null;setDraggingFrameId(null);setDropTarget(null);};if(frameDrag.current){const s=frameDrag.current;reset();if(!track.locked&&(s.copy||s.trackId!==track.id||s.stepId!==step.id))p.onMoveCell(s.frameId,track.id,step.id,s.copy);return;}try{const payload=JSON.parse(e.dataTransfer.getData("application/x-framebaker-frame-cell"));if(Array.isArray(payload?.frameIds)&&payload.frameIds.length){reset();if(!track.locked)p.onPlaceBatch(payload.frameIds,track.id,step.id);return;}if(payload?.frameId){reset();const copy=payload.copy===true;if(!track.locked&&(copy||payload.trackId!==track.id||payload.stepId!==step.id))p.onMoveCell(payload.frameId,track.id,step.id,copy);return;}}catch{/* 忽略外部无效拖放 */}reset();}}
            onDragEnd={()=>resetDrag()}
            onClick={() => p.onCell(track.id,step.id,f?.id??null)}
            onContextMenu={(e)=>{if(!f)return;e.preventDefault();p.onContextMenu(f.id,{x:e.clientX,y:e.clientY});}}
            title={effect?t("attackEffect.cellHint"):f?(track.locked?t("timeline.lockedCell"):t("timeline.dragFrameInsert")):t("timeline.emptyCell")}
          >{f&&<img src={frameImageUrl(f.id,p.v,128)} alt="" draggable={false} loading="lazy" decoding="async"/>}{effect&&<span className="tl-effect-mark"><Sparkles size={15}/></span>}</div>;
        })}
      </div>)}
      {!p.steps.length && <div className="tl-empty">{t("msg.timeline_empty_import_materials_first")}</div>}
      {drag&&insertAt!==null&&<div data-timeline-insert-marker data-kind={drag.kind} data-insert-index={insertAt} data-before-step-id={p.steps[insertAt]?.id??""} className="tl-insert-marker" style={markerStyle} aria-hidden="true"><span>{t("timeline.insertHere")}</span></div>}
    </div>
  </footer>;
}
