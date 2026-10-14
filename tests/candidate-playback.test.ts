import {expect,test} from 'bun:test';
import type {CandidateManifest} from '@framebaker/shared';
const manifest=(durations:Array<[number,number]>,loop=false)=>({output:{loop},frames:durations.map(([num,den],i)=>({frame_id:`f${i}`,duration:{num,den}}))}) as CandidateManifest;
test('candidate playback has exact half-open VFR boundaries and terminal semantics',async()=>{
 const {candidateAtElapsed:at}=await import('../apps/web/src/candidatePlayback');
 const m=manifest([[1,3],[1,6],[3,2]]);
 expect(at(m,{num:0,den:1})).toEqual({frame_id:'f0',finished:false});
 expect(at(m,{num:1,den:3}).frame_id).toBe('f1');
 expect(at(m,{num:1,den:2}).frame_id).toBe('f2');
 expect(at(m,{num:2,den:1})).toEqual({frame_id:'f2',finished:true});
 expect(at({...m,output:{...m.output,loop:true}},{num:2,den:1})).toEqual({frame_id:'f0',finished:false});
 expect(at(manifest([[9007199254740990,9007199254740991],[1,9007199254740991]]),{num:9007199254740990,den:9007199254740991}).frame_id).toBe('f1');
 for(const bad of [{num:-1,den:1},{num:1,den:0},{num:0.1,den:1},{num:Infinity,den:1}])expect(()=>at(m,bad)).toThrow();
 expect(()=>at(manifest([]),{num:0,den:1})).toThrow();
 expect(()=>at(manifest([[0,1]]),{num:0,den:1})).toThrow();
});
