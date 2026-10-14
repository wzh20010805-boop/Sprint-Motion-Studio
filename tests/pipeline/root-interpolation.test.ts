import {test,expect} from 'bun:test';
import {rootAt,type AlignmentConfig} from '../../packages/shared/src/pipeline/alignment';

test('GUI root fields interpolate and clamp the same ground trajectory as compositor',()=>{
 const c:AlignmentConfig={canvas:{width:64,height:64},anchor:[32,58],scale:1,resampling:'pixel',mode:'ground_keyframes',roots:[{index:2,x:14,y:22},{index:0,x:10,y:18}],offsets:{}};
 expect(rootAt(c,1)).toEqual({x:12,y:20});
 expect(rootAt(c,-1).x).toBe(10);expect(rootAt(c,9).x).toBe(14);
 expect(rootAt({...c,mode:'fixed'},1).x).toBe(10);
});

test('VFR timing does not replace index interpolation and loop does not wrap roots',()=>{
 const c:AlignmentConfig={canvas:{width:64,height:64},anchor:[32,58],scale:1,resampling:'pixel',mode:'ground_keyframes',roots:[{index:2,x:10,y:20},{index:4,x:20,y:40}],offsets:{'3':[7,9]}};
 const durations=[1,100,1,1000,1,1];
 expect(durations.map((_,index)=>{const p=rootAt(c,index);return [p.x,p.y];})).toEqual([[10,20],[10,20],[10,20],[15,30],[20,40],[20,40]]);
 expect(rootAt({...c,mode:'fixed'},999).x).toBe(10);
 expect(c.offsets['3']).toEqual([7,9]);
});
