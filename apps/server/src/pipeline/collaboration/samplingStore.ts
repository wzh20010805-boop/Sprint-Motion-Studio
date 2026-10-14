import {Ajv} from 'ajv';
import {sampleObservationSchema,samplingPlanSchema} from '@framebaker/shared';
import type {ActorContext,CandidateCheckReport,CandidateManifest,CandidateSelfCheck,SampleObservation,SamplingPlan,SamplingRisk} from '@framebaker/shared';
import {db,uid} from '../../db';
import {requireRole} from '../../localSessions';
import {PipelineError} from '../service';
import {readCandidate,readCandidateManifest,verifyCandidateFiles} from './candidates';
import {operationJson} from './operations';
import {selectCandidateSamples} from './sampling';
import {compareCandidates} from './impact';

const ajv=new Ajv({strict:true,allErrors:true});
const validPlan=ajv.compile<SamplingPlan>(samplingPlanSchema),validObservation=ajv.compile<SampleObservation>(sampleObservationSchema);
function fail(code:string):never {throw new PipelineError(code,code,409);}
type Appendix={sampling_plan_json:string|null;self_check_id:string|null;self_check_json:string|null;technical_check_id:string|null;technical_check_json:string|null};
const appendix=(id:string)=>{readCandidate(id);return db.query('SELECT sampling_plan_json,self_check_id,self_check_json,technical_check_id,technical_check_json FROM candidates WHERE id=?').get(id) as Appendix;};
function technical(id:string,m:CandidateManifest):CandidateCheckReport {
 const r=readCandidate(id),a=appendix(id),t=a.technical_check_json?JSON.parse(a.technical_check_json):null;
 if(!a.technical_check_id||t?.id!==a.technical_check_id||t.candidate_id!==id||t.content_hash!==m.content_hash||t.manifest_sha256!==r.manifest_sha256||t.checked_frame_count!==m.frames.length||!Array.isArray(t.blocking_errors)||!Array.isArray(t.warnings))fail('TECHNICAL_CHECK_FAILED');
 return t;
}
/** 读取技术检查、修复关联及完整结构影响；已保存计划不会因风险刷新而改变。 */
export function candidateSamplingRisks(m:CandidateManifest,check:CandidateCheckReport):SamplingRisk[] {
 const risks:SamplingRisk[]=[],ids=new Set(m.frames.map(f=>f.frame_id));
 const push=(frame_id:string,priority:SamplingRisk['priority'],reason:string)=>{if(ids.has(frame_id))risks.push({frame_id,priority,reason});else fail('INVALID_SAMPLING_RISK');};
 for(const e of check.blocking_errors)if(e.frame_id)push(e.frame_id,200,`technical: ${e.code}`);
 const known:Record<string,SamplingRisk['priority']>={LOW_CONFIDENCE:200,EMPTY_MASK:200,SMALL_FOREGROUND:201,TOUCHES_BORDER:201,OPAQUE_MASK:202};
 for(const w of check.warnings)if(w.frame_id)push(w.frame_id,known[w.code]??202,`warning: ${w.code}`);
 const repairIds=new Set<string>();
 for(const issue of db.query('SELECT repair_frame_ids_json FROM review_issues WHERE repair_candidate_id=?').all(m.candidate_id) as Array<{repair_frame_ids_json:string|null}>){for(const id of JSON.parse(issue.repair_frame_ids_json??'[]')){push(id,0,'repair-linked');repairIds.add(id);}}
 if(m.parent_candidate_id){
  const parent=readCandidateManifest(m.parent_candidate_id);if(parent.task_id!==m.task_id)fail('CANDIDATE_PARENT_MISMATCH');
  const impact=compareCandidates(parent,m),direct=new Set(impact.changed_frame_ids);
  for(const id of impact.recheck_frame_ids)push(id,direct.has(id)?300:100,direct.has(id)?'candidate-impact-changed':'candidate-impact-neighbor');
 }
 for(const id of repairIds){const i=m.frames.findIndex(f=>f.frame_id===id);for(const j of [i-1,i+1]){const k=m.output.loop?(j+m.frames.length)%m.frames.length:j;if(k>=0&&k<m.frames.length&&k!==i)push(m.frames[k]!.frame_id,100,'repair-neighbor');}}
 return risks;
}
function savedPlan(id:string,m:CandidateManifest):SamplingPlan {
 const raw=appendix(id).sampling_plan_json;if(!raw)fail('SAMPLING_PLAN_REQUIRED');const p=JSON.parse(raw);
 if(!validPlan(p)||!p.provenance||p.candidate_id!==id||p.content_hash!==m.content_hash||p.provenance.manifest_sha256!==readCandidate(id).manifest_sha256)fail('SAMPLING_PLAN_INVALID');
 let expected:SamplingPlan;try{expected=selectCandidateSamples(m,p.provenance.risks,p.provenance.caller_limit);}catch{fail('SAMPLING_PLAN_INVALID');}
 if(operationJson(expected)!==operationJson(p))fail('SAMPLING_PLAN_INVALID');return p;
}
export function getCandidateSamplingPlan(id:string,actor:ActorContext,limit=12):SamplingPlan {
 requireRole(actor,'maker');if(!Number.isSafeInteger(limit)||limit<1)fail('INVALID_SAMPLING_LIMIT');
 return db.transaction(()=>{const m=readCandidateManifest(id);verifyCandidateFiles(id,m);if(appendix(id).sampling_plan_json)return savedPlan(id,m);
  const p=selectCandidateSamples(m,candidateSamplingRisks(m,technical(id,m)),limit);
  db.query('UPDATE candidates SET sampling_plan_json=? WHERE id=? AND sampling_plan_json IS NULL').run(operationJson(p),id);return savedPlan(id,m);
 }).immediate();
}
function buildSelf(id:string,m:CandidateManifest,p:SamplingPlan,observations:SampleObservation[],selfId:string,t:CandidateCheckReport):CandidateSelfCheck {
 return {id:selfId,candidate_id:id,content_hash:m.content_hash,manifest_sha256:readCandidate(id).manifest_sha256,plan_hash:p.plan_hash,
  completed:observations.length===p.samples.length,blocking_errors:t.blocking_errors,technical_check:t,observations,
  viewed_frame_ids:observations.filter(o=>o.viewed).map(o=>o.frame_id),unviewed_frame_ids:observations.filter(o=>!o.viewed).map(o=>o.frame_id),
  reused_frame_ids:observations.filter(o=>o.evidence_candidate_id!==id).map(o=>o.frame_id),issue_frame_ids:observations.filter(o=>o.result==='issue').map(o=>o.frame_id),uncovered_risks:p.uncovered_risks};
}
function validateObservation(o:SampleObservation,id:string,m:CandidateManifest,p:SamplingPlan):void {
 if(!validObservation(o)||!o.evidence_candidate_id||o.candidate_id!==id||o.content_hash!==m.content_hash||o.plan_hash!==p.plan_hash||!p.samples.some(s=>s.frame_id===o.frame_id&&s.frame_content_hash===o.frame_content_hash&&m.frames.some(f=>f.frame_id===o.frame_id&&f.content_hash===o.frame_content_hash)))fail('INVALID_SAMPLE_OBSERVATION');
}
function validateReuse(o:SampleObservation,m:CandidateManifest,seen:Set<string>):void {
 if(o.evidence_candidate_id===m.candidate_id)return;
 if(!o.viewed||!o.evidence_candidate_id)fail('EVIDENCE_REUSE_INVALID');
 let id=m.parent_candidate_id;const ancestors=new Set<string>();while(id){if(ancestors.has(id))fail('EVIDENCE_REUSE_INVALID');ancestors.add(id);const parent=readCandidateManifest(id);if(parent.task_id!==m.task_id)fail('EVIDENCE_REUSE_INVALID');id=parent.parent_candidate_id;}
 if(!ancestors.has(o.evidence_candidate_id))fail('EVIDENCE_REUSE_INVALID');
 const source=readSelf(o.evidence_candidate_id,seen),old=source?.observations.find(v=>v.frame_id===o.frame_id&&v.frame_content_hash===o.frame_content_hash&&v.viewed&&v.evidence_candidate_id===o.evidence_candidate_id);
 if(!old||old.result!==o.result||old.explanation!==o.explanation||old.evidence_source!==o.evidence_source)fail('EVIDENCE_REUSE_INVALID');
}
function readSelf(id:string,seen=new Set<string>(),refreshTechnical=false):CandidateSelfCheck|null {
 if(seen.has(id))fail('EVIDENCE_REUSE_INVALID');seen=new Set(seen).add(id);
 const a=appendix(id);if(!a.self_check_json)return null;const m=readCandidateManifest(id);verifyCandidateFiles(id,m);const p=savedPlan(id,m),s=JSON.parse(a.self_check_json) as CandidateSelfCheck;
 if(!s||s.id!==a.self_check_id||!Array.isArray(s.observations)||new Set(s.observations.map(o=>o.frame_id)).size!==s.observations.length)fail('SELF_CHECK_REQUIRED');
 for(const o of s.observations){validateObservation(o,id,m,p);validateReuse(o,m,seen);}
 const sorted=[...s.observations].sort((a,b)=>p.samples.findIndex(x=>x.frame_id===a.frame_id)-p.samples.findIndex(x=>x.frame_id===b.frame_id));
 const t=refreshTechnical?s.technical_check:technical(id,m);
 if(!t||typeof t.id!=='string'||!t.id||t.candidate_id!==id||t.content_hash!==m.content_hash||t.manifest_sha256!==readCandidate(id).manifest_sha256||t.checked_frame_count!==m.frames.length||!Array.isArray(t.blocking_errors)||!Array.isArray(t.warnings))fail('SELF_CHECK_REQUIRED');
 if(operationJson(s)!==operationJson(buildSelf(id,m,p,sorted,s.id,t)))fail('SELF_CHECK_REQUIRED');return s;
}
export function readCandidateSelfCheck(id:string):CandidateSelfCheck|null {return readSelf(id);}
/** 提交与写入共用唯一事实验证器；不以任意 JSON 的 completed 字段代替检查。 */
export function requireCandidateSelfCheck(id:string):CandidateSelfCheck {
 try{const s=readSelf(id);if(!s?.completed||s.blocking_errors.length)fail('SELF_CHECK_REQUIRED');return s;}catch{fail('SELF_CHECK_REQUIRED');}
}
export function recordSampleObservations(id:string,planHash:string,observations:SampleObservation[],actor:ActorContext):void {
 requireRole(actor,'maker');db.transaction(()=>{
  const m=readCandidateManifest(id);verifyCandidateFiles(id,m);const p=savedPlan(id,m);if(planHash!==p.plan_hash)fail('SAMPLING_PLAN_CONFLICT');
  if(!Array.isArray(observations)||new Set(observations.map(o=>o.frame_id)).size!==observations.length)fail('INVALID_SAMPLE_OBSERVATION');
  const old=readSelf(id,new Set(),true),merged=new Map((old?.observations??[]).map(o=>[o.frame_id,o]));
  for(const input of observations){const o={...input,evidence_candidate_id:input.evidence_candidate_id??id};validateObservation(o,id,m,p);validateReuse(o,m,new Set([id]));const previous=merged.get(o.frame_id);if(previous&&operationJson(previous)!==operationJson(o))fail('OBSERVATION_CONFLICT');merged.set(o.frame_id,o);}
  const ordered=p.samples.flatMap(s=>merged.has(s.frame_id)?[merged.get(s.frame_id)!]:[]),self=buildSelf(id,m,p,ordered,old?.id??uid(),technical(id,m));
  // 已提交候选只允许刷新技术事实；完整观察、计划、身份和覆盖事实必须逐项保持原值。
  if(readCandidate(id).visibility==='submitted'&&(!old?.completed||operationJson({...self,technical_check:old.technical_check,blocking_errors:old.blocking_errors})!==operationJson(old)))fail('OBSERVATION_CONFLICT');
  if(old&&operationJson(old)===operationJson(self))return;
  db.query('UPDATE candidates SET self_check_id=?,self_check_json=? WHERE id=?').run(self.id,operationJson(self),id);
 }).immediate();
}
