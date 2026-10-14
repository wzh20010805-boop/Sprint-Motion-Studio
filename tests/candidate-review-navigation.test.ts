import {expect,test} from 'bun:test';
test('uncertain pixel intent cannot be retried after navigation or candidate switch',async()=>{
 const {sameReviewTarget}=await import('../apps/web/src/candidateReviewState');
 const captured={key:'candidate:f0:final',candidateId:'candidate',ready:true};
 expect(sameReviewTarget(captured,captured,true)).toBe(true);
 expect(sameReviewTarget(captured,{...captured,key:'candidate:f1:final'},true)).toBe(false);
 expect(sameReviewTarget(captured,{...captured,ready:false},true)).toBe(false);
 expect(sameReviewTarget(captured,{...captured,candidateId:'other'},false)).toBe(false);
});
test('uncertain review mutation keeps prepared CAS payload across retries instead of refetching its base',async()=>{
 const {preparedReviewMutation}=await import('../apps/web/src/candidateReviewState');let preparations=0,calls=0;const sent:unknown[]=[];
 const run=preparedReviewMutation(async()=>({revision:++preparations,request_key:'original'}),async request=>{sent.push(request);if(++calls===1)throw Error('response lost');return 'ok';});
 await expect(run()).rejects.toThrow('response lost');expect(await run()).toBe('ok');expect(preparations).toBe(1);expect(sent[0]).toBe(sent[1]);
});
test('display gate ignores stale successes/errors and closes only its owned decoded resources',async()=>{
 const {ReviewImageGate}=await import('../apps/web/src/candidateReviewState');
 const gate=new ReviewImageGate<{name:string}>();const disposed:string[]=[];
 const a=gate.begin('a'),b=gate.begin('b');
 expect(gate.succeed(a,{name:'a'},x=>disposed.push(x.name))).toBe(false);
 expect(gate.succeed(b,{name:'b'},x=>disposed.push(x.name))).toBe(true);
 const c=gate.begin('c');gate.fail(a,'old error');expect(gate.state.error).toBeNull();
 expect(gate.state.displayed?.key).toBe('b');expect(gate.ready('c')).toBe(false);
 gate.fail(c,'decode failed');expect(gate.ready('c')).toBe(false);expect(gate.state.displayed?.key).toBe('b');
 gate.dispose();expect(disposed).toEqual(['a','b']);expect(gate.succeed(c,{name:'late'},x=>disposed.push(x.name))).toBe(false);expect(disposed).toEqual(['a','b','late']);
});
test('fractional pixel edges invert CSS letterbox/pan/zoom/DPR and map all four frozen corners',async()=>{
 const {viewportPoint,sourceQuadrilateral,validRegion}=await import('../apps/web/src/candidateReviewGeometry');
 // DOM canvas bounds already include border-origin, letterbox, pan and zoom.
 const rendered={left:109,top:268.25,width:384,height:384};
 expect(viewportPoint(109,268.25,rendered,96,96)).toEqual([0,0]);
 expect(viewportPoint(205,364.25,rendered,96,96)).toEqual([24,24]);
 expect(viewportPoint(493,652.25,rendered,96,96)).toEqual([96,96]);
 expect(viewportPoint(109,268,rendered,96,96)).toEqual([0,-.0625]);
 expect(validRegion([0,-.0625,96,96],96,96)).toBe(false);
 const pannedZoomed={left:218,top:339.75,width:192,height:192};
 expect(viewportPoint(279,400.25,pannedZoomed,96,96)).toEqual([30.5,30.25]);
 // Browser layout can quantize CSS width and height independently; both edges remain exact.
 expect(viewportPoint(217.25,117.5,{left:10,top:20,width:207.25,height:97.5},101,47)).toEqual([101,47]);
 expect(validRegion([.25,.5,2.75,3.5],4,4)).toBe(true);
 expect(validRegion([0,0,4.01,4],4,4)).toBe(false);
 const frame={source_size:{width:20,height:20},source_to_canvas:{matrix:[0,1,-1,0,10,0],inverse_matrix:[0,-1,1,0,0,10],noninvertible_reason:null}} as any;
 expect(sourceQuadrilateral(frame,[2,3,4,2])).toEqual({quad:[[3,8],[3,4],[5,4],[5,8]],reason:null});
 expect(sourceQuadrilateral({...frame,source_to_canvas:{...frame.source_to_canvas,inverse_matrix:[1,0,0,1,0,0]}},[2,3,4,2]).reason).toBe('MAPPING_MISMATCH');
 expect(sourceQuadrilateral(frame,[12,3,4,2]).reason).toBe('SOURCE_CLIPPED');
 expect(sourceQuadrilateral({...frame,source_to_canvas:{matrix:null,inverse_matrix:null,noninvertible_reason:'ZERO_DETERMINANT'}},[2,3,4,2]).reason).toBe('ZERO_DETERMINANT');
 const flipped={...frame,source_to_canvas:{matrix:[-1,0,0,1,20,0],inverse_matrix:[-1,0,0,1,20,0],noninvertible_reason:null}};
 expect(sourceQuadrilateral(flipped,[2.5,3.5,4.25,2.25]).quad).toEqual([[17.5,3.5],[13.25,3.5],[13.25,5.75],[17.5,5.75]]);
 expect(sourceQuadrilateral({...frame,source_size:{width:0,height:20}},[2,3,4,2]).reason).toBe('MAPPING_MISMATCH');
 for(const invalid of [[NaN,0,1,1],[-.1,0,1,1],[0,0,0,1],[0,0,1,Infinity]])expect(validRegion(invalid as any,4,4)).toBe(false);
});
