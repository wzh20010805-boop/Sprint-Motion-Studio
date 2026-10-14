import {test,expect} from 'bun:test';
import {runCollaborationScript} from './collaborationFixtures';
import {candidateSetup} from './candidateFixture';
test('full impact feeds neighbor sampling risks while one saved plan and frozen bytes remain immutable',async()=>{
 const r=await runCollaborationScript(candidateSetup+String.raw`
 const sampling=await import('./apps/server/src/pipeline/collaboration/samplingStore');
 const {compareCandidates}=await import('./apps/server/src/pipeline/collaboration/impact');
 const {request}=await seedCandidate(8);const parent=await c.buildPrivateCandidate(request());const pm=c.readCandidateManifest(parent.id),before=readFileSync(parent.manifest_path);
 db.query('UPDATE frames SET offset_x=1 WHERE id=?').run(pm.frames[3].frame_id);
 const child=await c.buildPrivateCandidate({...request(),parent_candidate_id:parent.id});const report=await checkCandidate(child.id),m=c.readCandidateManifest(child.id),impact=compareCandidates(pm,m);
 assert.deepEqual(impact.recheck_frame_ids,[m.frames[2].frame_id,m.frames[3].frame_id,m.frames[4].frame_id]);
 const risks=sampling.candidateSamplingRisks(m,report);for(const id of impact.recheck_frame_ids)assert.ok(risks.some(r=>r.frame_id===id),'full impact missing '+id);
 const plan=sampling.getCandidateSamplingPlan(child.id,actor);assert.equal(plan.budget,1);assert.equal(plan.samples.length,1);assert.ok(plan.uncovered_risks.length>=2);
 assert.deepEqual(sampling.getCandidateSamplingPlan(child.id,actor,12),plan);await checkCandidate(child.id);assert.deepEqual(sampling.getCandidateSamplingPlan(child.id,actor,1),plan);
 assert.deepEqual(readFileSync(parent.manifest_path),before);assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);assert.equal(c.readCandidate(child.id).self_check_id,null);
 console.log(JSON.stringify({parent:parent.id,candidate:child.id,impact,plan,risks}));
 `,'t6');expect(r.exit_code,r.stderr+' '+r.workspace).toBe(0);
},120000);
