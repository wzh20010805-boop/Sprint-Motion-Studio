import { test, expect } from 'bun:test';
import Ajv from 'ajv';
import * as shared from '../../packages/shared/src/pipeline';
import { taskBrief } from './collaborationFixtures';

const compile = (name: string) => {
  const schema = (shared as Record<string, unknown>)[name];
  expect(schema, `缺少共同 schema: ${name}`).toBeDefined();
  return new Ajv({ strict: true, allErrors: true }).compile(schema as object);
};

test('collaboration brief schema preserves origins and distinguishes PNG timing from PTS', () => {
  const validate = compile('taskBriefSchema');
  expect(validate(taskBrief)).toBe(true);
  expect(validate({ ...taskBrief, timing: { value: { mode: 'confirmed_fps', fps: { num: 24, den: 1 } }, origin: 'user' } })).toBe(true);
  expect(validate({ ...taskBrief, timing: { value: { mode: 'explicit_durations', durations: [{ num: 1, den: 24 }, { num: 1, den: 12 }] }, origin: 'user' } })).toBe(true);
  expect(validate({ ...taskBrief, timing: { value: { mode: 'confirmed_fps' }, origin: 'user' } })).toBe(false);
  expect(validate({ ...taskBrief, loop: { value: true, origin: 'ai' } })).toBe(false);
  expect(validate({ ...taskBrief, sampling_limit: 13 })).toBe(false);
  expect(validate({ ...taskBrief, ordered_source_frame_ids: ['sf0', 'sf0'] })).toBe(false);
  expect(validate({ ...taskBrief, human_approved: true })).toBe(false);
});

test('candidate content schemas bind pixels and reject mutable review fields', () => {
  const hash = 'a'.repeat(64);
  const frame = { frame_id: 'f0', source_frame_id: 'sf0', source_index: 0, sequence_index: 0,
    duration: { num: 1, den: 24 }, duration_origin: 'next_pts', raw_sha256: hash, mask_version_id: 'm0', mask_sha256: hash,
    png_sha256: hash, content_hash: hash, files: { raw: 'raw.png', mask: 'mask.png', rgba: 'rgba.png', png: 'final.png' },
    resolved_transform: { offset_x: 0, offset_y: 0, scale: 1, rotation: 0, opacity: 1 }, resolved_root: { x: 16, y: 30 },
    source_size:{width:32,height:32},rgba_sha256:hash,mask_provenance:{kind:'imported',reasons:[]},grid_cell:{sheet_index:0,rect:[0,0,32,32]},
    source_to_canvas: { matrix: [1, 0, 0, 1, 0, 0], inverse_matrix:[1,0,0,1,0,0], noninvertible_reason: null } };
  const candidate = { schema_version: '1.0', candidate_id: 'c0', parent_candidate_id: null, task_id: 't0', brief_version: 1,
    content_token: { revision: 0, hash }, content_hash: hash, playback_hash: hash, compositor_hash: hash,
    alignment: taskBrief.alignment.value, output: { ...taskBrief.output.value, loop: true }, frames: [frame],brief:taskBrief,coverage:[{step_id:'s',frame_id:'f0',source_frame_id:'sf0'}],compositor:{source_hash:hash,pillow_version:'fixture'},grid:{cell:[32,32],margin:0,gap:0,columns:1,rows:1},sheets:[{file:'sheets/a.png',sha256:hash,width:32,height:32}],auxiliary_files:[] };
  const validate = compile('candidateManifestSchema');
  expect(validate(candidate)).toBe(true);
  expect(validate({ ...candidate, frames: [{ ...frame, resolved_transform: { ...frame.resolved_transform, scale: -1 } }] })).toBe(true);
  expect(validate({ ...candidate, frames: [{ ...frame, source_to_canvas: { matrix: null, inverse_matrix:null, noninvertible_reason: '零比例不能逆变换' } }] })).toBe(true);
  expect(validate({ ...candidate, frames: [{ ...frame, source_to_canvas: { matrix: null, noninvertible_reason: null } }] })).toBe(false);
  expect(validate({ ...candidate, frames: [{ ...frame, duration: { num: 1, den: 0 } }] })).toBe(false);
  expect(validate({ ...candidate, frames: [{ ...frame, png_sha256: 'mtime' }] })).toBe(false);
  expect(validate({ ...candidate, accepted: true })).toBe(false);
});

