import {test,expect} from 'bun:test';
import {candidateSetup} from './candidateFixture';
import {runCollaborationScript} from './collaborationFixtures';
test('single frame preview resolves only that input and preserves its timeline index',async()=>{
 const result=await runCollaborationScript(candidateSetup+String.raw`
 const {imp}=await seedCandidate(2);const {composeInputs}=await import('./apps/server/src/pipeline/alignment');
 const all=composeInputs(context.project_id,context.axis_id);
 const selected=composeInputs(context.project_id,context.axis_id,imp.frame_ids[1]);
 assert.equal(selected.length,1);assert.equal(selected[0].index,1);assert.deepEqual(selected[0],all[1]);assert.equal(all.length,2);
 `,'preview-inputs');expect(result.exit_code,result.stderr).toBe(0);
},30000);
