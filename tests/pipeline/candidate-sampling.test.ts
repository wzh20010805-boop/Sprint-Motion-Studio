import {test,expect} from 'bun:test';
import type {CandidateManifest} from '@framebaker/shared';
const module = await import('../../apps/server/src/pipeline/collaboration/sampling').catch(()=>({})) as any;
const select=(m:CandidateManifest,r:any[]=[],limit=12)=>{expect(typeof module.selectCandidateSamples).toBe('function');return module.selectCandidateSamples(m,r,limit);};
const h='a'.repeat(64);
function fixture(n:number,durations=Array(n).fill(1)):CandidateManifest{return {candidate_id:'candidate',content_hash:h,brief:{sampling_limit:12},frames:durations.map((num,i)=>({frame_id:`f${i+1}`,sequence_index:i,content_hash:h,duration:{num,den:1}}))} as CandidateManifest;}
const ids=(p:any)=>p.samples.map((s:any)=>Number(s.frame_id.slice(1)));
const risk=(numbers:number[],priority=0)=>numbers.map(n=>({frame_id:`f${n}`,priority,reason:'fixture-risk'}));
for(const [n,b,want] of [[1,1,[1]],[2,1,[1]],[3,1,[1]],[4,2,[1,4]],[5,2,[1,5]],[6,3,[1,3,6]],[7,3,[1,4,7]],[9,4,[1,3,6,9]],[24,12,[1,4,7,11,14,18,21,24]],[300,12,[1,43,86,129,172,215,258,300]]] as const){
 test(`N=${n} respects bounded time sampling`,()=>{const p=select(fixture(n));expect(p.budget).toBe(b);expect(ids(p)).toEqual(want);expect(p.samples.length).toBeLessThanOrEqual(p.budget);});
}
test('single budget prioritizes risk and mandatory endpoints consume two budget',()=>{expect(ids(select(fixture(2),risk([2])))).toEqual([2]);const p=select(fixture(4),risk([2,3]));expect(ids(p)).toEqual([1,4]);expect(p.uncovered_risks).toEqual(['f2','f3']);});
test('risk quota adds unique frames and final regular hits remove overflow',()=>{
 expect(ids(select(fixture(24),risk([2,3])))).toEqual([1,2,3,4,7,11,14,18,21,24]);
 const p=select(fixture(24),risk([2,3,5,6,8,9]));expect(ids(p)).toEqual([1,2,3,4,5,6,7,11,14,18,21,24]);expect(p.uncovered_risks).toEqual(['f8','f9']);
 expect(select(fixture(24),risk([2,3,4,5,6,7])).uncovered_risks).toEqual([]);
 expect(select(fixture(24),risk([1,24,2,3,4,5,6])).uncovered_risks).toEqual([]);
});
test('caller and frozen user limits lower the formula but cannot raise it',()=>{expect(ids(select(fixture(24),risk([2,3,4]),3))).toEqual([1,2,24]);expect(ids(select(fixture(24),risk([24]),1))).toEqual([24]);expect(select(fixture(24),[],99).budget).toBe(12);const m=fixture(24);m.brief.sampling_limit=2;expect(ids(select(m,[],99))).toEqual([1,24]);for(const l of [0,-1,1.5,NaN,Infinity])expect(()=>select(m,[],l)).toThrow();});
test('VFR duplicate targets use interval distance and shared boundaries choose earlier',()=>{expect(ids(select(fixture(8,[1,1,8,1,1,1,1,1])))).toEqual([1,3,4,8]);const m=fixture(6);m.frames.forEach(f=>f.duration={num:9007199254740991,den:9007199254740990});expect(ids(select(m))).toEqual([1,3,6]);});
test('canonical risk priority ties and duplicate reasons are input-order independent',()=>{const r=[...risk([6,2,4],100),...risk([2],0),...risk([2],202)];const a=select(fixture(8),r),b=select(fixture(8),[...r].reverse());expect(a).toEqual(b);expect(ids(a)).toEqual([1,2,4,8]);expect(a.uncovered_risks).toEqual(['f6']);expect(ids(select(fixture(6),[...risk([6],0),...risk([2],100),...risk([3],200)]))).toEqual([1,2,6]);});
test('illegal ranks foreign frames duplicate identity and nonpositive timing reject',()=>{for(const r of [risk([100]),risk([2],1),risk([2],NaN)])expect(()=>select(fixture(8),r)).toThrow();for(const mutate of [(m:any)=>m.frames=[],(m:any)=>m.frames[1].frame_id='f1',(m:any)=>m.frames[1].sequence_index=7,(m:any)=>m.frames[1].duration.den=0,(m:any)=>m.frames[1].duration.num=0]){const m=fixture(8);mutate(m);expect(()=>select(m)).toThrow();}});
