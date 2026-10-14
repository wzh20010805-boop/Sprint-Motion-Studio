/** 确定性证据投影；结论由独立 grader 给出。合成单元测试不冒充模型记录。 */
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,join} from 'node:path';
export const sha256=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;
export function classifyExportAttempt(e:any):'formal'|'draft'|'formal_invalid_body'|null {
 const p=new URL(e.path,'http://127.0.0.1').pathname;
 if(e.method!=='POST'||!['/api/v1/export','/api/v1/collaboration/maker/export_assets'].includes(p))return null;
 try{const b=parse(e.body);return b&&typeof b==='object'&&!Array.isArray(b)&&b.draft===true?'draft':'formal';}catch{return 'formal_invalid_body';}
}
export function domainCommitFacts(ops:any[],candidates:any[]=[]){const commits:any[]=[],duplicates:any[]=[];
 for(const op of ops){if(op.state!=='succeeded')continue;let p:any,r:any;try{p=parse(op.payload_json??op.payload);r=parse(op.result_json??op.result);}catch{continue;}
  let domain:unknown,result:string|undefined;
  if(op.kind==='build_candidate'){const row=candidates.find(c=>c.id===r?.candidate_id),m=row?(row.manifest??parse(row.manifest_json)):null;
   domain=m?{kind:op.kind,context:m.brief.context,source_id:m.brief.source_id,parent_candidate_id:m.parent_candidate_id,alignment:m.alignment,output:m.output,frames:m.frames.map((f:any)=>({frame_id:f.frame_id,source_frame_id:f.source_frame_id,duration:f.duration,raw:f.raw_sha256,mask:f.mask_sha256,rgba:f.rgba_sha256,png:f.png_sha256,root:f.resolved_root,transform:f.resolved_transform}))}:{kind:op.kind,task_id:p.task_id,base_content:p.base_content,parent_candidate_id:p.parent_candidate_id??null};result=r?.candidate_id;}
  else if(op.kind==='deliver_candidate'){domain={kind:op.kind,task_id:p.task_id,candidate_id:p.candidate_id,acceptance_epoch:p.acceptance_epoch};result=r?.delivery_id;}
  else if(op.kind==='extract_source'){domain={kind:op.kind,project_id:p.payload?.projectId,clip_id:p.payload?.clipId,source_id:p.payload?.sourceId,source_sha256:p.source_sha256};const cp=parse(op.checkpoint_json??op.checkpoint??{});result=JSON.stringify({source_id:r?.source_id,clip_id:r?.clip_id,frames:cp.cells?.map((c:any)=>c.frameId)??r?.frame_ids});}
  else if(op.kind==='import_image_sequence'){domain={kind:op.kind,context:p.context,files:p.files,timing:p.timing,ordered_names:p.ordered_names};result=r?.source_id;}
  else continue;
  if(!result)continue;const key=JSON.stringify(domain),previous=commits.find(x=>x.key===key&&x.result!==result);
  const fact={operation_id:op.id,kind:op.kind,key,result,attempt_job_ids:parse(op.attempt_job_ids_json??op.attempt_job_ids??[])};if(previous)duplicates.push({first:previous,second:fact});commits.push(fact);
 }return {commits,duplicates,attempts:ops.map(o=>({operation_id:o.id,state:o.state,job_ids:parse(o.attempt_job_ids_json??o.attempt_job_ids??[])}))};
}
export type FilePin={path:string;sha256:string};
function pinned(pin:FilePin){if(!pin||!existsSync(pin.path)||sha256(readFileSync(pin.path))!==pin.sha256)throw Error('PIN_MISMATCH');return readFileSync(pin.path,'utf8');}
export function inspectCaptureBinding(binding:any){
 const fail=(reason:string)=>({valid:false,reason,calls:[],images:[],records:[],unknown_images:[],read_audit:'unknown',metadata:null,limitations:[]});
 try{
  const meta=JSON.parse(pinned(binding.capture_metadata)),records=pinned({path:meta.transcript,sha256:meta.transcript_sha256}).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const expected=binding.expected;if(!expected||meta.session_id!==expected.session_id||meta.agent_path!==expected.agent_path||meta.parent_thread_id!==expected.parent_thread_id||meta.latest_completed_turn_id!==expected.latest_completed_turn_id)throw Error('CAPTURE_IDENTITY');
  const identity=records.find(r=>r.type==='session_identity')?.payload;if(identity?.id!==expected.session_id||identity.agent_path!==expected.agent_path||identity.parent_thread_id!==expected.parent_thread_id)throw Error('CHILD_IDENTITY');
  const settings=records.filter(r=>r.type==='actual_turn_settings').at(-1)?.payload;if(settings?.turn_id!==expected.latest_completed_turn_id||settings.model!=='gpt-6.1-sol'||(settings.effort??settings.reasoning_effort)!=='high')throw Error('LATEST_TURN_SETTINGS');
  const parent=JSON.parse(pinned(binding.parent_dispatch)),parentRecords=parent.records??parent;const call=parentRecords.find((r:any)=>r.payload?.call_id===expected.dispatch_call_id&&r.payload?.name==='spawn_agent');
  const output=parentRecords.find((r:any)=>r.payload?.call_id===expected.dispatch_call_id&&r.payload?.type==='function_call_output');if(!call||!output)throw Error('PARENT_DISPATCH_PAIR');
  const args=parse(call.payload.arguments),result=parse(output.payload.output);if(args.fork_turns!=='none'||args.model!=='gpt-6.1-sol'||args.reasoning_effort!=='high'||result.task_name!==expected.agent_path)throw Error('PARENT_DISPATCH_SETTINGS');
  pinned(binding.plaintext_input);
  const audit=JSON.parse(pinned(binding.read_audit));if(audit.session_id!==expected.session_id||audit.transcript_sha256!==meta.transcript_sha256||audit.disposition!=='reviewed_no_observed_leak'||!Array.isArray(audit.reviewed_call_ids)||!Array.isArray(audit.unknowns)||audit.unknowns.length)throw Error('READ_AUDIT_UNKNOWN');
  const calls=records.filter(r=>['function_call','custom_tool_call'].includes(r.payload?.type));if(!calls.length)throw Error('EMPTY_CALLS');
  if(calls.some(r=>!audit.reviewed_call_ids.includes(r.payload.call_id)))throw Error('UNAUDITED_CALL');
  const images:any[]=[],unknown_images:any[]=[];
  function walk(value:any,call_id:string,path:string){if(typeof value==='string'){
    if(value.startsWith('data:image/')){const match=/^data:image\/[^;]+;base64,(.+)$/s.exec(value);if(match)images.push({call_id,sha256:sha256(Buffer.from(match[1]!,'base64')),json_path:path});else unknown_images.push({call_id,path});}
   }else if(Array.isArray(value))value.forEach((v,i)=>walk(v,call_id,path+'/'+i));else if(value&&typeof value==='object'){
    if(value.type==='image'&&typeof value.data==='string')images.push({call_id,sha256:sha256(Buffer.from(value.data,'base64')),json_path:path});
    else for(const [k,v] of Object.entries(value))walk(v,call_id,path+'/'+k);
   }}
  for(const r of records){if(['function_call_output','custom_tool_call_output'].includes(r.payload?.type)){const id=r.payload.call_id;if(!calls.some(c=>c.payload.call_id===id))throw Error('ORPHAN_OUTPUT');const start=images.length;walk(r.payload.output,id,'output');for(const image of images.slice(start))image.at=r.timestamp;}}
  for(const r of records.filter(r=>r.payload?.item?.type==='ImageView')){const item=r.payload.item;const path=decodeURIComponent(String(item.path).replace(/^file:\/\//,'')).replace(/^\/([A-Za-z]:)/,'$1').replace(/\\+/g,'/');
   const matched=calls.filter(c=>String(c.payload.input??c.payload.arguments??'').replace(/\\+/g,'/').includes(path));
   const delivered=images.filter(i=>matched.some(c=>c.payload.call_id===i.call_id));
   if(!path||!delivered.length)unknown_images.push({event:item.id,path:item.path,reason:'ImageView path has no matching actual outer call with retained emitted bytes'});
   else for(const image of delivered){image.image_view_events??=[];image.image_view_events.push({id:item.id,path:item.path,at:r.timestamp});}
  }
  return {valid:true,reason:null,calls,images,records,unknown_images,read_audit:audit,metadata:meta,limitations:['Initial parent plaintext exposure unavailable; input file is separately pinned.','Shared filesystem is instruction-constrained.','Audited calls do not constitute complete OS/file/network surveillance.']};
 }catch(e){return fail(String(e));}
}
/** 只投影实际返回 DraftFrame 的既有读取接口；不遍历任意响应寻找路径。 */
export function draftArtifactResponse(request:any,response:any){
 if(response.status!==200||response.body?.ok!==true)return null;
 const u=new URL(request.path,'http://127.0.0.1'),data=response.body.data;let input:any,frames:any[];
 if(request.method==='POST'&&['/api/v1/collaboration/maker/get_frame_artifacts','/api/v1/collaboration/maker/list_frames'].includes(u.pathname)){input=parse(request.body);frames=u.pathname.endsWith('/get_frame_artifacts')?[data.frame]:data.items;if(input.frame_id&&frames[0]?.frame_id!==input.frame_id)return null;}
 else if(request.method==='GET'&&u.pathname==='/api/v1/collaboration/draft'){input=Object.fromEntries(u.searchParams);if(data.context?.project_id!==input.project_id||data.context?.axis_id!==input.axis_id)return null;frames=data.frames;}
 else return null;
 if(!input.project_id||!input.axis_id||!Array.isArray(frames)||frames.some(f=>!f?.frame_id||!f.source_frame_id))return null;
 return {context:{project_id:input.project_id,axis_id:input.axis_id},frames,mask:data.mask};
}
export function withinArtifactWorkspace(workspace:string,path:string){if(!workspace||!path||!isAbsolute(path))return false;const r=relative(resolve(workspace),resolve(path));return !!r&&!r.startsWith('..')&&!isAbsolute(r);}
function draftArtifactBindings(events:any[],workspace:string){
 const rows:any[]=[];const samePath=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&resolve(a)===resolve(b);
 for(const event of events.filter(e=>e.channel==='draft_artifact_provenance'&&e.phase==='evaluator'))for(const p of event.frames??[]){const row:any={valid:false,at:event.at,frame_id:p.frame_id,request_id:event.id};rows.push(row);
  try{const requests=events.filter(e=>e.id===event.id&&e.channel==='http_request'&&e.phase==='evaluator'),responses=events.filter(e=>e.id===event.id&&e.channel==='http_response'&&e.phase==='evaluator');if(requests.length!==1||responses.length!==1)throw Error('REQUEST_RESPONSE_PAIR');const request=requests[0],response=responses[0],projection=draftArtifactResponse(request,response);const f=projection?.frames.find(f=>f.frame_id===p.frame_id);if(!projection||!f||!(Date.parse(request.at)<=Date.parse(response.at)&&Date.parse(response.at)<=Date.parse(event.at)))throw Error('RESPONSE_IDENTITY_TIME');
   const context=projection.context,meta=parse(p.row.metadata),probe=parse(p.source.probe_json),map=probe.kind==='png_sequence'?probe.frames?.find((x:any)=>x.source_frame_id===f.source_frame_id):parse(p.source_frame?.timing_json);
   if(p.row.id!==f.frame_id||p.row.project_id!==context.project_id||p.row.axis_id!==context.axis_id||!samePath(p.row.raw_path,f.raw_path)||meta.source_id!==p.source.id||p.source.project_id!==context.project_id||meta.source_frame_id!==f.source_frame_id||meta.source_index!==f.source_index||map?.source_frame_id!==f.source_frame_id||map.source_index!==f.source_index)throw Error('FRAME_SOURCE_CONTEXT');
   if(probe.kind!=='png_sequence'&&(p.source_frame.source_id!==p.source.id||p.source_frame.source_frame_id!==f.source_frame_id||p.source_frame.source_index!==f.source_index))throw Error('VIDEO_SOURCE_MAPPING');
   const canonical=probe.kind==='png_sequence'?map.canonical_path:join(workspace,'sources',p.source.id,map.file);if(!samePath(canonical,p.canonical.path)||!withinArtifactWorkspace(workspace,canonical)||p.canonical.sha256!==f.raw_sha256||(probe.kind==='png_sequence'&&map.sha256!==f.raw_sha256))throw Error('CANONICAL_SOURCE');
   if((p.mask_head?.version_id??null)!==f.mask_version_id)throw Error('MASK_HEAD');
   if(f.mask_version_id&&(p.mask_version?.id!==f.mask_version_id||p.mask_version.frame_id!==f.frame_id||p.mask_version.raw_sha256!==f.raw_sha256||!(samePath(p.mask_version.raw_path,f.raw_path)||samePath(p.mask_version.raw_path,canonical))||!samePath(p.mask_version.mask_path,f.mask_path)||!samePath(p.mask_version.rgba_path,f.rgba_path)))throw Error('MASK_VERSION');
   const mask=projection.mask;if(mask&&(mask.frame_id!==f.frame_id||mask.version_id!==f.mask_version_id||mask.source_changed||mask.current?.id!==(f.mask_version_id??undefined)))throw Error('RETURNED_MASK_VERSION');
   const files=[];for(const representation of ['raw','mask','rgba']){const path=f[representation+'_path'];if(path==null)continue;const matches=p.files.filter((x:any)=>x.representation===representation),file=matches[0];if(matches.length!==1||!samePath(file.path,path)||!samePath(file.real_path,path)||!withinArtifactWorkspace(workspace,path)||file.sha256!==f[representation+'_sha256']||!(Date.parse(response.at)<=Date.parse(file.observed_at)&&Date.parse(file.observed_at)<=Date.parse(event.at)))throw Error('ARTIFACT_PATH_HASH_TIME');files.push({...file,representation});}
   if(mask?.raw_path&&!samePath(mask.raw_path,f.raw_path)){if(!samePath(mask.raw_path,canonical)||!samePath(p.canonical.real_path,canonical)||!(Date.parse(response.at)<=Date.parse(p.canonical.observed_at)&&Date.parse(p.canonical.observed_at)<=Date.parse(event.at)))throw Error('RETURNED_RAW_ALIAS');files.push({...p.canonical,representation:'raw_source'});}
   if(!files.length)throw Error('NO_ARTIFACT_BYTES');Object.assign(row,{valid:true,context,source_id:p.source.id,source_frame_id:f.source_frame_id,source_index:f.source_index,mask_version_id:f.mask_version_id,files,response_at:response.at});
  }catch(e){row.reason=String(e);}
 }return rows;
}
/** 每个已传给模型的图像按实际字节和调用目标归属；联系表按所有包含帧计。 */
export function accountImageEvidence(candidates:any[],capture:ReturnType<typeof inspectCaptureBinding>,planTimeline?:any[],options:{original_assets?:FilePin[];sources?:any[];visual_limit?:number;workspace?:string;artifact_events?:any[]}={}){
 const exposures:any[]=[],source_inspections:any[]=[],unknown:any[]=[...capture.unknown_images],failures:any[]=[];
 const norm=(p:string)=>p.replace(/\\+/g,'/');
 // 路径子串（例如 image.png.extra）不等于真实调用了 image.png。
 const targets=(input:string,path:string)=>new RegExp('(^|["\'`(\\s])'+norm(path).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|["\'`\\s),;}])').test(input);
 const originals=(options.original_assets??[]).filter(p=>existsSync(p.path)&&sha256(readFileSync(p.path))===p.sha256);
 const links=(options.sources??[]).flatMap(s=>{let probe:any;try{probe=parse(s.probe_json);}catch{return [];}
  return (probe?.frames??[]).flatMap((f:any)=>{const pins=originals.filter(p=>norm(p.path).split('/').at(-1)===f.original_name&&p.sha256===f.sha256);return pins.length===1?[{source_id:s.id,source_frame_id:f.source_frame_id,path:pins[0]!.path}]:[];});});
 const frameKey=(m:any,f:any)=>{const link=links.find(l=>l.source_id===m.brief?.source_id&&l.source_frame_id===f.source_frame_id);return link?'input:'+norm(link.path):f.source_frame_id?'source:'+m.brief?.source_id+':'+f.source_frame_id:'candidate:'+m.candidate_id+':'+f.frame_id;};
 const requestFrames=new Set<string>();
 const draftBindings=options.workspace?draftArtifactBindings(options.artifact_events??[],options.workspace):[];
 for(const image of capture.images){const call=capture.calls.find(c=>c.payload.call_id===image.call_id);if(!call){unknown.push(image);continue;}
  const input=String(call.payload.input??call.payload.arguments??'').replace(/\\+/g,'/');const matches:any[]=[];
  for(const c of candidates){const m=c.manifest??parse(c.manifest_json);const prefix=String(c.directory??'').replaceAll('\\','/');
   for(const f of m.frames)for(const representation of ['png','raw','mask','rgba']){if(f.files[representation]&&f[representation+'_sha256']===image.sha256&&targets(input,prefix+'/'+f.files[representation]))matches.push({candidate_id:m.candidate_id,frame_ids:[f.frame_id],content_hashes:[f.content_hash],request_frame_ids:[frameKey(m,f)],call_id:image.call_id,sha256:image.sha256,kind:'frame',representation,final_composite:representation==='png'});}
   for(const s of [...(m.sheets??[]),...(m.auxiliary_files??[])])if(s.sha256===image.sha256&&targets(input,prefix+'/'+s.file)){const frames=s.file.includes('contact')?m.frames:m.frames.filter((f:any)=>m.sheets[f.grid_cell.sheet_index]?.file===s.file);matches.push({candidate_id:m.candidate_id,frame_ids:frames.map((f:any)=>f.frame_id),content_hashes:frames.map((f:any)=>f.content_hash),request_frame_ids:frames.map((f:any)=>frameKey(m,f)),call_id:image.call_id,sha256:image.sha256,kind:'multi_frame',final_composite:true});}
  }
  for(const p of originals)if(p.sha256===image.sha256&&targets(input,p.path))matches.push({kind:'source_inspection',path:p.path,sha256:p.sha256,call_id:image.call_id,final_composite:false,request_frame_ids:['input:'+norm(p.path)]});
  // 保留读取时的身份及字节；不从结束后的可变制作文件反推历史观察。
  const viewAt=image.image_view_events?.find((v:any)=>targets(input,decodeURIComponent(String(v.path).replace(/^file:\/\//,'')).replace(/^\/([A-Za-z]:)/,'$1')))?.at??call.timestamp;
  if(Number.isFinite(Date.parse(viewAt))&&Date.parse(viewAt)<=Date.parse(image.at))for(const binding of draftBindings.filter(b=>Date.parse(b.at)<=Date.parse(viewAt))){
   if(!binding.valid||draftBindings.some(b=>b.frame_id===binding.frame_id&&Date.parse(b.at)>Date.parse(binding.at)&&Date.parse(b.at)<=Date.parse(viewAt)))continue;
   for(const file of binding.files)if(file.sha256===image.sha256&&targets(input,file.path)){const key=frameKey({candidate_id:null,brief:{source_id:binding.source_id}},{source_frame_id:binding.source_frame_id});matches.push({kind:'draft_artifact',...binding,representation:file.representation,path:file.path,sha256:file.sha256,call_id:image.call_id,viewed_at:viewAt,final_composite:false,request_frame_ids:[key],observed_response_at:binding.response_at,observed_provenance_at:binding.at});}
  }
  if(matches.length!==1){unknown.push({...image,reason:matches.length?'ambiguous image target':'unclassified image bytes/path'});continue;}
  const e={...matches[0],at:image.at};for(const id of e.request_frame_ids)requestFrames.add(id);
  if(!['source_inspection','draft_artifact'].includes(e.kind)){exposures.push(e);continue;}
  source_inspections.push(e);
  // 候选创建前的原图查看单独记为源素材证据，不要求尚不存在的候选计划。
  // 候选已经存在时，查看其原图别名也消耗该候选固定计划中的帧名额。
  for(const c of candidates){const m=c.manifest??parse(c.manifest_json),frames=m.frames.filter((f:any)=>e.kind==='draft_artifact'?m.brief?.source_id===e.source_id&&m.brief?.context?.project_id===e.context.project_id&&m.brief?.context?.axis_id===e.context.axis_id&&f.source_frame_id===e.source_frame_id&&f.frame_id===e.frame_id:frameKey(m,f)==='input:'+norm(e.path));if(!frames.length)continue;
   const viewed=Date.parse(e.viewed_at??e.at),created=Number(c.created_at);if(!Number.isFinite(viewed)||!Number.isFinite(created)){failures.push({code:'source_inspection_time_unknown',candidate_id:m.candidate_id,call_id:e.call_id});continue;}
   if(viewed>=created)exposures.push({...e,candidate_id:m.candidate_id,frame_ids:frames.map((f:any)=>f.frame_id),content_hashes:frames.map((f:any)=>f.content_hash)});
  }
 }
 if(options.visual_limit!==undefined&&requestFrames.size>options.visual_limit)failures.push({code:'request_visual_budget',seen:requestFrames.size,budget:options.visual_limit});
 if(planTimeline)for(const e of exposures)if(!(e.viewed_at??e.at)||!planTimeline.some(p=>p.candidate_id===e.candidate_id&&p.at<=(e.viewed_at??e.at)))failures.push({code:'plan_not_observed_before_image',...e});
 const candidate_budgets:any[]=[];
 for(const c of candidates){const m=c.manifest??parse(c.manifest_json),plan=c.plan??(c.sampling_plan_json?parse(c.sampling_plan_json):null),self=c.self??(c.self_check_json?parse(c.self_check_json):null);const seen=new Set(exposures.filter(x=>x.candidate_id===m.candidate_id).flatMap(x=>x.frame_ids));
  candidate_budgets.push({candidate_id:m.candidate_id,frame_ids:[...seen],budget:plan?.budget??null});
  if(seen.size&&(!plan||seen.size>plan.budget||[...seen].some(id=>!plan.samples.some((s:any)=>s.frame_id===id))))failures.push({code:'plan_or_budget',candidate_id:m.candidate_id,seen:[...seen],budget:plan?.budget??null});
  for(const o of self?.observations??[]){if(!o.viewed)continue;const evidenceId=o.evidence_candidate_id??m.candidate_id;let ancestor=m;const visited=new Set();while(ancestor&&ancestor.candidate_id!==evidenceId&&!visited.has(ancestor.candidate_id)){visited.add(ancestor.candidate_id);const parent=candidates.find(x=>(x.manifest??parse(x.manifest_json)).candidate_id===ancestor.parent_candidate_id);ancestor=parent?(parent.manifest??parse(parent.manifest_json)):null;}
   const ancestorFrame=ancestor?.frames.find((f:any)=>f.frame_id===o.frame_id&&f.content_hash===o.frame_content_hash);
   const source=candidates.find(x=>(x.manifest??parse(x.manifest_json)).candidate_id===evidenceId),sourceSelf=source?.self??(source?.self_check_json?parse(source.self_check_json):null);
   const authentic=evidenceId===m.candidate_id||sourceSelf?.observations?.some((v:any)=>v.viewed&&v.evidence_candidate_id===evidenceId&&['frame_id','frame_content_hash','result','explanation','evidence_source'].every(k=>v[k]===o[k]));
   if(!ancestorFrame||!authentic||!exposures.some(e=>e.final_composite&&e.candidate_id===evidenceId&&e.frame_ids.includes(o.frame_id)&&e.content_hashes.includes(o.frame_content_hash)))failures.push({code:'view_or_ancestor_evidence_missing',candidate_id:m.candidate_id,frame_id:o.frame_id,evidence_candidate_id:evidenceId});
  }
 }return {exposures,source_inspections,draft_artifact_bindings:draftBindings,candidate_budgets,request_budget:{frame_ids:[...requestFrames],budget:options.visual_limit??null},unknown,failures,complete:unknown.length===0&&failures.length===0};
}
/** 两次独立父级续作触发，在各自窗口内读到原操作的真实成功结果。 */
export function continuationFacts(binding:any,agentPath:string,events:any[],operationId:string,candidateId:string){
 const triggers:any[]=[],errors:string[]=[];
 for(const t of binding?.triggers??[]){try{const rows=JSON.parse(pinned(t.parent_records)).records;const req=rows.find((r:any)=>r.payload?.call_id===t.call_id&&['followup_task','send_message'].includes(r.payload?.name));const out=rows.find((r:any)=>r.payload?.call_id===t.call_id&&r.payload?.type==='function_call_output');const args=parse(req?.payload?.arguments);if(!out||args.target!==agentPath||!req.timestamp)throw Error('CONTINUATION_IDENTITY');pinned(t.plaintext);triggers.push({call_id:t.call_id,at:req.timestamp});}catch(e){errors.push(String(e));}}
 triggers.sort((a,b)=>a.at.localeCompare(b.at));const windows=triggers.map((t,i)=>{const end=triggers[i+1]?.at??'9999';const reads=events.filter(e=>e.channel==='http_request'&&e.phase==='evaluator'&&e.at>t.at&&e.at<end).filter(e=>{const path=new URL(e.path,'http://127.0.0.1').pathname;try{return path==='/api/v1/collaboration/operations/'+operationId||['/api/v1/collaboration/maker/inspect_operation','/api/v1/collaboration/maker/resume_operation'].includes(path)&&parse(e.body).operation_id===operationId;}catch{return false;}}).flatMap(e=>{const r=events.find(v=>v.channel==='http_response'&&v.id===e.id&&v.status===200),op=r?.body?.data;return op?.id===operationId&&op.state==='succeeded'&&op.result?.candidate_id===candidateId?[{request_id:e.id,response_at:r.at}]:[];});return {...t,end,successful_original_result_reads:reads};});
 return {complete:errors.length===0&&triggers.length===2&&new Set(triggers.map(t=>t.call_id)).size===2&&windows.every(w=>w.successful_original_result_reads.length>0),windows,errors};
}
