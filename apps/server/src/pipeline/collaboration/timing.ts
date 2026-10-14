import type { DurationOrigin, Rational, TaskBrief, WorkContext } from '@framebaker/shared';
import { db } from '../../db';

export interface DraftState {
  source_id: string; expected_source_frame_ids: string[];
  timing: TaskBrief['timing']; durations: Record<string, { duration: Rational; duration_origin: DurationOrigin }>;
  preview_fps?: Rational;
}
export const draftKey = (context: WorkContext) => `sfs.draft.${context.project_id}.${context.axis_id}`;
export function draftState(context: WorkContext): DraftState | null {
  const row = db.query('SELECT value FROM settings WHERE key=?').get(draftKey(context)) as {value:string}|null;
  return row ? JSON.parse(row.value) : null;
}
export function saveDraftState(context: WorkContext, state: DraftState): void {
  db.query('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(draftKey(context), JSON.stringify(state), Date.now());
  db.query('UPDATE projects SET content_revision=content_revision+1 WHERE id=?').run(context.project_id);
}
export function rational(num: number, den: number): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) throw new Error('时长必须是正安全整数有理数');
  let a=num,b=den; while(b){const r=a%b;a=b;b=r;} return {num:num/a,den:den/a};
}
/** 数值FPS按其十进制表示明确转为有理数，不四舍五入成整数。 */
export function numericFps(value:number):Rational {
  if(!Number.isFinite(value)||value<=0)throw new Error('FPS无效');
  const [mantissa,exponent='0']=value.toString().split('e');
  const [whole,fraction='']=mantissa!.split('.');const power=Number(exponent)-fraction.length;
  return rational(Number(whole!+fraction)*10**Math.max(0,power),10**Math.max(0,-power));
}
/** 手工改动先物化全部时长；时长始终跟随帧身份而不是数组位置。 */
export function materializeStepDuration(stepId: string, ticks: number): void {
  const axis=db.query('SELECT a.* FROM animation_axes a JOIN animation_steps s ON s.axis_id=a.id WHERE s.id=?').get(stepId) as {id:string;project_id:string;fps:number}|null;
  if(!axis)return;
  const context={project_id:axis.project_id,axis_id:axis.id}, state=draftState(context);
  if(!state)return;
  const frames=db.query('SELECT f.id FROM frames f JOIN animation_tracks t ON t.id=f.track_id WHERE f.step_id=? AND t.is_primary=1').all(stepId) as {id:string}[];
  const rate=state.preview_fps&&state.preview_fps.num/state.preview_fps.den===axis.fps?state.preview_fps:numericFps(axis.fps);
  for(const f of frames)state.durations[f.id]={duration:rational(ticks*rate.den,rate.num),duration_origin:'explicit_durations'};
  const ordered=db.query('SELECT f.id FROM frames f JOIN animation_tracks t ON t.id=f.track_id JOIN animation_steps s ON s.id=f.step_id WHERE t.axis_id=? AND t.is_primary=1 ORDER BY s.idx,s.id').all(axis.id) as {id:string}[];
  state.timing={value:{mode:'explicit_durations',durations:ordered.map(f=>state.durations[f.id]!.duration)},origin:'user'};
  saveDraftState(context,state);
}
export function retimeAxisFps(axisId:string,fps:number): void {
  const axis=db.query('SELECT * FROM animation_axes WHERE id=?').get(axisId) as {project_id:string}|null;
  if(!axis)return;
  const context={project_id:axis.project_id,axis_id:axisId},state=draftState(context);
  if(!state)return;
  const rate=numericFps(fps);state.preview_fps=rate;
  if(state.timing.value.mode==='confirmed_fps'){
  state.timing={value:{mode:'confirmed_fps',fps:rate},origin:'user'};
  for(const id of Object.keys(state.durations))state.durations[id]={duration:rational(rate.den,rate.num),duration_origin:'confirmed_fps'};
  }
  saveDraftState(context,state);
}
