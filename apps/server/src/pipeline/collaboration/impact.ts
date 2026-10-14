import {Ajv} from 'ajv';
import {candidateManifestSchema,canonicalizeJson,rootAt} from '@framebaker/shared';
import type {CandidateManifest,CandidateFrame,ImpactReport,JsonValue,TaskBrief,Rational,TaskTiming} from '@framebaker/shared';

const validManifest=new Ajv({strict:true,allErrors:true}).compile<CandidateManifest>(candidateManifestSchema);
const canonical=(value:unknown)=>new TextDecoder().decode(canonicalizeJson(value as JsonValue));
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const preset=(m:CandidateManifest)=>({canvas:m.alignment.canvas,anchor:m.alignment.anchor,scale:m.alignment.scale,resampling:m.alignment.resampling});
const sameRational=(a:Rational,b:Rational)=>BigInt(a.num)*BigInt(b.den)===BigInt(b.num)*BigInt(a.den);
const sameDuration=(a:CandidateFrame,b:CandidateFrame)=>sameRational(a.duration,b.duration);
function sameTiming(a:TaskTiming,b:TaskTiming):boolean {
 if(a.mode==='source_pts')return b.mode==='source_pts';
 if(a.mode==='confirmed_fps')return b.mode==='confirmed_fps'&&sameRational(a.fps,b.fps);
 return b.mode==='explicit_durations'&&a.durations.length===b.durations.length&&a.durations.every((d,i)=>sameRational(d,b.durations[i]!));
}

/** 已知要求逐项解释；新增字段由严格 schema 拒绝，不能静默排除新目标。 */
function briefRisk(a:TaskBrief,b:TaskBrief,next:CandidateManifest):string|null {
 if(!equal(a.goal,b.goal))return '用户原话目标改变，需要全序列重新确认';
 if(!equal(a.source_identity,b.source_identity))return '原始源字节身份改变，需要全序列重新确认';
 if(!equal(a.context,b.context))return '项目或动作上下文改变，不能跨上下文继承';
 if(a.source_id!==b.source_id)return '源素材要求改变，需重新核对整个动作';
 if(!equal(a.subject_region.value,b.subject_region.value))return '主体区域要求改变，需重新确认整个动作';
 if(!equal(a.alignment.value,b.alignment.value)&&!equal(b.alignment.value,next.alignment))return '新对齐要求与候选实际配置不一致，影响无法可靠确定';
 if(!equal(a.ordered_source_frame_ids,b.ordered_source_frame_ids)&&!equal(b.ordered_source_frame_ids,next.frames.map(f=>f.source_frame_id)))return '新源帧顺序要求与候选实际顺序不一致';
 // 已知同模式时长要求须与实际结果相符；模式变化或缺失依据按未知上下文处理。
 if(!sameTiming(a.timing.value,b.timing.value)){
  const timing=b.timing.value;
  if(a.timing.value.mode!==timing.mode||timing.mode==='source_pts')return '冻结时间要求模式改变，需按新要求重新确认动作';
  const desired=new Map(b.ordered_source_frame_ids.map((id,i)=>[id,timing.mode==='confirmed_fps'?{num:timing.fps.den,den:timing.fps.num}:timing.durations[i]]));
  if(next.frames.some(f=>!desired.get(f.source_frame_id)||!sameRational(f.duration,desired.get(f.source_frame_id)!)))return '冻结时间要求与实际时长不一致，需全序列复审';
 }
 return null;
}

