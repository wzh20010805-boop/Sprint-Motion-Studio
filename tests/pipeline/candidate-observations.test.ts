import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {candidateSetup} from './candidateFixture';
const setup=candidateSetup+String.raw`
const sampling=await import('./apps/server/src/pipeline/collaboration/samplingStore').catch(()=>({}));
assert.equal(typeof sampling.getCandidateSamplingPlan,'function','actual sampling service required');
const makeObs=(candidate,plan,viewed=true)=>plan.samples.map(s=>({candidate_id:candidate.id,content_hash:candidate.content_hash,plan_hash:plan.plan_hash,frame_id:s.frame_id,frame_content_hash:s.frame_content_hash,viewed,result:viewed?'ok':'uncertain',explanation:viewed?'Synthetic test fixture observation; no real artistic approval':'Synthetic fixture image access unavailable',evidence_source:'fixture-final-png',evidence_candidate_id:candidate.id}));
const seedSampling=async(n,limit)=>{const seed=await seedCandidate(n);const task=d.createCollaborationTask({...seed.brief,sampling_limit:limit},{request_key:uid()},actor);return {...seed,task,request:()=>({...seed.request(),task_id:task.id})};};
`;
test('real frozen check plan observations submit without render or approvals; replay immutable',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedCandidate(4);const candidate=await c.buildPrivateCandidate(request()),m=c.readCandidateManifest(candidate.id),before=readFileSync(candidate.manifest_path),hashes=m.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png)));
 assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/TECHNICAL_CHECK_FAILED/);
 await checkCandidate(candidate.id);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/SELF_CHECK_REQUIRED/);
 const plan=sampling.getCandidateSamplingPlan(candidate.id,actor),obs=makeObs(candidate,plan);
 assert.deepEqual(sampling.getCandidateSamplingPlan(candidate.id,actor,12),plan);
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,[],actor);assert.equal(sampling.readCandidateSelfCheck(candidate.id).completed,false);
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,obs,actor);const self=sampling.readCandidateSelfCheck(candidate.id);assert.equal(self.completed,true);assert.equal(self.technical_check.checked_frame_count,4);assert.equal(self.viewed_frame_ids.length,1);
 assert.equal(c.submitCandidate(candidate.id,candidate.content_hash,actor).visibility,'submitted');assert.deepEqual(readFileSync(candidate.manifest_path),before);assert.deepEqual(m.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png))),hashes);
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,obs,actor);assert.deepEqual(sampling.readCandidateSelfCheck(candidate.id),self);assert.equal(c.readCandidate(candidate.id).review_revision,0);assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);
 assert.throws(()=>sampling.recordSampleObservations(candidate.id,plan.plan_hash,[{...obs[0],explanation:'changed'}],actor),/OBSERVATION_CONFLICT/);
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);

