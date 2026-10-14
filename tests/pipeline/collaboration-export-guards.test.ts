import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {reviewSetup} from './reviewFixture';
test('old formal core and recipe reject sticky collaboration before rendering or side effects',async()=>{
 const x=await runCollaborationScript(reviewSetup+String.raw`
 const {request}=await seedCandidate(2),candidate=await c.buildPrivateCandidate(request());await submit(candidate);frames(candidate.id);playback(candidate.id);
 const ex=await import('./apps/server/src/pipeline/export'),q=await import('./apps/server/src/queue'),recipe=await import('./apps/server/src/pipeline/recipe');
 for(const fn of [()=>ex.prepareExport(context),()=>q.createExportJob(context),()=>recipe.submitRecipe(context.project_id,context.axis_id,{schema_version:'1.0',alignment:config,output:{draft:false}})])assert.throws(fn,e=>e.code==='IMMUTABLE_DELIVERY_REQUIRED');
 await assert.rejects(ex.exportAssets({request:context,revision:getProject(project.id).revision,fingerprint:'old'}),e=>e.code==='IMMUTABLE_DELIVERY_REQUIRED');
 assert.throws(()=>q.createJob(project.id,'export_assets',{productionExport:{request:context,revision:0,fingerprint:'old'}}),e=>e.code==='IMMUTABLE_DELIVERY_REQUIRED');
 const {Elysia}=await import('./apps/server/node_modules/elysia'),{productionApi}=await import('./apps/server/src/pipeline/productionApi'),app=new Elysia().use(productionApi);const http=await app.handle(new Request('http://localhost/api/v1/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(context)}));assert.equal(http.status,409);assert.equal((await http.json()).error.code,'IMMUTABLE_DELIVERY_REQUIRED');
 const {sfsMcpHandler}=await import('./apps/server/src/mcp/sfs');const mcp=await sfsMcpHandler.fetch(new Request('http://localhost/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'export_assets',arguments:context}})}));assert.equal(mcp.status,401);assert.ok((await mcp.text()).includes('UNAUTHORIZED'));playback(candidate.id,false);const authenticated=new Request('http://localhost/mcp',{method:'POST',headers:{Authorization:'Bearer test-maker','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'export_assets',arguments:context}})});auth.authenticateLocalRequest(authenticated,'localhost');const response=await sfsMcpHandler.fetch(authenticated);const text=await response.text();assert.ok(text.includes('ACCEPTED_CANDIDATE_REQUIRED'),text);
 db.query("UPDATE collab_tasks SET state='cancelled' WHERE id=?").run(candidate.task_id);assert.throws(()=>ex.prepareExport(context),e=>e.code==='IMMUTABLE_DELIVERY_REQUIRED');
 const draft=await ex.exportAssets(ex.prepareExport({...context,draft:true}));assert.equal(draft.draft,true);assert.ok(draft.warnings.includes('DRAFT_NOT_APPROVED'));assert.equal(db.query("SELECT COUNT(*) n FROM collab_operations WHERE kind='deliver_candidate' AND state='succeeded'").get().n,0);
 `,'t8');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},120000);
test('browser helper resolves mode before live pixels for both formats and never falls back on errors',async()=>{
 const x=await runCollaborationScript(String.raw`
 import assert from 'node:assert/strict';const {exportAnimation}=await import('./apps/web/src/export');
 let reads=[],downloads=0;globalThis.document={createElement(kind){assert.equal(kind,'a','Canvas must not be created');return {click(){downloads++}}}};globalThis.createImageBitmap=()=>assert.fail('decode');
 const timeline={axis:{id:'a',project_id:'p'},steps:[{id:'s',idx:0}],tracks:[{id:'t',visible:true,idx:0}],frames:[{id:'f',track_id:'t'}],effects:[]};
 globalThis.fetch=async(url)=>{reads.push(String(url));if(String(url).includes('/export/resolve'))return Response.json({ok:true,data:{mode:'candidate',candidate_id:'c',delivery_id:'op',files:[{file:'assets.zip',url:'/fixed'}]}});assert.equal(url,'/fixed');return new Response('exact-fixed-bytes');};
 for(const format of ['sequence','spritesheet'])await exportAnimation(timeline,'test',format);assert.equal(downloads,2);assert.ok(reads[0].includes('/export/resolve'));assert.equal(reads.filter(x=>x==='/fixed').length,2);
 globalThis.fetch=async()=>Response.json({ok:false,error:{code:'EXPORT_AMBIGUOUS',message:'ambiguous'}},{status:409});await assert.rejects(exportAnimation(timeline,'test','sequence'),/ambiguous/);
 `,'t8');expect(x.exit_code,x.stderr+' '+x.workspace).toBe(0);
},30000);
