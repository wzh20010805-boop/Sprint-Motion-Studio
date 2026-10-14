import {createHash} from 'node:crypto';
import {canonicalizeJson} from '@framebaker/shared';
import type {CandidateManifest,JsonValue,SamplingPlan,SamplingRisk} from '@framebaker/shared';

type Fraction={n:bigint;d:bigint};
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
const frac=(n:bigint,d:bigint):Fraction=>{const g=gcd(n,d);return {n:n/g,d:d/g};};
const add=(a:Fraction,b:Fraction)=>frac(a.n*b.d+b.n*a.d,a.d*b.d);
const cmp=(a:Fraction,b:Fraction)=>a.n*b.d<b.n*a.d?-1:a.n*b.d>b.n*a.d?1:0;
const sub=(a:Fraction,b:Fraction)=>frac(a.n*b.d-b.n*a.d,a.d*b.d);
const hash=(v:unknown)=>createHash('sha256').update(canonicalizeJson(v as JsonValue)).digest('hex');
const legal=new Set([0,100,200,201,202,300]);
const invalid=():never=>{throw new Error('INVALID_SAMPLING_INPUT');};
const positive=(n:number)=>Number.isSafeInteger(n)&&n>0;
export function selectCandidateSamples(manifest:CandidateManifest,risks:Array<{frame_id:string;priority:number;reason:string}>,limit=12):SamplingPlan {
 const frames=manifest.frames,N=frames.length,userLimit=manifest.brief.sampling_limit;
 if(!N||!positive(limit)||!positive(userLimit)||new Set(frames.map(f=>f.frame_id)).size!==N||frames.some((f,i)=>f.sequence_index!==i||!positive(f.duration.num)||!positive(f.duration.den)))invalid();
 const indices=new Map(frames.map((f,i)=>[f.frame_id,i]));
 if(risks.some(r=>!indices.has(r.frame_id)||!legal.has(r.priority)||typeof r.reason!=='string'||!r.reason.trim()))invalid();
 const grouped=new Map<string,{priority:number;reasons:Set<string>}>();
 for(const r of risks){const old=grouped.get(r.frame_id);if(old){old.priority=Math.min(old.priority,r.priority);old.reasons.add(r.reason);}else grouped.set(r.frame_id,{priority:r.priority,reasons:new Set([r.reason])});}
 const canonical:SamplingRisk[]=[...grouped].map(([frame_id,r])=>({frame_id,priority:r.priority as SamplingRisk['priority'],reason:[...r.reasons].sort().join('; ')})).sort((a,b)=>a.priority-b.priority||indices.get(a.frame_id)!-indices.get(b.frame_id)!);
 const budget=Math.min(12,Math.max(1,Math.floor(N/2)),userLimit,limit),selected=new Map<number,Set<string>>();
 const select=(i:number,reason:string)=>{const old=selected.get(i);if(old)old.add(reason);else selected.set(i,new Set([reason]));};
 if(budget===1)select(canonical.length?indices.get(canonical[0]!.frame_id)!:0,canonical.length?'risk':'first');
 else {
  select(0,'first');select(N-1,'last');let added=0;
  for(const r of canonical){const i=indices.get(r.frame_id)!;if(!selected.has(i)&&added<Math.min(4,budget-2)){select(i,'risk');added++;}}
  const R=Math.min(8,budget-added),intervals:Array<{start:Fraction;end:Fraction}>=[];let end=frac(0n,1n);
  for(const f of frames){const start=end;end=add(end,frac(BigInt(f.duration.num),BigInt(f.duration.den)));intervals.push({start,end});}
  for(let j=1;j<R-1;j++){
   const target=frac(end.n*BigInt(j),end.d*BigInt(R-1));let i=intervals.findIndex(v=>cmp(target,v.end)<=0);
   if(selected.has(i)){
    let best:Fraction|undefined;i=-1;
    for(let k=0;k<N;k++){if(selected.has(k))continue;const v=intervals[k]!,distance=cmp(target,v.start)<0?sub(v.start,target):cmp(target,v.end)>0?sub(target,v.end):frac(0n,1n);if(best===undefined||cmp(distance,best)<0){i=k;best=distance;}}
   }
   if(i>=0)select(i,'regular');
  }
 }
 for(const r of canonical){const i=indices.get(r.frame_id)!;if(selected.has(i))select(i,`risk: ${r.reason}`);}
 const projection={candidate_id:manifest.candidate_id,content_hash:manifest.content_hash,budget,
  samples:[...selected].sort(([a],[b])=>a-b).map(([i,reasons])=>({frame_id:frames[i]!.frame_id,frame_content_hash:frames[i]!.content_hash,reason:[...reasons].sort().join('; ')})),
  uncovered_risks:canonical.filter(r=>!selected.has(indices.get(r.frame_id)!)).map(r=>r.frame_id),
  provenance:{strategy:'rational-interval-v1' as const,manifest_sha256:hash(manifest),caller_limit:limit,user_limit:userLimit,risks:canonical}};
 return {...projection,plan_hash:hash(projection)};
}