/** 不重建渲染器：仅核对冻结的稳定映射、索引根和已知来源上下文。 */
function contextRisk(m:CandidateManifest):string|null {
 if(!validManifest(m))return '候选清单缺少可验证上下文或含未知字段，需全序列复审';
 if(!m.brief.goal||!m.brief.source_identity)return '历史候选缺少原话目标或可验证源身份，需全序列复审';
 const ids=new Set<string>(),sources=new Set<string>();
 const indices=m.alignment.roots.map(r=>r.index);
 if(new Set(indices).size!==indices.length||indices.some(i=>i>=m.frames.length)||(m.alignment.mode==='fixed'&&indices.length!==1))return '根轨迹索引存在歧义';
 if(Object.keys(m.alignment.offsets).some(key=>! /^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=m.frames.length))return '逐帧偏移索引无法对应冻结序列';
 if(m.coverage.length!==m.frames.length)return '期望选择与冻结帧覆盖不一致';
 for(const [i,f] of m.frames.entries()){
  if(ids.has(f.frame_id)||sources.has(f.source_frame_id)||f.sequence_index!==i)return '稳定帧、源映射或序号存在歧义';
  ids.add(f.frame_id);sources.add(f.source_frame_id);
  const coverage=m.coverage[i];
  if(coverage?.frame_id!==f.frame_id||coverage.source_frame_id!==f.source_frame_id)return '选择记录无法对应冻结帧及源帧';
  if(!['imported','manual','automatic'].includes(f.mask_provenance.kind))return '遮罩来源未知，无法证明审查上下文未变';
  if(f.source_to_canvas.noninvertible_reason&&f.source_to_canvas.noninvertible_reason!=='ZERO_DETERMINANT')return '源到画布映射不可验证';
  const root=rootAt(m.alignment,i);
  if(root.x!==f.resolved_root.x||root.y!==f.resolved_root.y)return '冻结根位置与索引轨迹不一致，需全序列复审';
 }
 if(m.brief.ordered_source_frame_ids.length!==sources.size||m.brief.ordered_source_frame_ids.some(id=>!sources.has(id)))return '源选择要求与冻结帧不一致';
 if(m.output.loop!==m.brief.loop.value)return '循环要求与冻结播放配置不一致';
 return null;
}

function neighbors(m:CandidateManifest):Map<string,Set<string>> {
 const result=new Map(m.frames.map(f=>[f.frame_id,new Set<string>()]));
 for(const [a,b] of edges(m).values()){result.get(a)!.add(b);result.get(b)!.add(a);}
 return result;
}
function edges(m:CandidateManifest):Map<string,[string,string]> {
 const result=new Map<string,[string,string]>();
 const add=(a:string,b:string)=>result.set(JSON.stringify([a,b]),[a,b]);
 for(let i=1;i<m.frames.length;i++)add(m.frames[i-1]!.frame_id,m.frames[i]!.frame_id);
 if(m.output.loop&&m.frames.length)add(m.frames.at(-1)!.frame_id,m.frames[0]!.frame_id);
 return result;
}

