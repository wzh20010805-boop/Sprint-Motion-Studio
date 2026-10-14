import {expect,test} from 'bun:test';
import {reviewSetup} from './reviewFixture';
import {runCollaborationScript} from './collaborationFixtures';
test('core and real HTTP preserve fractional final edges while rejecting invalid regions and stale authority',async()=>{
 const x=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);const id=candidate.id,f=c.readCandidateManifest(id).frames[0];
 const patch={frame_ids:[f.frame_id],rect:[.25,.5,2.75,3.5],coordinate_system:'final_canvas_pixels',text:'fractional fixture',severity:'advisory'};
 r.applyIssue(rc(id),patch,human);assert.deepEqual(r.readReviewState(id).issues[0].rect,patch.rect);
 for(const rect of [[-1,0,1,1],[0,0,0,1],[0,0,1,0],[95.5,0,.6,1],[0,95.5,1,.6],[NaN,0,1,1],[0,0,Infinity,1]])assert.throws(()=>r.applyIssue(rc(id),{...patch,rect},human));
 const {Elysia}=await import('./apps/server/node_modules/elysia');const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');
 const api=new Elysia().onRequest(({request})=>{auth.authenticateLocalRequest(request,'localhost:3000');}).use(collaborationApi);
 const secret=auth.issueReviewerSession('synthetic-test-only'),ctx=rc(id);
 const call=(cookie,context,rect)=>api.handle(new Request('http://localhost:3000/api/v1/collaboration/candidates/'+id+'/issues',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({context,patch:{...patch,rect}})}));
 assert.equal((await call('sfs_reviewer='+secret,ctx,[95.5,95.5,.5,.5])).status,200);
 assert.equal((await call('sfs_reviewer='+secret,{...ctx,request_key:uid()},patch.rect)).status,409);
 assert.equal((await call('sfs_token=test-maker',rc(id),patch.rect)).status,403);
 assert.equal(r.readReviewState(id).frame_reviews.every(x=>!x.valid),true);assert.equal(r.readReviewState(id).playback_confirmed,false);db.close();
 `,'t11');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},120000);
