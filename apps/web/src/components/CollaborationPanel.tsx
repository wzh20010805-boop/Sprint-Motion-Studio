import {useCallback,useEffect,useRef,useState} from 'react';
import type {ActionCollaborationState,WorkContext,DraftEditContext,DraftContent,OperationRecord,DeliveryResult,ReviewState} from '@framebaker/shared';
import {candidateReviewApi as api,CandidateOperationReader} from '../candidateReviewApi';
import {wsClient} from '../api/ws';
import {useT} from '../i18n';
import {askConfirm,notify} from '../notice';

type Props={context:WorkContext;fps:number;edit:DraftEditContext|null;onOpen:(taskId:string)=>void;onTask:(taskId:string|null)=>void};
/** 常驻编辑器的服务状态视图；JobPanel 的短暂通知不参与交付判定。 */
export function CollaborationPanel(props:Props){return <Panel key={`${props.context.project_id}:${props.context.axis_id}`} {...props}/>;}
function Panel({context,fps,edit,onOpen,onTask}:Props){
 const t=useT(),[action,setAction]=useState<ActionCollaborationState|null>(null),[selected,setSelected]=useState<string|null>(null),[draft,setDraft]=useState<DraftContent|null>(null),[different,setDifferent]=useState(false),[operations,setOperations]=useState<OperationRecord[]>([]),[deliveries,setDeliveries]=useState<DeliveryResult[]>([]),[review,setReview]=useState<ReviewState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const reader=useRef(new CandidateOperationReader(api.operation)),generation=useRef(0),active=useRef<AbortController|null>(null),mutating=useRef(false);
 const refresh=useCallback(async()=>{
  active.current?.abort();const abort=new AbortController();active.current=abort;const g=++generation.current;
  try{
   const value=await api.action(context,abort.signal);
   const task=value.tasks.find(task=>task.id===selected)??(value.tasks.length===1?value.tasks[0]:null);
   let content:DraftContent|null=null,ops:OperationRecord[]=[],files:DeliveryResult[]=[],state:ReviewState|null=null,changed=false;
   if(value.mode==='collaboration')content=await api.draft(context,abort.signal);
   if(task){
    ops=await reader.current.read(task.operation_ids,abort.signal);
    files=await Promise.all(ops.filter(op=>op.state==='succeeded').map(op=>api.delivery(op.id,abort.signal)));
    if(task.selected_candidate_id){const candidate=await api.candidate(task.selected_candidate_id,abort.signal);state=await api.state(task.selected_candidate_id,abort.signal);changed=content?.token.hash!==candidate.manifest.content_token.hash;}
   }
   if(g!==generation.current||abort.signal.aborted)return;
   setAction(value);setDraft(content);setOperations(ops);setDeliveries(files);setReview(state);setDifferent(changed);setError('');onTask(task?.id??null);
  }catch(e){if(g===generation.current&&!abort.signal.aborted){setError(String(e));onTask(null);}}
 },[context.project_id,context.axis_id,selected,onTask]);
 useEffect(()=>{void refresh();const invalidate=()=>{if(!mutating.current)void refresh();},timer=window.setInterval(invalidate,5000),off=wsClient.subscribe(invalidate),connection=wsClient.subscribeConnection(invalidate);window.addEventListener('online',invalidate);window.addEventListener('focus',invalidate);return()=>{generation.current++;active.current?.abort();clearInterval(timer);off();connection();window.removeEventListener('online',invalidate);window.removeEventListener('focus',invalidate);};},[refresh,edit]);
 const task=action?.tasks.find(task=>task.id===selected)??(action?.tasks.length===1?action.tasks[0]:null);
 async function switchTiming(mode:'source_pts'|'confirmed_fps'){
  if(!draft||busy)return;
  const token=draft.token,key=crypto.randomUUID(),timing=mode==='source_pts'?{value:{mode:'source_pts' as const},origin:'user' as const}:{value:{mode:'confirmed_fps' as const,fps:{num:fps,den:1}},origin:'user' as const};
  if(!await askConfirm(t('collab.timingQuestion')))return;
  mutating.current=true;setBusy(true);
  try{await api.timing(context,timing,token,key);}catch(e){notify(String(e));}finally{mutating.current=false;setBusy(false);await refresh();}
 }
 if(action?.mode==='legacy'&&!error)return null;
 return <aside className="collaboration-panel" data-collaboration="panel" aria-label={t('review.title')}>
  {error?<p role="alert">{t('review.loadError',{error})}<button className="px-btn" onClick={()=>void refresh()}>{t('review.retry')}</button></p>:!action?<p>{t('review.loading')}</p>:<>
   <div className="candidate-toolbar"><label>{t('collab.task')}<select data-collaboration="task" value={task?.id??''} onChange={e=>{setSelected(e.target.value||null);onTask(null);setOperations([]);setDeliveries([]);setReview(null);}}><option value="">{t('collab.chooseTask')}</option>{action.tasks.map(task=><option value={task.id} key={task.id}>{task.id}</option>)}</select></label><button className="px-btn" data-collaboration="open-review" disabled={!task} onClick={()=>task&&onOpen(task.id)}>{t('review.title')}</button>{task&&<span>{t(`review.task.${task.state}`)}</span>}</div>
   {action.tasks.length>1&&!task&&<p>{t('export.ambiguousTask')}</p>}
   {action.timing&&<p data-collaboration="timing">{t(`review.timing.${action.timing.value.mode}`)} · {t('collab.origin',{origin:t(`collab.origin.${action.timing.origin}`)})}{action.timing.value.mode==='confirmed_fps'&&` · ${action.timing.value.fps.num}/${action.timing.value.fps.den} FPS`}</p>}
   <p>{t('collab.fpsHint')}</p><button className="px-btn" data-collaboration="timing-fps" disabled={busy||!draft} onClick={()=>void switchTiming('confirmed_fps')}>{t('collab.useFps',{fps})}</button><button className="px-btn" disabled={busy||!draft} onClick={()=>void switchTiming('source_pts')}>{t('collab.useSource')}</button>
   {edit&&edit.axis_id===context.axis_id&&<p data-collaboration="lineage">{t('collab.editing',{parent:edit.parent_candidate_id})}</p>}
   {different&&<p data-collaboration="dirty">{t('collab.newCandidate')}</p>}
   {review&&<p data-collaboration="acceptance">{t(review.accepted?'review.accepted':'review.notAccepted')}</p>}
   <DeliveryStatus operations={operations} deliveries={deliveries}/>
  </>}
 </aside>;
}
export function DeliveryStatus({operations,deliveries}:{operations:OperationRecord[];deliveries:DeliveryResult[]}){
 const t=useT();return <div data-collaboration="deliveries">{operations.map(op=><p data-operation={op.id} key={op.id}>{t('review.deliveryOperation',{id:op.id,state:t(`collab.operation.${op.state}`)})}</p>)}{deliveries.map(delivery=><div data-delivery={delivery.delivery_id} data-approval={delivery.approval_status} key={delivery.delivery_id}>{t(`review.delivery.${delivery.approval_status}`)} · {delivery.candidate_id} · {delivery.acceptance_epoch}{Object.keys(delivery.checksums).filter(file=>file==='assets.zip'||file==='manifest.json').map(file=><a key={file} href={api.deliveryFile(delivery.delivery_id,file)} download>{file}</a>)}</div>)}</div>;
}
