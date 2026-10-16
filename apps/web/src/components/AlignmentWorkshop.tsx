import { useEffect,useRef,useState } from 'react';
import type { AlignmentConfig,Frame } from '@framebaker/shared';
import { rootAt } from '@framebaker/shared';
import { productionRequest as request } from '../productionApi';
import { maskApi } from '../maskApi';
import { askConfirm,notify } from '../notice';
import { useT } from '../i18n';
import {routeAlignmentExport} from '../collaborationEditor';
import {useEditingCommands} from '../editingCommands';

const initial:AlignmentConfig={canvas:{width:128,height:128},anchor:[64,112],scale:1,resampling:'cartoon',mode:'fixed',roots:[{index:0,x:64,y:112}],offsets:{}};
export default function AlignmentWorkshop({projectId,axisId,frames,fps,onClose,taskId,onReview,onFormalExport}:{projectId:string;axisId:string;frames:Frame[];fps:number;onClose:()=>void;taskId?:string;onReview?:(taskId:string)=>void;onFormalExport?:()=>Promise<void>}) {
 const t=useT(),[config,setConfig]=useState<AlignmentConfig>(initial),[revision,setRevision]=useState(0),[index,setIndex]=useState(0),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[playing,setPlaying]=useState(false),[onion,setOnion]=useState(true),[checks,setChecks]=useState<any[]>([]),[zoom,setZoom]=useState(.5),[exported,setExported]=useState<any>(null),[progress,setProgress]=useState(''),[job,setJob]=useState<string|null>(null),[timing,setTiming]=useState('source_pts');
 const commandScope=useRef<HTMLDivElement>(null),history=useRef<AlignmentConfig[]>([]),configRef=useRef(config),savedConfig=useRef(config),busyRef=useRef(false),[loaded,setLoaded]=useState(false);
 configRef.current=config;
 const raw=useRef<HTMLImageElement>(null),[rootX,setRootX]=useState(64),[rootY,setRootY]=useState(112),[dx,setDx]=useState(0),[dy,setDy]=useState(0);
 const context={project_id:projectId,axis_id:axisId};
 const frame=frames[index],currentPreview=frame?`/api/v1/preview/${frame.id}?axis_id=${axisId}&v=${revision}`:'';
 const timingData=(frame?.metadata as any)?.timing?.display_duration;
 const [loadedPreview,setLoadedPreview]=useState('');
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;setLoaded(false);history.current=[];void request(`/alignment?project_id=${projectId}&axis_id=${axisId}`).then(reply=>{if(alive.current){const next=reply.data.config??initial;configRef.current=next;savedConfig.current=structuredClone(next);setConfig(next);setDirty(false);setZoom(Math.min(2,512/next.canvas.width,320/next.canvas.height));setRevision(reply.data.revision);setLoaded(true);}}).catch(e=>notify(e.message));return()=>{alive.current=false;};},[projectId,axisId]);
 // 播放等待当前图像就绪；父窗口刷新产生的新数组不能反复重置计时。
 useEffect(()=>{if(!playing||dirty||!frames.length||loadedPreview!==currentPreview)return;const seconds=timing==='source_pts'&&timingData?timingData.num/timingData.den:(frame?.duration??1)/fps;const id=window.setTimeout(()=>setIndex(i=>(i+1)%frames.length),Math.max(1,seconds*1000));return()=>clearTimeout(id);},[playing,index,dirty,frames.length,timing,fps,currentPreview,loadedPreview,timingData?.num,timingData?.den,frame?.duration]);
 useEffect(()=>{const point=rootAt(config,index);setRootX(point.x);setRootY(point.y);const d=config.offsets[String(index)]??[0,0];setDx(d[0]);setDy(d[1]);},[index,config]);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.target as HTMLElement).matches('input,textarea,select'))return;if(e.key==='ArrowLeft'){e.preventDefault();e.stopImmediatePropagation();setIndex(i=>Math.max(0,i-1));}if(e.key==='ArrowRight'){e.preventDefault();e.stopImmediatePropagation();setIndex(i=>Math.min(frames.length-1,i+1));}if(e.code==='Space'){e.preventDefault();e.stopImmediatePropagation();setPlaying(v=>!v);}};window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);},[frames.length]);
 const remember=()=>{history.current=[...history.current.slice(-49),structuredClone(configRef.current)];};
 const update=(next:AlignmentConfig)=>{if(busyRef.current||!loaded)return;if(JSON.stringify(next)===JSON.stringify(configRef.current))return;remember();configRef.current=next;setConfig(next);setDirty(JSON.stringify(next)!==JSON.stringify(savedConfig.current));setPlaying(false);setExported(null);};
 const execute=async(fn:()=>Promise<unknown>)=>{if(busyRef.current)return false;busyRef.current=true;setBusy(true);try{return await fn()!==false;}catch(e){notify((e as Error).message);return false;}finally{busyRef.current=false;if(alive.current)setBusy(false);}};
 const expectedRoot=rootAt(config,index),expectedOffset=config.offsets[String(index)]??[0,0];
 const rootDraftDirty=rootX!==expectedRoot.x||rootY!==expectedRoot.y,offsetDraftDirty=dx!==expectedOffset[0]||dy!==expectedOffset[1];
 const save=async()=>{
  if(!loaded)return false;
  if(![rootX,rootY,dx,dy].every(Number.isFinite))throw Error('对齐参数必须为有限数值');
  let next=configRef.current;
  if(rootDraftDirty){const roots=next.mode==='fixed'?[{index:0,x:rootX,y:rootY}]:[...next.roots.filter(p=>p.index!==index),{index,x:rootX,y:rootY}].sort((a,b)=>a.index-b.index);next={...next,roots};}
  if(offsetDraftDirty)next={...next,offsets:{...next.offsets,[String(index)]:[dx,dy]}};
  if(JSON.stringify(next)!==JSON.stringify(configRef.current)){remember();configRef.current=next;setConfig(next);setDirty(true);}
  const result=await request('/alignment',{...context,config:next,base_revision:revision});
  savedConfig.current=structuredClone(result.data.config);configRef.current=result.data.config;setRevision(result.data.revision);setConfig(result.data.config);setDirty(false);return true;
 };
 const undo=()=>execute(async()=>{
  if(rootDraftDirty||offsetDraftDirty){setRootX(expectedRoot.x);setRootY(expectedRoot.y);setDx(expectedOffset[0]!);setDy(expectedOffset[1]!);return true;}
  const previous=history.current.at(-1);if(!previous)return false;
  let next=previous;
  if(!dirty){const result=await request('/alignment',{...context,config:previous,base_revision:revision});next=result.data.config;savedConfig.current=structuredClone(next);setRevision(result.data.revision);}
  history.current.pop();configRef.current=structuredClone(next);setConfig(configRef.current);setDirty(JSON.stringify(next)!==JSON.stringify(savedConfig.current));setPlaying(false);setExported(null);return true;
 });
 useEditingCommands({label:t('地面基准、统一比例与导出'),priority:100,scope:commandScope,save:()=>execute(save),undo,canSave:loaded&&(dirty||rootDraftDirty||offsetDraftDirty),canUndo:history.current.length>0||rootDraftDirty||offsetDraftDirty,busy,dirty:dirty||rootDraftDirty||offsetDraftDirty});
 const mark=(x=rootX,y=rootY)=>{const roots=config.mode==='fixed'?[{index:0,x,y}]:[...config.roots.filter(p=>p.index!==index),{index,x,y}].sort((a,b)=>a.index-b.index);update({...config,roots});};
 const preview=(i:number)=>`/api/v1/preview/${frames[i]!.id}?axis_id=${axisId}&v=${revision}`;
 const exportAssets=(draft:boolean)=>execute(async()=>{const legacy=async()=>{if(dirty)await save();const reply=await request('/export',{...context,draft,timing});setJob(reply.job_id);for(;;){const status=await request('/jobs/'+reply.job_id);if(!alive.current)break;setProgress(status.data.job.progress??'');if(!['queued','running'].includes(status.status)){setJob(null);if(status.status!=='succeeded')throw new Error(status.error?.message??status.data.job.error??status.status);setExported(status.data.job.result);break;}await new Promise(r=>setTimeout(r,350));};};if(draft)await legacy();else await routeAlignmentExport(context,taskId,legacy,async()=>{if(!onFormalExport)throw Error(t('collab.reviewRequired'));await onFormalExport();});});
 return <div ref={commandScope} className="modal-mask"><section className="pixel-panel alignment-workshop" role="dialog" aria-modal="true" data-testid="alignment-workshop">
  <header>{taskId&&onReview&&<button data-collaboration="alignment-review" onClick={()=>onReview(taskId)}>{t('review.title')}</button>}<h2>{t('地面基准、统一比例与导出')}</h2><button className="px-btn" onClick={onClose}>{t('关闭')}</button></header>
  <fieldset disabled={busy||!loaded} style={{border:0,padding:0,margin:0}}>
  <p>{t('根位置是地面投影；跳跃和倒地时不要追随脚底。画布、锚点和比例在同角色所有动作共享。')}</p>
  <p>{t('已包含主编辑器的位移、缩放、旋转和透明度；这里的地面根与微调在其后应用。')}</p>
  <div className="alignment-controls">
   {(['width','height'] as const).map(v=><label key={v}>{t(v==='width'?'画布宽':'画布高')}<input type="number" value={config.canvas[v]} onChange={e=>update({...config,canvas:{...config.canvas,[v]:Number(e.target.value)}})}/></label>)}
   <label>{t('统一比例')}<input type="number" step="0.05" value={config.scale} onChange={e=>update({...config,scale:Number(e.target.value)})}/></label>
   {(['x','y'] as const).map((v,i)=><label key={v}>{t('画布锚点')+' '+v}<input type="number" value={config.anchor[i]} onChange={e=>{const anchor=[...config.anchor] as [number,number];anchor[i]=Number(e.target.value);update({...config,anchor});}}/></label>)}
   <select value={config.resampling} onChange={e=>update({...config,resampling:e.target.value as 'pixel'|'cartoon'})}><option value="pixel">{t('像素风 Nearest')}</option><option value="cartoon">{t('高清卡通')}</option></select>
   <select value={config.mode} onChange={e=>update({...config,mode:e.target.value as 'fixed'|'ground_keyframes',roots:config.roots.slice(0,1)})}><option value="fixed">{t('固定基准')}</option><option value="ground_keyframes">{t('地面轨迹关键帧')}</option></select>
  </div>
  <p>{t('素材画布：{width} × {height}px；显示倍率仅影响预览，不改变导出尺寸。',{width:config.canvas.width,height:config.canvas.height})}</p>
  <div className="alignment-views">
   <div><h3>{t('原图：点击标注地面根位置')}</h3>{frame&&<div className="alignment-source"><img ref={raw} src={maskApi.image(frame.id,'raw')} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();mark((e.clientX-r.left)*e.currentTarget.naturalWidth/r.width,(e.clientY-r.top)*e.currentTarget.naturalHeight/r.height);}}/><p>{t('当前根位置')} {rootX.toFixed(1)}, {rootY.toFixed(1)}</p></div>}</div>
   <div><h3>{dirty?t('参数未保存，预览显示上一版本'):t('共享后端画布预览')}</h3><div className="alignment-canvas" style={{width:config.canvas.width*zoom,height:config.canvas.height*zoom}}>
    {onion&&!playing&&!dirty&&[-1,1].map(d=>frames[index+d]&&<img key={d} style={{opacity:.2}} src={preview(index+d)}/>)}
    {frame&&!dirty&&<img src={currentPreview} onLoad={e=>{if(e.currentTarget.currentSrc===new URL(currentPreview,window.location.href).href)setLoadedPreview(currentPreview);}} onError={()=>{setPlaying(false);setProgress(t('请先生成抠图初稿并保存对齐参数'));}}/>}
    <span style={{position:'absolute',left:config.anchor[0]*zoom,top:config.anchor[1]*zoom}}>＋</span>
   </div></div>
  </div>
  <div className="alignment-controls"><button className="px-btn" onClick={()=>setIndex(i=>Math.max(0,i-1))}>◀</button><span className="alignment-frame-counter" style={{width:`${String(Math.max(0,frames.length)).length*2+3}ch`}}>{index+1} / {frames.length}</span><button className="px-btn" onClick={()=>setIndex(i=>Math.min(frames.length-1,i+1))}>▶</button>
   <button className="px-btn" disabled={dirty} onClick={()=>setPlaying(v=>!v)}>{playing?t('暂停'):t('播放')}</button><label>{t('显示倍率')}<select data-testid="alignment-display-zoom" value={zoom} onChange={e=>setZoom(Number(e.target.value))}>
    {![.25,.5,1,2].includes(zoom)&&<option value={zoom}>{Number((zoom*100).toFixed(1))}%</option>}
    {[.25,.5,1,2].map(value=><option key={value} value={value}>{value*100}%</option>)}
   </select></label>
   <label><input type="checkbox" checked={onion} onChange={e=>setOnion(e.target.checked)}/>{t('洋葱皮')}</label>
   <select value={timing} onChange={e=>setTiming(e.target.value)}><option value="source_pts">{t('原始逐帧时长')}</option><option value="constant">{t('时间轴帧率与时长')}</option></select>
  </div>
  <div className="alignment-controls"><label>Root X<input type="number" value={rootX} onChange={e=>setRootX(Number(e.target.value))}/></label><label>Root Y<input type="number" value={rootY} onChange={e=>setRootY(Number(e.target.value))}/></label><button className="px-btn" onClick={()=>mark()}>{t('设置当前根位置')}</button>
   <label>Offset X<input type="number" value={dx} onChange={e=>setDx(Number(e.target.value))}/></label><label>Offset Y<input type="number" value={dy} onChange={e=>setDy(Number(e.target.value))}/></label><button className="px-btn" onClick={()=>update({...config,offsets:{...config.offsets,[String(index)]:[dx,dy]}})}>{t('应用逐帧微调')}</button>
   <button className="px-btn" disabled={config.mode==='fixed'||config.roots.length<=1||!config.roots.some(p=>p.index===index)} onClick={()=>update({...config,roots:config.roots.filter(p=>p.index!==index)})}>{t('删除当前关键帧')}</button>
  </div><p>{t('关键帧')}: {config.roots.map(p=>`${p.index+1} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join(' · ')}</p>
  </fieldset><footer className="alignment-controls"><button className="px-btn accent" disabled={busy||!loaded} onClick={()=>execute(save)}>{t('保存参数')}</button>
   <button className="px-btn" disabled={busy||(!history.current.length&&!rootDraftDirty&&!offsetDraftDirty)} onClick={()=>void undo()}>{t('timeline.undo')}</button>
   <button className="px-btn" disabled={busy} onClick={()=>execute(async()=>{if(dirty)await save();const r=await request('/alignment/check',context);setChecks(r.data.checks);})}>{t('全动作越界预检')}</button>
   <button className="px-btn" disabled={busy||dirty} onClick={()=>{if(taskId){if(onReview)onReview(taskId);else notify(t('collab.reviewRequired'));return;}void execute(async()=>{if(!await askConfirm(t('确认已检查所有遮罩、地面根位置、动作起伏和武器边界？')))return;await request('/review/apply',{...context,base_revision:revision,confirmation:'用户检查当前遮罩、地面轨迹、公共画布与统一比例',source:'GUI人工确认按钮'});setProgress(t('当前修订已确认，可正式导出'));});}}>{taskId?t('review.title'):t('确认当前修订')}</button>
   <button className="px-btn" disabled={busy} onClick={()=>exportAssets(true)}>{t('导出草稿')}</button><button className="px-btn accent" disabled={busy||dirty} onClick={()=>exportAssets(false)}>{t('正式导出 PNG 与图集')}</button>
   {job&&<button className="px-btn" onClick={()=>void request('/jobs/'+job+'/cancel',{}).catch(e=>notify(e.message))}>{t('取消任务')}</button>}
  </footer><p className="alignment-status">{playing&&loadedPreview!==currentPreview?t('正在载入预览帧…'):progress}</p><p>{checks.length>0&&(checks.some(c=>c.overflow||c.empty)?t('有越界或空帧，请修改公共画布或遮罩'):t('所有帧均在公共画布内'))} {checks.filter(c=>c.overflow||c.empty).map(c=>c.index+1).join(', ')}</p>
  {exported&&<div><p>{exported.directory}</p><a className="px-btn" href={`/api/v1/exports/${exported.id}/file?path=assets.zip`} download="assets.zip">{t('下载完整素材包')}</a> <a href={`/api/v1/exports/${exported.id}/file?path=manifest.json`} download="manifest.json">manifest.json</a><img style={{maxWidth:480}} src={`/api/v1/exports/${exported.id}/file?path=previews/contact-sheet.png`}/></div>}
 </section></div>;
}
