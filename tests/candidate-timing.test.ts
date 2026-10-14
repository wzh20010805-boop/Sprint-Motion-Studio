import {expect,test} from 'bun:test';
import type {DurationOrigin} from '@framebaker/shared';
import {candidateTimingKey} from '../apps/web/src/candidateTiming';
import {t} from '../apps/web/src/i18n';

function labels(origins:readonly DurationOrigin[],zh:string,en:string){
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');
 try{
  for(const [lang,expected] of [['zh-CN',zh],['en',en]]){
   Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{lang}}});
   const label=t(candidateTimingKey(origins.map(duration_origin=>({duration_origin}))));
   expect(label).toBe(expected);expect(label).not.toContain('review.timing.');
  }
 }finally{if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');}
}
test('all frozen source provenance families and the real-video 120+1 shape retain source timing labels',()=>{
 for(const origin of ['next_pts','frame_duration','stream_end','estimated'] as const)labels([origin,origin],'源有理数时序','Source rational timing');
 labels(['next_pts','frame_duration','stream_end','estimated'],'源有理数时序','Source rational timing');
 labels([...Array<DurationOrigin>(120).fill('next_pts'),'frame_duration'],'源有理数时序','Source rational timing');
});
test('uniform confirmed FPS and explicit durations preserve their translated distinctions',()=>{
 labels(['confirmed_fps','confirmed_fps'],'用户确认 FPS','User-confirmed FPS');
 labels(['explicit_durations','explicit_durations'],'明确逐帧时长','Explicit frame durations');
});
test('genuine mixed source and manual timing never claims an all-explicit policy',()=>{
 for(const origins of [['next_pts','explicit_durations'],['estimated','confirmed_fps'],['confirmed_fps','explicit_durations']] as const)labels(origins,'混合时长来源','Mixed timing origins');
});
test('empty or unsupported provenance is unavailable, including partly unknown sequences',()=>{
 labels([],'时长来源不可用','Timing origin unavailable');
 for(const origins of [['future'],['next_pts','future'],['source_pts']] as unknown as DurationOrigin[][])labels(origins,'时长来源不可用','Timing origin unavailable');
});
test('historical candidate label depends only on frozen frame facts while draft and initial brief differ',()=>{
 const historical={frames:Object.freeze([{duration_origin:'next_pts' as const},{duration_origin:'frame_duration' as const}])};
 const current={initialBrief:{timing:'explicit_durations'},draft:{timing:'confirmed_fps'}};
 expect(candidateTimingKey(historical.frames)).toBe('review.timing.source_pts');
 current.draft.timing='explicit_durations';current.initialBrief.timing='confirmed_fps';
 expect(candidateTimingKey(historical.frames)).toBe('review.timing.source_pts');
 labels(historical.frames.map(f=>f.duration_origin),'源有理数时序','Source rational timing');
});
