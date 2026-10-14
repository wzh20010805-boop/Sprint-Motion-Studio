import {candidateSetup} from './candidateFixture';
/** 仅隔离测试的合成素材和审核会话，不是真实人工验收证据。 */
export const reviewSetup=candidateSetup+String.raw`
const r=await import('./apps/server/src/pipeline/collaboration/reviews');
const auth=await import('./apps/server/src/localSessions');
const sampling=await import('./apps/server/src/pipeline/collaboration/samplingStore');
const ops=await import('./apps/server/src/pipeline/collaboration/operations');
const {readTaskRecord}=await import('./apps/server/src/pipeline/collaboration/store');
auth.initializeLocalSessions('synthetic-test-only','test-maker');
function reviewer(){const secret=auth.issueReviewerSession('synthetic-test-only');return auth.authenticateLocalRequest(new Request('http://localhost:3000/test',{headers:{cookie:'sfs_reviewer='+secret}}),'localhost:3000');}
let human=reviewer();
const rc=id=>({task_id:c.readCandidate(id).task_id,candidate_id:id,base_review_revision:c.readCandidate(id).review_revision,request_key:uid()});
async function submit(candidate){await checkCandidate(candidate.id);const p=sampling.getCandidateSamplingPlan(candidate.id,actor);sampling.recordSampleObservations(candidate.id,p.plan_hash,p.samples.map(s=>({candidate_id:candidate.id,content_hash:p.content_hash,plan_hash:p.plan_hash,frame_id:s.frame_id,frame_content_hash:s.frame_content_hash,viewed:false,result:'uncertain',explanation:'synthetic fixture; no visual inspection',evidence_source:'test-only'})),actor);return c.submitCandidate(candidate.id,candidate.content_hash,actor);}
function frames(id,except=[]){for(const f of c.readCandidateManifest(id).frames)if(!except.includes(f.frame_id))r.applyFrameReview(rc(id),{frame_id:f.frame_id,verdict:'approved'},human);}
function playback(id,confirmed=true){return r.applyPlaybackReview(rc(id),{playback_hash:c.readCandidateManifest(id).playback_hash,confirmed},human);}
function selection(id){const task=readTaskRecord(c.readCandidate(id).task_id);return r.selectCandidate({task_id:task.id,candidate_id:id,expected_selected_candidate_id:task.selected_candidate_id,expected_acceptance_epoch:task.acceptance_epoch,request_key:uid()},human);}
`;