test('submitted technical recheck refresh preserves complete facts and restores ancestor evidence reads',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedSampling(6,3);const parent=await c.buildPrivateCandidate(request());const m=c.readCandidateManifest(parent.id),manifestBytes=readFileSync(parent.manifest_path),pngHashes=m.frames.map(f=>fileHash(c.candidateFilePath(parent.id,f.files.png)));
 await checkCandidate(parent.id);const plan=sampling.getCandidateSamplingPlan(parent.id,actor),observations=makeObs(parent,plan);sampling.recordSampleObservations(parent.id,plan.plan_hash,observations,actor);const old=sampling.readCandidateSelfCheck(parent.id);c.submitCandidate(parent.id,parent.content_hash,actor);
 const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await checkCandidate(child.id);const cp=sampling.getCandidateSamplingPlan(child.id,actor),co=makeObs(child,cp).map(o=>({...o,evidence_candidate_id:parent.id}));sampling.recordSampleObservations(child.id,cp.plan_hash,co,actor);const childSelf=sampling.readCandidateSelfCheck(child.id);
 const taskBefore=db.query('SELECT * FROM collab_tasks WHERE id=?').get(parent.task_id);const appendixBefore=db.query('SELECT sampling_plan_json,self_check_json FROM candidates WHERE id=?').get(parent.id);
 const report=await checkCandidate(parent.id);assert.deepEqual(report.blocking_errors,[]);assert.notEqual(report.id,old.technical_check.id);assert.throws(()=>sampling.readCandidateSelfCheck(parent.id),/SELF_CHECK_REQUIRED/);assert.throws(()=>sampling.readCandidateSelfCheck(child.id),/SELF_CHECK_REQUIRED/);assert.throws(()=>c.submitCandidate(parent.id,parent.content_hash,actor),/SELF_CHECK_REQUIRED/);
 for(const altered of [{...observations[0],explanation:'changed'},{...observations[0],evidence_source:'different-source'},{...observations[0],result:'issue'},{...observations[0],viewed:false,result:'uncertain'},{...observations[0],evidence_candidate_id:child.id},{...observations[0],frame_id:m.frames[1].frame_id}])assert.throws(()=>sampling.recordSampleObservations(parent.id,plan.plan_hash,[altered],actor));
 assert.deepEqual(db.query('SELECT sampling_plan_json,self_check_json FROM candidates WHERE id=?').get(parent.id),appendixBefore);
 sampling.recordSampleObservations(parent.id,plan.plan_hash,observations,actor);const fresh=sampling.readCandidateSelfCheck(parent.id);assert.equal(fresh.id,old.id);assert.deepEqual(fresh.observations,old.observations);assert.deepEqual({...fresh,technical_check:old.technical_check,blocking_errors:old.blocking_errors},old);assert.deepEqual(fresh.technical_check,report);
 assert.deepEqual(sampling.getCandidateSamplingPlan(parent.id,actor,12),plan);assert.deepEqual(sampling.readCandidateSelfCheck(child.id),childSelf);assert.deepEqual(childSelf.observations.map(o=>o.evidence_candidate_id),Array(3).fill(parent.id));assert.equal(c.submitCandidate(parent.id,parent.content_hash,actor).visibility,'submitted');sampling.recordSampleObservations(parent.id,plan.plan_hash,[],actor);assert.deepEqual(sampling.readCandidateSelfCheck(parent.id),fresh);
 assert.deepEqual(readFileSync(parent.manifest_path),manifestBytes);assert.deepEqual(m.frames.map(f=>fileHash(c.candidateFilePath(parent.id,f.files.png))),pngHashes);assert.equal(c.readCandidate(parent.id).review_revision,0);assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);assert.deepEqual(db.query('SELECT * FROM collab_tasks WHERE id=?').get(parent.task_id),taskBefore);
 console.log(JSON.stringify({candidate_id:parent.id,old_check:old.technical_check.id,new_check:report.id,selfcheck_id:fresh.id,unchanged_observations:true,child_evidence_restored:true}));
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);

