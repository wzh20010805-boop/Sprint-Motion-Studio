import {test,expect} from 'bun:test';
import {rootAt,type AlignmentConfig} from '../../packages/shared/src/pipeline/alignment';

test('GUI root fields interpolate and clamp the same ground trajectory as compositor',()=>{
 const c:AlignmentConfig={canvas:{width:64,height:64},anchor:[32,58],scale:1,resampling:'pixel',mode:'ground_keyframes',roots:[{index:2,x:14,y:22},{index:0,x:10,y:18}],offsets:{}};
 expect(rootAt(c,1)).toEqual({x:12,y:20});
 expect(rootAt(c,-1).x).toBe(10);expect(rootAt(c,9).x).toBe(14);
 expect(rootAt({...c,mode:'fixed'},1).x).toBe(10);
});
