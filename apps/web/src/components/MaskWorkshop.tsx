import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Eraser, Paintbrush, Scan, Sparkles, Undo2, X, Download } from 'lucide-react';
import type { Frame, MaskStroke } from '@framebaker/shared';
import { maskApi, type MaskState } from '../maskApi';
import { askConfirm, notify } from '../notice';
import { useT } from '../i18n';
import { hasVisibleForeground } from '../maskPixels';
import { useEditingCommands } from '../editingCommands';

type View='checker'|'raw'|'alpha'|'black'|'white';
type Tool='erase'|'restore'|'region';
const loadImage=(src:string)=>new Promise<HTMLImageElement>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('图像读取失败'));image.src=src;});

/** 遮罩笔刷始终使用完整原图坐标；修订交给共享后端，原图不写回。 */
export default function MaskWorkshop({projectId,frames,initialId,onClose,onChanged}:{projectId:string;frames:Frame[];initialId:string|null;onClose:()=>void;onChanged:()=>void}) {
 const t=useT();
 const commandScope=useRef<HTMLDivElement>(null);
 const [index,setIndex]=useState(Math.max(0,frames.findIndex(f=>f.id===initialId)));
 const [refresh,setRefresh]=useState(0);
 const [reviewed,setReviewed]=useState<Set<string>>(new Set());
 const frame=frames[index];
 const currentIndex=useRef(index),currentFrameId=useRef(frame?.id),confirmPending=useRef(false);
 currentIndex.current=index;currentFrameId.current=frame?.id;
 const [state,setState]=useState<MaskState|null>(null), [strokes,setStrokes]=useState<MaskStroke[]>([]);
 const [tool,setTool]=useState<Tool>('region'),[view,setView]=useState<View>('raw'),[size,setSize]=useState(16);
 const [invisible,setInvisible]=useState(false);
 const [region,setRegion]=useState<[number,number,number,number]|undefined>(),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [jobId,setJobId]=useState<string|null>(null),[progress,setProgress]=useState(''),[abnormal,setAbnormal]=useState<Record<string,string[]>>({}),[scope,setScope]=useState<'all'|'frame'>('all');
 const canvas=useRef<HTMLCanvasElement>(null), raw=useRef<HTMLImageElement|null>(null), mask=useRef<HTMLImageElement|null>(null);
 const drawing=useRef<MaskStroke|null>(null), regionStart=useRef<[number,number]|null>(null), liveRegion=useRef<[number,number,number,number]|undefined>(undefined);
 const strokeRef=useRef(strokes);strokeRef.current=strokes;
 useEffect(()=>{let dead=false;maskApi.resume(projectId).then(id=>{if(!dead&&id){setBusy(true);setJobId(id);}}).catch(e=>notify(e.message));return()=>{dead=true;};},[projectId]);
 useEffect(()=>{let dead=false;maskApi.summary(projectId).then(list=>{if(dead)return;setReviewed(new Set(list.filter(f=>f.reviewed).map(f=>f.id)));setAbnormal(Object.fromEntries(list.flatMap(f=>{const reasons=f.info?JSON.parse(f.info).reasons:[];return reasons?.length?[[f.id,reasons]]:[];})));}).catch(e=>notify(e.message));return()=>{dead=true;};},[projectId,state?.version_id,state?.reviewed]);
 const render=()=>{
  const c=canvas.current,r=raw.current;if(!c||!r)return;
  c.width=r.naturalWidth;c.height=r.naturalHeight;
  const area=c.parentElement!;const fit=Math.max(.1,Math.min((area.clientWidth-24)/c.width,(area.clientHeight-24)/c.height));
  c.style.width=`${c.width*fit}px`;c.style.height=`${c.height*fit}px`;
  const ctx=c.getContext('2d')!;ctx.clearRect(0,0,c.width,c.height);
  if(view==='raw')ctx.drawImage(r,0,0);
  else {
   const mc=document.createElement('canvas');mc.width=c.width;mc.height=c.height;const mctx=mc.getContext('2d')!;
   if(mask.current)mctx.drawImage(mask.current,0,0);else {mctx.fillStyle='white';mctx.fillRect(0,0,c.width,c.height);}
   for(const s of [...strokeRef.current,...(drawing.current?[drawing.current]:[])]) {
    mctx.strokeStyle=mctx.fillStyle=s.mode==='erase'?'black':'white';mctx.lineWidth=s.size;mctx.lineCap='round';mctx.lineJoin='round';mctx.beginPath();
    s.points.forEach(([x,y],i)=>i?mctx.lineTo(x,y):mctx.moveTo(x,y));mctx.stroke();
    if(s.points.length===1){mctx.beginPath();mctx.arc(s.points[0]![0],s.points[0]![1],s.size/2,0,Math.PI*2);mctx.fill();}
   }
   if(view==='alpha')ctx.drawImage(mc,0,0);
   else {ctx.drawImage(r,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height),alpha=mctx.getImageData(0,0,c.width,c.height);for(let i=3;i<pixels.data.length;i+=4)pixels.data[i]=Math.round(pixels.data[i]!*alpha.data[i-3]!/255);ctx.putImageData(pixels,0,0);}
  }
  const rect=liveRegion.current??region;
  if(rect){ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--pink').trim();ctx.lineWidth=Math.max(1,c.width/250);ctx.setLineDash([8,4]);ctx.strokeRect(...rect);ctx.setLineDash([]);}
 };
 const reload=async()=>{const id=frame!.id,next=await maskApi.state(id);if(currentFrameId.current===id){setState(next);setRefresh(v=>v+1);}return next;};
 useEffect(()=>{
  let dead=false;setLoading(true);setState(null);setStrokes([]);setInvisible(false);raw.current=null;mask.current=null;
  if(!frame)return;
  maskApi.state(frame.id).then(async s=>{
   const [r,m]=await Promise.all([loadImage(maskApi.image(frame.id,'raw')+'&v='+s.revision),s.current?loadImage(maskApi.image(frame.id,'mask',s.version_id)):Promise.resolve(null)]);
   if(dead||currentFrameId.current!==frame.id)return;
   if(m){const mc=document.createElement('canvas');mc.width=m.naturalWidth;mc.height=m.naturalHeight;const ctx=mc.getContext('2d')!;ctx.drawImage(m,0,0);const pixels=ctx.getImageData(0,0,mc.width,mc.height).data;ctx.clearRect(0,0,mc.width,mc.height);ctx.drawImage(r,0,0);setInvisible(!hasVisibleForeground(ctx.getImageData(0,0,mc.width,mc.height).data,pixels));}
   raw.current=r;mask.current=m;setState(s);setLoading(false);
  }).catch(e=>{if(!dead&&currentFrameId.current===frame.id){notify(e.message);setLoading(false);}});
  return()=>{dead=true;};
 },[frame?.id,refresh]);
 useEffect(()=>{render();},[strokes,view,region,loading]);
 useEffect(()=>{const area=canvas.current?.parentElement;if(!area)return;const observer=new ResizeObserver(()=>render());observer.observe(area);return()=>observer.disconnect();},[view,region,loading]);
 useEffect(()=>{
  if(!jobId)return;let dead=false;
  let polling=false;
  const poll=async()=>{if(polling)return;polling=true;try{const job=await maskApi.job(jobId);if(dead)return;setProgress(job.data.job.progress??'');if(['waiting_user','succeeded','failed','cancelled','interrupted'].includes(job.status)){
   setJobId(null);setBusy(false);if(job.status==='waiting_user'||job.status==='succeeded'){const anomalies=job.data.job.result?.abnormal_frames??[];setAbnormal(Object.fromEntries(anomalies.map((f:any)=>[f.id,f.reasons])));await reload();onChanged();setTool('erase');setView('checker');setRegion(undefined);setProgress(t('p2.reviewHint'));}else {setView('raw');setTool('region');setProgress(t('p2.failedPreserved'));notify(job.error?.message??job.data.job.error??job.status);}
  }}catch(e){if(!dead){notify((e as Error).message);setJobId(null);setBusy(false);}}finally{polling=false;}};
  void poll();const timer=setInterval(poll,1000);return()=>{dead=true;clearInterval(timer);};
 },[jobId]);
 const safely=async(work:()=>Promise<void>)=>{setBusy(true);try{await work();onChanged();return true;}catch(e){notify((e as Error).message);return false;}finally{setBusy(false);}};
 const discardStrokes=async()=>{
  if(!strokeRef.current.length)return true;
  confirmPending.current=true;
  try{return await askConfirm(t('p2.discard'));}finally{confirmPending.current=false;}
 };
 const switchFrame=async(next:number)=>{
  const bounded=Math.max(0,Math.min(frames.length-1,next));
  if(busy||confirmPending.current||drawing.current||regionStart.current||!frames.length||bounded===currentIndex.current)return;
  if(strokeRef.current.length&&!await discardStrokes())return;
  // 同一轮连续按键立即看到新索引；较慢的旧图片请求不能回写当前帧。
  currentIndex.current=bounded;currentFrameId.current=frames[bounded]!.id;
  setStrokes([]);setIndex(bounded);
 };
 const close=async()=>{if(busy||confirmPending.current)return;if(!await discardStrokes())return;onClose();};
 useEffect(()=>{
  const key=(e:KeyboardEvent)=>{
   if(e.defaultPrevented||e.isComposing||e.keyCode===229||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||document.querySelector('.confirm-mask'))return;
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();void close();return;}
   if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
   const target=e.target as HTMLElement|null;
   if(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
   e.preventDefault();e.stopImmediatePropagation();
   void switchFrame(currentIndex.current+(e.key==='ArrowLeft'?-1:1));
  };
  window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
 },[busy,frames,strokes]);
 const point=(e:React.PointerEvent):[number,number]=>{const c=canvas.current!,box=c.getBoundingClientRect();return [Math.max(0,Math.min(c.width-1,Math.round((e.clientX-box.left)*c.width/box.width))),Math.max(0,Math.min(c.height-1,Math.round((e.clientY-box.top)*c.height/box.height)))];};
 const start=(e:React.PointerEvent<HTMLCanvasElement>)=>{
  if(busy||loading||e.button!==0)return;
  if(tool!=='region'&&(!state?.current||view==='raw'))return;
  e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);
  if(tool==='region')regionStart.current=p;else drawing.current={mode:tool,size,points:[p]};render();
 };
 const move=(e:React.PointerEvent<HTMLCanvasElement>)=>{
  const p=point(e);if(drawing.current){drawing.current.points.push(p);render();}
  if(regionStart.current){const a=regionStart.current;liveRegion.current=[Math.min(a[0],p[0]),Math.min(a[1],p[1]),Math.abs(a[0]-p[0])+1,Math.abs(a[1]-p[1])+1];render();}
 };
 const end=()=>{
  if(drawing.current){const stroke=drawing.current;setStrokes(s=>[...s,stroke]);drawing.current=null;}
  if(regionStart.current){setRegion(liveRegion.current);liveRegion.current=undefined;regionStart.current=null;}
 };
 const begin=async()=>{
  if(strokes.length&&!await askConfirm(t('p2.discard')))return;
  setStrokes([]);setBusy(true);try {const result=await maskApi.matte({project_id:projectId,frame_ids:scope==='all'?frames.map(f=>f.id):[frame!.id],region});setJobId(result.job_id);setProgress(t('p2.processing'));}catch(e){notify((e as Error).message);setBusy(false);}
 };
 const save=async()=>{if(busy||loading||!state||!frame||drawing.current||!strokeRef.current.length)return false;return safely(async()=>{const result=await maskApi.save(frame.id,state,strokeRef.current);setStrokes([]);setState(result);setRefresh(v=>v+1);setProgress(t('p2.saved'));});};
 const undo=async()=>{if(busy||loading||drawing.current)return false;if(strokeRef.current.length){setStrokes(s=>s.slice(0,-1));return true;}if(!frame||!state?.current?.parent_id)return false;return safely(async()=>{setState(await maskApi.undo(frame.id,state));setRefresh(v=>v+1);});};
 useEditingCommands({label:t('p2.title'),priority:100,scope:commandScope,save,undo,canSave:!!state&&!!strokes.length,canUndo:!!strokes.length||!!state?.current?.parent_id,busy:busy||loading,dirty:!!strokes.length});
 const reasons=state?.source_changed?['SOURCE_CHANGED']:[...new Set([...(abnormal[frame?.id??'']??(state?.current?JSON.parse(state.current.info).reasons:[])??[]),...(invisible?['LOW_CONFIDENCE']:[])])];
 return <div ref={commandScope} className="modal-mask mask-workshop-backdrop"><section className="mask-workshop" role="dialog" aria-modal="true" aria-label={t('p2.title')}>
  <header className="mask-heading"><div><span className="candy-eyebrow">CUTOUT LAB / 02</span><h2><Sparkles size={24}/>{t('p2.title')}</h2><p>{t('p2.subtitle')}</p></div><button className="icon-btn" onClick={()=>void close()} aria-label={t('common.close')}><X size={20}/></button></header>
  <div className="mask-layout">
   <aside className="mask-controls"><span className="candy-step">01 / {t('p2.initial')}</span>
    <p>{t('p2.regionHint')}</p><button className={`px-btn ${tool==='region'?'accent':''}`} onClick={()=>{setTool('region');setView('raw');}} disabled={busy}><Scan size={16}/>{t('p2.region')}</button>
    {region&&<div className="mask-region"><code>{region.join(' / ')}</code><button className="px-btn small" disabled={busy} onClick={()=>setRegion(undefined)}>{t('p2.clearRegion')}</button></div>}
    <label>{t('p2.scope')}<select className="px-input" value={scope} disabled={busy} onChange={e=>setScope(e.target.value as 'all'|'frame')}><option value="all">{t('p2.allFrames',{n:frames.length})}</option><option value="frame">{t('p2.currentFrame')}</option></select></label>
    <button className="px-btn accent" disabled={busy||loading} onClick={()=>void begin()}><Sparkles size={16}/>{t('p2.generate')}</button>
    {jobId&&<button className="px-btn danger" onClick={()=>void maskApi.cancel(jobId).catch(e=>notify(e.message))}>{t('msg.cancel_job')}</button>}
    <span className="candy-step">02 / {t('p2.refine')}</span>
    <div className="mask-tool-pair"><button className={`px-btn ${tool==='erase'?'accent':''}`} disabled={busy||!state?.current} onClick={()=>{setTool('erase');if(view==='raw')setView('checker');}}><Eraser size={16}/>{t('p2.erase')}</button><button className={`px-btn ${tool==='restore'?'accent-cyan':''}`} disabled={busy||!state?.current} onClick={()=>{setTool('restore');if(view==='raw')setView('checker');}}><Paintbrush size={16}/>{t('p2.restore')}</button></div>
    <label>{t('p2.brushSize')} <strong>{size} px</strong><input type="range" min="1" max="128" value={size} onChange={e=>setSize(Number(e.target.value))} disabled={busy}/></label>
    <button className="px-btn" disabled={busy||(!strokes.length&&!state?.current?.parent_id)} onClick={undo}><Undo2 size={16}/>{t('p2.undo')}</button>
    <p className="mask-note">{t('p2.nonDestructive')}</p>
   </aside>
   <main className="mask-center"><div className="mask-view-tabs">{(['checker','raw','alpha','black','white'] as View[]).map(v=><button className={view===v?'active':''} key={v} onClick={()=>setView(v)}>{t(`p2.view.${v}` as any)}</button>)}</div>
    <div className={`mask-stage ${view}`}><canvas ref={canvas} data-testid="mask-canvas" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}/>{loading&&<div className="mask-loading">{t('p2.loading')}</div>}</div>
    <div className="mask-frame-navigation"><button className="icon-btn" aria-label={t('p2.previous')} aria-keyshortcuts="ArrowLeft" title={`${t('p2.previous')} (←)`} disabled={busy||index===0} onClick={()=>void switchFrame(index-1)}><ChevronLeft/></button><span>{t('p2.frame',{n:index+1,total:frames.length})}</span><button className="icon-btn" aria-label={t('p2.next')} aria-keyshortcuts="ArrowRight" title={`${t('p2.next')} (→)`} disabled={busy||index===frames.length-1} onClick={()=>void switchFrame(index+1)}><ChevronRight/></button><span className="mask-keyboard-hint">{t('p2.keyboardHint')}</span><span className="mask-dimensions">{raw.current?.naturalWidth} × {raw.current?.naturalHeight}</span></div>
   </main>
   <aside className="mask-review"><span className="candy-step">03 / {t('p2.inspect')}</span><div className={`mask-status ${state?.reviewed?'reviewed':''}`}><Check size={20}/>{state?.reviewed?t('p2.reviewed'):t('p2.pending')}</div><p>{t('p2.reviewHint')}</p>
    <div className="mask-warning-list">{reasons.map((reason:string)=><span key={reason}>{t(`p2.reason.${reason}` as any)}</span>)}</div>
    <button className="px-btn accent" disabled={busy||!strokes.length} onClick={()=>void save()}>{t('p2.save',{n:strokes.length})}</button>
    <button className="px-btn accent-cyan" disabled={busy||loading||!state?.current||!!strokes.length||state.reviewed||invisible} onClick={()=>void safely(async()=>setState(await maskApi.review(frame!.id,state!)))}><Check size={16}/>{t('p2.confirm')}</button>
    {state?.current&&<a className="px-btn" download={`foreground_${index.toString().padStart(6,'0')}.png`} href={maskApi.image(frame!.id,'rgba',state.version_id)}><Download size={16}/>{t('p2.download')}</a>}
    <p className="mask-note">{t('p2.draftHint')}</p><small>{t('p2.history',{n:state?.versions.length??0})}</small>
    <div className="mask-frame-list">{frames.map((f,i)=><button key={f.id} disabled={busy} className={`${i===index?'active':''} ${abnormal[f.id]?'warning':''}`} onClick={()=>void switchFrame(i)}>{String(i+1).padStart(3,'0')}{reviewed.has(f.id)?' ✓':abnormal[f.id]?' !':''}</button>)}</div>
   </aside>
  </div><footer className="mask-footer"><span>{busy?progress:progress||t('p2.ready')}</span><span className="candy-tag">LOCAL CPU · RGBA</span></footer>
 </section></div>;
}