test('submitted refresh honestly stores actual blocking recheck then real passing recheck recovers',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedCandidate(4);const candidate=await c.buildPrivateCandidate(request()),m=c.readCandidateManifest(candidate.id),manifestBytes=readFileSync(candidate.manifest_path),pngPath=c.candidateFilePath(candidate.id,m.frames[0].files.png),original=readFileSync(pngPath),hashes=m.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png)));
 await checkCandidate(candidate.id);const plan=sampling.getCandidateSamplingPlan(candidate.id,actor),observations=makeObs(candidate,plan);sampling.recordSampleObservations(candidate.id,plan.plan_hash,observations,actor);const old=sampling.readCandidateSelfCheck(candidate.id);c.submitCandidate(candidate.id,candidate.content_hash,actor);
 const corrupt=Buffer.from('owned synthetic fixture corrupt PNG');writeFileSync(join(STORAGE_ROOT,'recheck-original.png'),original);writeFileSync(join(STORAGE_ROOT,'recheck-corrupted.png'),corrupt);writeFileSync(pngPath,corrupt);
 const blocked=await checkCandidate(candidate.id);assert.equal(blocked.checked_frame_count,4);assert.ok(blocked.blocking_errors.some(e=>e.frame_id===m.frames[0].frame_id));writeFileSync(join(STORAGE_ROOT,'recheck-blocked-report.json'),JSON.stringify(blocked,null,2));
 writeFileSync(pngPath,original);assert.deepEqual(m.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png))),hashes);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/TECHNICAL_CHECK_FAILED/);
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,observations,actor);const refreshed=sampling.readCandidateSelfCheck(candidate.id);assert.equal(refreshed.id,old.id);assert.deepEqual(refreshed.observations,old.observations);assert.deepEqual(refreshed.technical_check,blocked);assert.deepEqual(refreshed.blocking_errors,blocked.blocking_errors);assert.equal(refreshed.completed,true);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/TECHNICAL_CHECK_FAILED/);
 const passing=await checkCandidate(candidate.id);assert.deepEqual(passing.blocking_errors,[]);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/SELF_CHECK_REQUIRED/);sampling.recordSampleObservations(candidate.id,plan.plan_hash,observations,actor);const final=sampling.readCandidateSelfCheck(candidate.id);assert.equal(final.id,old.id);assert.deepEqual(final.observations,old.observations);assert.deepEqual(final.technical_check,passing);assert.deepEqual(final.blocking_errors,[]);assert.equal(c.submitCandidate(candidate.id,candidate.content_hash,actor).visibility,'submitted');
 assert.deepEqual(sampling.getCandidateSamplingPlan(candidate.id,actor,99),plan);assert.deepEqual(readFileSync(candidate.manifest_path),manifestBytes);assert.deepEqual(m.frames.map(f=>fileHash(c.candidateFilePath(candidate.id,f.files.png))),hashes);assert.equal(c.readCandidate(candidate.id).review_revision,0);assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);
 console.log(JSON.stringify({candidate_id:candidate.id,blocked_check:blocked.id,blocked_errors:blocked.blocking_errors,passing_check:passing.id,selfcheck_id:final.id,unchanged_observations:true}));
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
test('partial facts stay incomplete, saved risk scope cannot expand and honest issues submit',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedSampling(8,4);const candidate=await c.buildPrivateCandidate(request());await checkCandidate(candidate.id);const plan=sampling.getCandidateSamplingPlan(candidate.id,actor),obs=makeObs(candidate,plan);
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,[obs[0]],actor);assert.equal(sampling.readCandidateSelfCheck(candidate.id).completed,false);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/SELF_CHECK_REQUIRED/);
 const m=c.readCandidateManifest(candidate.id);const riskCheck={candidate_id:candidate.id,blocking_errors:[],warnings:[{frame_id:m.frames[2].frame_id,code:'TOUCHES_BORDER'}]};assert.equal(sampling.candidateSamplingRisks(m,riskCheck)[0].priority,201);
 await checkCandidate(candidate.id);assert.deepEqual(sampling.getCandidateSamplingPlan(candidate.id,actor,1),plan);
 // 同一冻结身份重新运行技术检查只刷新技术事实，不删除原观察或扩大视觉范围。
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,obs.slice(1).map(o=>({...o,result:'issue',explanation:'Synthetic advisory issue'})),actor);
 const self=sampling.readCandidateSelfCheck(candidate.id);assert.equal(self.completed,true);assert.equal(self.observations.length,4);assert.equal(self.issue_frame_ids.length,3);assert.equal(c.submitCandidate(candidate.id,candidate.content_hash,actor).visibility,'submitted');
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
test('HTTP sampling and observation adapters bind authenticated maker and preserve results',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedCandidate(4);const candidate=await c.buildPrivateCandidate(request());await checkCandidate(candidate.id);
 const {collaborationApi}=await import('./apps/server/src/pipeline/collaborationApi');const sessions=await import('./apps/server/src/localSessions');sessions.initializeLocalSessions('fixture-http','fixture-secret');
 const url='http://localhost/api/v1/collaboration/candidates/'+candidate.id;
 let response=await collaborationApi.handle(new Request(url+'/sampling'));assert.equal(response.status,401);
 const call=async(path,method='GET',body)=>{const req=new Request(url+path,{method,headers:{authorization:'Bearer fixture-secret','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});sessions.authenticateLocalRequest(req,'localhost');return collaborationApi.handle(req);};
 response=await call('/sampling');assert.equal(response.status,200);const plan=(await response.json()).data;assert.equal(plan.samples.length,1);
 response=await call('/observations','POST',{plan_hash:plan.plan_hash,observations:makeObs(candidate,plan)});assert.equal(response.status,200);response=await call('/selfcheck');assert.equal(response.status,200);assert.equal((await response.json()).data.completed,true);
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
test('whole batch rejects contradictions foreign duplicate stale unselected and tampered identities atomically',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedSampling(6,3);const candidate=await c.buildPrivateCandidate(request());await checkCandidate(candidate.id);const plan=sampling.getCandidateSamplingPlan(candidate.id,actor),obs=makeObs(candidate,plan);
 for(const bad of [{...obs[1],viewed:false},{...obs[1],result:'invented'},{...obs[1],explanation:' '},{...obs[1],evidence_source:' '},{...obs[1],frame_id:'foreign'},{...obs[1],candidate_id:'foreign'},{...obs[1],frame_content_hash:'b'.repeat(64)},{...obs[1],plan_hash:'b'.repeat(64)},{...obs[1],evidence_candidate_id:'foreign'},{...obs[1],frame_id:c.readCandidateManifest(candidate.id).frames[1].frame_id}])assert.throws(()=>sampling.recordSampleObservations(candidate.id,plan.plan_hash,[obs[0],bad],actor));
 assert.throws(()=>sampling.recordSampleObservations(candidate.id,plan.plan_hash,[obs[0],obs[0]],actor));assert.equal(sampling.readCandidateSelfCheck(candidate.id),null);
 assert.throws(()=>sampling.recordSampleObservations(candidate.id,'b'.repeat(64),obs,actor));
 sampling.recordSampleObservations(candidate.id,plan.plan_hash,makeObs(candidate,plan,false),actor);const self=sampling.readCandidateSelfCheck(candidate.id);assert.equal(self.completed,true);assert.equal(self.unviewed_frame_ids.length,3);assert.equal(self.viewed_frame_ids.length,0);
 const original=db.query('SELECT self_check_json FROM candidates WHERE id=?').get(candidate.id).self_check_json;
 db.query('UPDATE candidates SET self_check_json=? WHERE id=?').run(JSON.stringify({...self,viewed_frame_ids:[obs[0].frame_id]}),candidate.id);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/SELF_CHECK_REQUIRED/);db.query('UPDATE candidates SET self_check_json=? WHERE id=?').run(original,candidate.id);
 const check=db.query('SELECT technical_check_json FROM candidates WHERE id=?').get(candidate.id).technical_check_json;db.query('UPDATE candidates SET technical_check_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(check),content_hash:'b'.repeat(64)}),candidate.id);assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/TECHNICAL_CHECK_FAILED/);db.query('UPDATE candidates SET technical_check_json=? WHERE id=?').run(check,candidate.id);
 writeFileSync(c.candidateFilePath(candidate.id,c.readCandidateManifest(candidate.id).frames[0].files.png),'tampered');assert.throws(()=>c.submitCandidate(candidate.id,candidate.content_hash,actor),/CANDIDATE_FILE_CHANGED/);
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
test('reuse requires authentic viewed ancestor evidence and matching immutable frame content',async()=>{
 const r=await runCollaborationScript(setup+String.raw`
 const {request}=await seedCandidate(4);const parent=await c.buildPrivateCandidate(request());await checkCandidate(parent.id);const pp=sampling.getCandidateSamplingPlan(parent.id,actor),po=makeObs(parent,pp);sampling.recordSampleObservations(parent.id,pp.plan_hash,po,actor);
 const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await checkCandidate(child.id);const cp=sampling.getCandidateSamplingPlan(child.id,actor),co=makeObs(child,cp).map(o=>({...o,evidence_candidate_id:parent.id}));sampling.recordSampleObservations(child.id,cp.plan_hash,co,actor);assert.equal(sampling.readCandidateSelfCheck(child.id).reused_frame_ids.length,1);
 const forged=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await checkCandidate(forged.id);const fp=sampling.getCandidateSamplingPlan(forged.id,actor);assert.throws(()=>sampling.recordSampleObservations(forged.id,fp.plan_hash,makeObs(forged,fp).map(o=>({...o,evidence_candidate_id:parent.id,evidence_source:'fabricated-source'})),actor),/EVIDENCE_REUSE_INVALID/);
 const unviewed=await c.buildPrivateCandidate(request());await checkCandidate(unviewed.id);const up=sampling.getCandidateSamplingPlan(unviewed.id,actor);sampling.recordSampleObservations(unviewed.id,up.plan_hash,makeObs(unviewed,up,false),actor);const uc=await c.buildPrivateCandidate({...request(),parent_candidate_id:unviewed.id});await checkCandidate(uc.id);const ucp=sampling.getCandidateSamplingPlan(uc.id,actor);assert.throws(()=>sampling.recordSampleObservations(uc.id,ucp.plan_hash,makeObs(uc,ucp).map(o=>({...o,evidence_candidate_id:unviewed.id})),actor),/EVIDENCE_REUSE_INVALID/);
 const sibling=await c.buildPrivateCandidate(request());await checkCandidate(sibling.id);const sp=sampling.getCandidateSamplingPlan(sibling.id,actor);assert.throws(()=>sampling.recordSampleObservations(sibling.id,sp.plan_hash,makeObs(sibling,sp).map(o=>({...o,evidence_candidate_id:parent.id})),actor),/EVIDENCE_REUSE_INVALID/);
 const f=d.readDraftContent(context).frames[0];db.query('UPDATE frames SET offset_x=1 WHERE id=?').run(f.frame_id);const changed=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});await checkCandidate(changed.id);const xp=sampling.getCandidateSamplingPlan(changed.id,actor);assert.throws(()=>sampling.recordSampleObservations(changed.id,xp.plan_hash,makeObs(changed,xp).map(o=>({...o,evidence_candidate_id:parent.id})),actor),/EVIDENCE_REUSE_INVALID/);
 assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);
 `,'t5');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