/** 纯结构资格，不读数据库、不写批准；调用者仍须验证实际文件及当前人工审核/问题状态。 */
export function compareCandidates(parent:CandidateManifest,next:CandidateManifest):ImpactReport {
 const nextIds=[...new Set(next.frames.map(f=>f.frame_id))],current=new Set(nextIds);
 const changed=new Set<string>(),recheck=new Set<string>(),reasons=new Map<string,Set<string>>();
 const report:ImpactReport={changed_frame_ids:[],recheck_frame_ids:[],inheritable_frame_ids:[],playback_changed:false,reasons:[],preset_impacts:[]};
 const reason=(id:string,text:string)=>{if(!reasons.has(id))reasons.set(id,new Set());reasons.get(id)!.add(text);};
 const mark=(id:string,text:string,direct=true)=>{reason(id,text);if(current.has(id)){recheck.add(id);if(direct)changed.add(id);}};
 const finish=()=>{
  report.changed_frame_ids=nextIds.filter(id=>changed.has(id));report.recheck_frame_ids=nextIds.filter(id=>recheck.has(id));
  report.inheritable_frame_ids=nextIds.filter(id=>!recheck.has(id));
  report.reasons=[...reasons].map(([frame_id,r])=>({frame_id,reasons:[...r]}));return report;
 };
 const full=(text:string)=>{for(const id of nextIds)mark(id,text);report.playback_changed=true;return finish();};
 // 无法验证清单时仍返回新帧范围；旧帧删除信息保留在原因中。
 for(const f of parent.frames)if(!current.has(f.frame_id))reason(f.frame_id,'该帧已从新候选移除；旧连接需要复审');
 const risk=contextRisk(parent)??contextRisk(next);
 if(risk)return full(risk);
 if(parent.task_id!==next.task_id||next.parent_candidate_id!==parent.candidate_id||next.candidate_id===parent.candidate_id)return full('候选父子关系或任务上下文无法验证');
 if(!equal(preset(parent),preset(next))){
  report.preset_impacts.push({context:next.brief.context,reason:'公共画布、锚点、比例或重采样改变，项目全部动作需要核对更新'});
  return full('公共画布、锚点、比例或重采样改变，全序列需复审');
 }
 const brief=briefRisk(parent.brief,next.brief,next);if(brief)return full(brief);
 if(parent.compositor_hash!==next.compositor_hash||!equal(parent.compositor,next.compositor))return full('合成语义或版本改变，需重新确认全部帧');
 const old=new Map(parent.frames.map(f=>[f.frame_id,f]));
 for(const f of next.frames){const before=old.get(f.frame_id);if(!before)continue;
  if(!equal(before.mask_provenance,f.mask_provenance))return full('遮罩来源或质量上下文改变，不能仅凭相同像素继承');
  if(before.source_frame_id===f.source_frame_id&&before.source_index!==f.source_index)return full('相同源帧的源索引改变，来源映射无法证明一致');
 }
 const direct=new Set<string>();
 for(const f of parent.frames)if(!current.has(f.frame_id))direct.add(f.frame_id);
 for(const f of next.frames){
  const before=old.get(f.frame_id);
  if(!before){direct.add(f.frame_id);mark(f.frame_id,'新增帧需要确认');continue;}
  const fields:Array<[keyof CandidateFrame,string]>=[['source_frame_id','源帧引用改变'],['raw_sha256','源文件字节改变'],['mask_sha256','遮罩字节改变'],['rgba_sha256','抠图 RGBA 字节改变'],['png_sha256','最终 PNG 字节改变'],['source_size','源尺寸改变'],['resolved_transform','实际编辑变换改变'],['resolved_root','实际根位置改变（含插值或端点保持）'],['source_to_canvas','实际源到画布映射改变'],['content_hash','逐帧可审内容身份改变']];
  for(const [field,text] of fields)if(!equal(before[field],f[field])){direct.add(f.frame_id);mark(f.frame_id,text);}
  if(!sameDuration(before,f)){direct.add(f.frame_id);mark(f.frame_id,'实际有理数时长改变，需复审节奏');}
  if(before.duration_origin!==f.duration_origin){direct.add(f.frame_id);mark(f.frame_id,'时长依据改变，需重新核对节奏来源');}
 }
 // 内容、时长、新增与删除只扩展一次旧/新邻接；边端点不作为二次扩展种子。
 for(const adjacency of [neighbors(parent),neighbors(next)])for(const id of direct)for(const neighbor of adjacency.get(id)??[])if(neighbor!==id&&current.has(neighbor))mark(neighbor,`与变更帧 ${id} 的衔接需要复审`,false);
 // 循环旋转可能保留全部边，但第一帧及播放顺序仍改变；忽略单纯增删造成的序号平移。
 const oldOrder=parent.frames.filter(f=>current.has(f.frame_id)).map(f=>f.frame_id);
 const newOrder=next.frames.filter(f=>old.has(f.frame_id)).map(f=>f.frame_id);
 for(let i=0;i<newOrder.length;i++)if(oldOrder[i]!==newOrder[i])mark(newOrder[i]!,'稳定帧相对播放位置改变，需要复审');
 const oldEdges=edges(parent),newEdges=edges(next);
 for(const [left,right] of [[oldEdges,newEdges],[newEdges,oldEdges]] as const)for(const [key,[a,b]] of left)if(!right.has(key)){
  mark(a,`有向连接 ${a} → ${b} 改变，需要复审`);mark(b,`有向连接 ${a} → ${b} 改变，需要复审`);
 }
 report.playback_changed=direct.size>0||recheck.size>0||parent.output.loop!==next.output.loop;
 return finish();
}
