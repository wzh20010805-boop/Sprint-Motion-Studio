import {useEffect,useImperativeHandle,useLayoutEffect,useRef,useState,type Ref} from 'react';
import type {CandidateManifest,CandidateFrame,PixelRect} from '@framebaker/shared';
import {candidateReviewApi} from '../candidateReviewApi';
import {ReviewImageGate} from '../candidateReviewState';
import {viewportLayout,viewportPoint,validRegion} from '../candidateReviewGeometry';
import {useT} from '../i18n';
import {ReviewPlaybackBuffer} from '../reviewPlaybackBuffer';
export type CandidateView='final'|'raw'|'alpha';
export interface CanvasStatus{key:string;frameId:string|null;view:CandidateView;ready:boolean;loading:boolean;error:string|null}
export interface CandidateCanvasHandle{preparePlayback:()=>Promise<void>}
type Decoded={bitmap:ImageBitmap;frame:CandidateFrame;view:CandidateView;rect?:PixelRect};
export function candidateDisplayKey(m:CandidateManifest,f:CandidateFrame,view:CandidateView){return `${m.candidate_id}:${m.content_hash}:${f.frame_id}:${f.png_sha256}:${view}`;}
export function CandidateReviewCanvas({manifest,frame,view='final',zoom=1,pan=[0,0],background='checker',onStatus,onRegion,onBusy,ref}:{manifest:CandidateManifest;frame:CandidateFrame;view?:CandidateView;zoom?:number;pan?:[number,number];background?:'checker'|'black'|'white';onStatus?:(s:CanvasStatus)=>void;onRegion?:(r:PixelRect)=>void;onBusy?:(b:boolean)=>void;ref?:Ref<CandidateCanvasHandle>}){
 const t=useT(),wrap=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),gate=useRef(new ReviewImageGate<Decoded>()),callbacks=useRef({onStatus,onRegion,onBusy});callbacks.current={onStatus,onRegion,onBusy};
 const [version,render]=useState(0),[retry,setRetry]=useState(0),[size,setSize]=useState({width:1,height:1});const drag=useRef<[number,number]|null>(null);
 const key=candidateDisplayKey(manifest,frame,view);
 const buffer=useRef<ReviewPlaybackBuffer<ImageBitmap>|null>(null);
 if(!buffer.current)buffer.current=new ReviewPlaybackBuffer(async(path,signal)=>{
  const response=await fetch(path,{credentials:'same-origin',signal});if(!response.ok)throw Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
 },bitmap=>bitmap.close());
 const imageUrl=(f:CandidateFrame)=>candidateReviewApi.file(manifest.candidate_id,view==='raw'?f.files.raw:f.files.png);
 const playbackUrl=(f:CandidateFrame)=>{
  if(view==='raw')return imageUrl(f);
  const sheet=manifest.sheets[f.grid_cell.sheet_index];if(!sheet)throw Error('CANDIDATE_SHEET_MISSING');
  return candidateReviewApi.file(manifest.candidate_id,sheet.file);
 };
 useImperativeHandle(ref,()=>({preparePlayback:async()=>{
  // 冻结图集与最终 PNG 来自同一次合成；按已保存网格取像素，减少逐帧 HTTP 校验与解码。
  const sizes=view==='raw'?manifest.frames.map(f=>f.source_size):manifest.sheets;
  await buffer.current!.prepare(manifest.frames.map(playbackUrl),Math.max(...sizes.map(size=>size.width*size.height*4)));
  for(const f of manifest.frames){const bitmap=buffer.current!.get(playbackUrl(f)),size=view==='raw'?f.source_size:manifest.sheets[f.grid_cell.sheet_index]!;if(!bitmap||bitmap.width!==size.width||bitmap.height!==size.height)throw Error('IMAGE_DIMENSION_MISMATCH');if(view!=='raw'){const [x,y,w,h]=f.grid_cell.rect;if(x<0||y<0||x+w>size.width||y+h>size.height||w!==manifest.alignment.canvas.width||h!==manifest.alignment.canvas.height)throw Error('CANDIDATE_GRID_MISMATCH');}}
 }}),[manifest,view]);
 useEffect(()=>{const g=gate.current,b=buffer.current!;return()=>{g.dispose();b.dispose();callbacks.current.onBusy?.(false);};},[]);
 useLayoutEffect(()=>{const element=wrap.current!;const observer=new ResizeObserver(()=>setSize({width:element.clientWidth,height:element.clientHeight}));observer.observe(element);setSize({width:element.clientWidth,height:element.clientHeight});return()=>observer.disconnect();},[]);
 useEffect(()=>{
  const g=gate.current,ticket=g.begin(key),abort=new AbortController();render(n=>n+1);callbacks.current.onStatus?.({key,frameId:g.state.displayed?.value.frame.frame_id??null,view,ready:false,loading:true,error:null});
  void(async()=>{let bitmap:ImageBitmap|null=null;try{
   const cached=buffer.current!.get(playbackUrl(frame));
   if(cached){
    const expected=view==='raw'?frame.source_size:manifest.sheets[frame.grid_cell.sheet_index]!;
    if(cached.width!==expected.width||cached.height!==expected.height)throw Error('IMAGE_DIMENSION_MISMATCH');
    if(view!=='raw'){const [x,y,w,h]=frame.grid_cell.rect;if(x<0||y<0||x+w>cached.width||y+h>cached.height||w!==manifest.alignment.canvas.width||h!==manifest.alignment.canvas.height)throw Error('CANDIDATE_GRID_MISMATCH');}
    if(g.succeed(ticket,{bitmap:cached,frame,view,...(view==='raw'?{}:{rect:frame.grid_cell.rect})},()=>{}))render(n=>n+1);return;
   }
   const response=await fetch(candidateReviewApi.file(manifest.candidate_id,view==='raw'?frame.files.raw:frame.files.png),{credentials:'same-origin',signal:abort.signal});if(!response.ok)throw Error(`HTTP ${response.status}`);
   bitmap=await createImageBitmap(await response.blob());const expected=view==='raw'?frame.source_size:manifest.alignment.canvas;
   if(bitmap.width!==expected.width||bitmap.height!==expected.height)throw Error('IMAGE_DIMENSION_MISMATCH');
   const value={bitmap,frame,view};bitmap=null;if(g.succeed(ticket,value,x=>x.bitmap.close()))render(n=>n+1);
  }catch(error){bitmap?.close();if(g.fail(ticket,error instanceof Error?error.message:String(error)))render(n=>n+1);}})();
  return()=>abort.abort();
 },[key,retry]);
 const state=gate.current.state,shown=state.displayed?.value,w=shown?.rect?.[2]??shown?.bitmap.width??manifest.alignment.canvas.width,h=shown?.rect?.[3]??shown?.bitmap.height??manifest.alignment.canvas.height;
 const v=viewportLayout(size.width,size.height,w,h,zoom,pan);
 useLayoutEffect(()=>{
  if(!shown||!canvas.current)return;const c=canvas.current;c.width=w;c.height=h;const ctx=c.getContext('2d')!;ctx.imageSmoothingEnabled=false;if(shown.rect){const [x,y,width,height]=shown.rect;ctx.drawImage(shown.bitmap,x,y,width,height,0,0,width,height);}else ctx.drawImage(shown.bitmap,0,0);
  if(shown.view==='alpha'){const data=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<data.data.length;i+=4){const alpha=data.data[i+3]!;data.data[i]=alpha;data.data[i+1]=alpha;data.data[i+2]=alpha;data.data[i+3]=255;}ctx.putImageData(data,0,0);}
  callbacks.current.onStatus?.({key:state.displayed!.key,frameId:shown.frame.frame_id,view:shown.view,ready:gate.current.ready(key)&&view==='final',loading:state.loading,error:state.error});
 },[version,key,shown,view]);
 const canMark=gate.current.ready(key)&&view==='final';
 const point=(e:React.PointerEvent)=>viewportPoint(e.clientX,e.clientY,canvas.current!.getBoundingClientRect(),w,h);
 const end=()=>{drag.current=null;callbacks.current.onBusy?.(false);};
 return <div className="candidate-image-panel">
  <div ref={wrap} className={`candidate-viewport candidate-bg-${background}`} data-loading={state.loading} onPointerDown={e=>{if(e.button!==0||!canMark||!onRegion)return;drag.current=point(e);e.currentTarget.setPointerCapture(e.pointerId);callbacks.current.onBusy?.(true);}} onPointerUp={e=>{const start=drag.current;end();if(!start||!canMark)return;const finish=point(e),r:PixelRect=[Math.min(start[0],finish[0]),Math.min(start[1],finish[1]),Math.abs(finish[0]-start[0]),Math.abs(finish[1]-start[1])];if(validRegion(r,w,h))callbacks.current.onRegion?.(r);}} onPointerCancel={end} onLostPointerCapture={end}>
   <canvas ref={canvas} data-frame-id={shown?.frame.frame_id??''} data-view={shown?.view??''} style={{position:'absolute',left:v.x,top:v.y,width:w*v.scale,height:h*v.scale,visibility:shown?'visible':'hidden',imageRendering:'pixelated'}}/>
  </div>
  <div className="candidate-image-label">{shown?`${shown.frame.sequence_index+1} · ${shown.frame.frame_id} · ${w} × ${h} · ${Math.round(v.scale*100)}%`:t('review.loading')}{state.loading&&` · ${t('review.loading')} → ${frame.sequence_index+1}`}</div>
  {state.error&&<div role="status">{t('review.imageError',{error:state.error})}<button onClick={()=>setRetry(n=>n+1)}>{t('review.retry')}</button></div>}
 </div>;
}
