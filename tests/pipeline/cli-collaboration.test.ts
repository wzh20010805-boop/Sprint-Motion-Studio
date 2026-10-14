import {test,expect} from 'bun:test';
import {compactResult} from '../../apps/cli/src/production';
import {waitJob} from '../../apps/cli/src/client';
import {waitOperation,runCollaboration} from '../../apps/cli/src/collaboration';
test('full typed page survives CLI formatting with 300 complete nested frame ids',()=>{
 const page={items:Array.from({length:300},(_,i)=>({frame_id:'f'+i,frame_ids:Array.from({length:50},(_,j)=>'s'+j)})),total:300,complete:true,next_cursor:null,content_token:{revision:1,hash:'a'.repeat(64)}};
 expect(compactResult({data:page}).data.items).toEqual(page.items);
});
test('operation query and wait distinguish historical failure, interrupted state and original-operation timeout',async()=>{
 let state='running';const server=Bun.serve({port:0,fetch:()=>Response.json({status:state,data:{id:'original-op',kind:'build_candidate',state,attempt_job_ids:['original-job'],request_key:'original-key',base_content:{revision:7,hash:'a'.repeat(64)}}})});const service={url:server.url.origin,token:'test'} as any;
 try{await expect(waitOperation(service,'original-op',.01)).rejects.toMatchObject({code:'WAIT_TIMEOUT',result:{operation_id:'original-op',job_id:'original-job',timed_out:true,cancelled_job:false}});state='failed';expect((await runCollaboration('operation inspect',{operation:'original-op'},service,1)).exitCode).toBe(0);expect((await waitOperation(service,'original-op',1)).exitCode).toBe(1);state='interrupted';expect((await waitOperation(service,'original-op',1)).exitCode).toBe(1);}finally{server.stop(true);}
});
test('wait timeout preserves original job and operation and never implies cancellation',async()=>{
 const server=Bun.serve({port:0,fetch:()=>Response.json({status:'running',data:{job:{id:'job-one',operation_id:'op-one',status:'running'}}})});
 try{await waitJob({url:server.url.origin,token:'test'} as any,'job-one',0.02);throw Error('timeout required');}catch(e:any){expect(e.code).toBe('WAIT_TIMEOUT');expect(e.result?.timed_out).toBe(true);expect(e.result?.cancelled_job).toBe(false);expect(e.result?.job_id).toBe('job-one');expect(e.result?.operation_id).toBe('op-one');}finally{server.stop(true);}
});
