import {expect,test} from 'bun:test';
import {candidateReviewApi,CandidateApiError} from '../apps/web/src/candidateReviewApi';
test('operation classification avoids rereading immutable review history while new and delivery state stay current',async()=>{
 const {CandidateOperationReader}=await import('../apps/web/src/candidateReviewApi');let state='running';const calls:string[]=[];
 const reader=new CandidateOperationReader(async id=>{calls.push(id);return {id,kind:id==='delivery'?'deliver_candidate':'review_frame',state} as any;});
 expect((await reader.read(['a','b','delivery']))[0]!.state).toBe('running');state='succeeded';
 expect((await reader.read(['a','b','c','delivery']))[0]!.state).toBe('succeeded');expect(calls).toEqual(['a','b','delivery','c','delivery']);
});
test('typed browser adapter follows every frame/issue page and preserves Cookie mode and structured conflicts',async()=>{
 const original=globalThis.fetch,requests:Array<{url:string;credentials:string|undefined}>=[];let bad=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const url=new URL(request.url),offset=Number(url.searchParams.get('cursor')??0);
  if(url.pathname.endsWith('/frames')){const end=Math.min(offset+127,301);return Response.json({ok:true,data:{items:Array.from({length:end-offset},(_,i)=>({frame_id:`f${i+offset}`})),total:301,next_cursor:end===301?null:String(end),complete:end===301,content_token:{revision:1,hash:'a'}}});}
  if(url.pathname.endsWith('/issues'))return Response.json({ok:true,data:{items:[{id:`issue-${offset}`}],total:2,next_cursor:offset?null:'1',complete:!!offset,content_token:{revision:1,hash:'a'},review_revision:bad&&offset?2:1}});
  return Response.json({ok:false,error:{code:'REVIEW_REVISION_CONFLICT',message:'stale'}},{status:409});
 }});
 globalThis.fetch=((input,init)=>{requests.push({url:String(input),credentials:init?.credentials});return original(new URL(String(input),server.url),init);}) as typeof fetch;
 try{
  const frames=await candidateReviewApi.frames('candidate');expect(frames.length).toBe(301);expect(frames.at(-1)!.frame_id).toBe('f300');
  expect((await candidateReviewApi.issues('candidate')).items.map(i=>i.id)).toEqual(['issue-0','issue-1']);
  bad=true;await expect(candidateReviewApi.issues('candidate')).rejects.toMatchObject({code:'PAGE_CONFLICT'});
  await expect(candidateReviewApi.frame({task_id:'task',candidate_id:'candidate',base_review_revision:1,request_key:'same-key'},{frame_id:'f0',verdict:'approved'})).rejects.toMatchObject({code:'REVIEW_REVISION_CONFLICT',status:409});
  expect(requests.every(r=>r.credentials==='same-origin')).toBe(true);expect(candidateReviewApi.file('candidate','frames/a b.png')).toContain('path=frames%2Fa%20b.png');
 }finally{globalThis.fetch=original;await server.stop(true);}
});
