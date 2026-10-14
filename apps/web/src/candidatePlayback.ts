import type {CandidateManifest,Rational} from '@framebaker/shared';
type Fraction={n:bigint;d:bigint};
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
const reduce=(n:bigint,d:bigint):Fraction=>{const g=gcd(n,d);return {n:n/g,d:d/g};};
function fraction(v:Rational,positive=false):Fraction{
 if(!Number.isSafeInteger(v.num)||!Number.isSafeInteger(v.den)||v.den<=0||v.num<0||(positive&&v.num===0))throw Error('INVALID_CANDIDATE_TIME');
 return {n:BigInt(v.num),d:BigInt(v.den)};
}
const add=(a:Fraction,b:Fraction)=>reduce(a.n*b.d+b.n*a.d,a.d*b.d);
/** 播放区间为半开区间；不同于自检采样的较早帧边界规则。 */
export function candidateAtElapsed(manifest:CandidateManifest,elapsed:Rational):{frame_id:string;finished:boolean}{
 if(!manifest.frames.length)throw Error('EMPTY_CANDIDATE');
 const durations=manifest.frames.map(f=>fraction(f.duration,true));let time=fraction(elapsed);
 const total=durations.reduce(add,{n:0n,d:1n});
 if(manifest.output.loop)time=reduce((time.n*total.d)%(total.n*time.d),time.d*total.d);
 else if(time.n*total.d>=total.n*time.d)return {frame_id:manifest.frames.at(-1)!.frame_id,finished:true};
 let end:Fraction={n:0n,d:1n};for(let i=0;i<durations.length;i++){end=add(end,durations[i]!);if(time.n*end.d<end.n*time.d)return {frame_id:manifest.frames[i]!.frame_id,finished:false};}
 throw Error('INVALID_CANDIDATE_TIME');
}
/** performance.now 的累计毫秒量化为微秒；始终从同一开始时刻计算，不累加定时器间隔。 */
export function browserElapsed(milliseconds:number):Rational{
 const num=Math.floor(milliseconds*1000);if(!Number.isSafeInteger(num)||num<0)throw Error('INVALID_ELAPSED');return {num,den:1000000};
}