test('drafts permit missing composite bytes and pagination retains complete identity', () => {
  const validate = compile('draftContentSchema');
  const hash = 'a'.repeat(64);
  expect(validate({ context: taskBrief.context, token: { revision: 0, hash }, expected_source_frame_ids: ['sf0'], alignment: taskBrief.alignment.value,
    frames: [{ frame_id: 'f0', source_frame_id: 'sf0', source_index: 0, sequence_index: 0, duration: { num: 1, den: 24 }, duration_origin: 'next_pts', source_size: { width: 32, height: 32 },
      raw_path: 'raw.png', raw_sha256: hash, mask_path: null, mask_sha256: null, rgba_path: null, rgba_sha256: null, mask_version_id: null,
      transform: { offset_x: 0, offset_y: 0, scale: 1, rotation: 0, opacity: 1 } }] })).toBe(true);
  const page = compile('collaborationPageSchema');
  expect(page({ items: Array.from({ length: 64 }, (_, i) => ({ frame_id: `f${i}` })), total: 64, next_cursor: null, complete: true, content_token: { revision: 0, hash } })).toBe(true);
  expect(page({ items: [], total: 0, next_cursor: null, complete: true })).toBe(false);
});

test('review, sampling and operations schemas expose their exact identity contracts', () => {
  const hash = 'a'.repeat(64);
  expect(compile('reviewContextSchema')({ task_id: 't', candidate_id: 'c', base_review_revision: 0, request_key: 'r' })).toBe(true);
  expect(compile('frameReviewPatchSchema')({ frame_id: 'f', verdict: 'approved' })).toBe(true);
  expect(compile('issuePatchSchema')({ frame_ids: ['f'], rect: [1, 2, 3, 4], coordinate_system: 'source_pixels', text: 'edge', severity: 'blocking' })).toBe(false);
  expect(compile('playbackReviewPatchSchema')({ playback_hash: hash, confirmed: true })).toBe(true);
  expect(compile('samplingPlanSchema')({ candidate_id: 'c', content_hash: hash, plan_hash: hash, budget: 1, samples: [{ frame_id: 'f', reason: '首帧', frame_content_hash: hash }], uncovered_risks: [] })).toBe(true);
  expect(compile('sampleObservationSchema')({ candidate_id: 'c', content_hash: hash, plan_hash: hash, frame_id: 'f', frame_content_hash: hash, viewed: false, result: 'uncertain', explanation: '文件缺失', evidence_source: 'read_error' })).toBe(true);
  expect(compile('sampleObservationSchema')({ candidate_id:'c',content_hash:hash,plan_hash:hash,frame_id:'f',frame_content_hash:hash,viewed:false,result:'ok',explanation:'contradiction',evidence_source:'source' })).toBe(false);
  expect(compile('sampleObservationSchema')({ candidate_id:'c',content_hash:hash,plan_hash:hash,frame_id:'f',frame_content_hash:hash,viewed:false,result:'uncertain',explanation:' ',evidence_source:'source' })).toBe(false);
  expect(compile('deliveryRequestSchema')({ task_id: 't', candidate_id: 'c', acceptance_epoch: 1, operation_id: 'o' })).toBe(true);
  expect(compile('operationRecordSchema')({ id: 'o', request_key: 'r', payload_hash: hash, base_content: null, kind: 'candidate', state: 'claimed', attempt_job_ids: [], result: null, checkpoint: null })).toBe(true);
});
