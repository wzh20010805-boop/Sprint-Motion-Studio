import type {CandidateFrame,DurationOrigin} from '@framebaker/shared';

type TimingFamily='source_pts'|'confirmed_fps'|'explicit_durations';
const families={next_pts:'source_pts',frame_duration:'source_pts',stream_end:'source_pts',estimated:'source_pts',confirmed_fps:'confirmed_fps',explicit_durations:'explicit_durations'} as const satisfies Record<DurationOrigin,TimingFamily>;
/** 只读冻结逐帧来源；源时长的不同推导方式不代表人工覆盖策略。 */
export function candidateTimingKey(frames:readonly Pick<CandidateFrame,'duration_origin'>[]):`review.timing.${TimingFamily|'mixed'|'unavailable'}` {
 const found=new Set<TimingFamily>();
 for(const frame of frames){
  if(!Object.hasOwn(families,frame.duration_origin))return 'review.timing.unavailable';
  found.add(families[frame.duration_origin]);
 }
 if(!found.size)return 'review.timing.unavailable';
 if(found.size>1)return 'review.timing.mixed';
 return `review.timing.${found.values().next().value!}`;
}
