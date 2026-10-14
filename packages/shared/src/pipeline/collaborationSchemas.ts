import { COLLABORATION_OPERATION_STATES, COLLABORATION_TASK_STATES } from './collaboration';
import type {WholeCandidateReviewPatch} from './collaboration';
import type { CandidateCheckpoint, DeliveryCheckpoint, DeliveryResult, AcceptanceSnapshot, AcceptanceCheckpoint, DeliveryOperationInput, ReviewApprovalReference, FrameInheritanceBasis, FrameReviewState, PlaybackReviewState, ReviewIssueState, ReviewState, ReviewError, IssueResolutionBasis, SourceDefectBasis, SourceDefectPatch, CandidateSelectionRequest, ActorContext, CandidateBuildRequest, CandidateFrame, CandidateManifest, CandidateRecord, CollaborationTask, ContentToken, DeliveryRequest, DraftContent, DraftFrame, FrameReviewPatch, ImpactReport, IssuePatch, IssueRepairPatch, OperationRecord, ReviewIssuePage, Page, PlaybackReviewPatch, RequestIdentity, ReviewContext, ReviewResult, SampleObservation, SamplingPlan, TaskBrief, TaskOutput, WorkContext } from './collaboration';

type Schema = Record<string, unknown>;
/** 属性名受共同类型约束，避免契约字段在 schema 中遗漏。 */
const object = <T>(properties: { [K in keyof T]-?: Schema }, optional: Array<keyof T> = []): Schema => ({
  type: 'object', additionalProperties: false, properties,
  required: Object.keys(properties).filter(key => !optional.includes(key as keyof T)),
});
const text: Schema = { type: 'string', minLength: 1, maxLength: 10000 };
const id: Schema = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$' };
const sourceFrameId: Schema = {type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,255}$'};
const sourceFrameIds: Schema = {type:'array',items:sourceFrameId,uniqueItems:true};
const hash: Schema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const number: Schema = { type: 'number' };
const uint: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positiveInt: Schema = { ...uint, minimum: 1 };
const bool: Schema = { type: 'boolean' };
const nil: Schema = { type: 'null' };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, nil] });
const array = (items: Schema, minItems = 0): Schema => ({ type: 'array', items, minItems });
const ids: Schema = { ...array(id), uniqueItems: true };
const point = { ...array(number), minItems: 2, maxItems: 2 };
const rect = { ...array(number), minItems: 4, maxItems: 4 };
const field = (value: Schema): Schema => object({ value, origin: { enum: ['user', 'preset', 'inferred'] } });
export const rationalSchema = object({ num: { ...positiveInt }, den: { ...positiveInt } });
export const workContextSchema = object<WorkContext>({ project_id: id, axis_id: id });
export const contentTokenSchema = object<ContentToken>({ revision: uint, hash });
export const requestIdentitySchema = object<RequestIdentity>({ request_key: { ...text, maxLength: 256 } });
export const actorContextSchema = object<ActorContext>({ session_id: {type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,255}$'}, role: { enum: ['maker', 'reviewer'] } });
export const reviewContextSchema = object<ReviewContext>({ task_id: id, candidate_id: id, base_review_revision: uint, request_key: { ...text, maxLength: 256 } });
export const collaborationAlignmentSchema: Schema = object({
  canvas: object({ width: { ...positiveInt, maximum: 4096 }, height: { ...positiveInt, maximum: 4096 } }),
  anchor: point, scale: { type: 'number', exclusiveMinimum: 0, maximum: 16 },
  resampling: { enum: ['pixel', 'cartoon'] }, mode: { enum: ['fixed', 'ground_keyframes'] },
  roots: array(object({ index: uint, x: number, y: number }), 1), offsets: { type: 'object', additionalProperties: point },
});
export const taskOutputSchema = object<TaskOutput>({
  max_texture: { ...positiveInt, minimum: 16, maximum: 8192 }, gap: { ...uint, maximum: 64 }, margin: { ...uint, maximum: 64 },
  formats: { ...array({ enum: ['png_sequence', 'spritesheet', 'contact_sheet', 'preview_mp4', 'zip'] }, 1), uniqueItems: true },
});
export const taskTimingSchema: Schema = { oneOf: [
  object({ mode: { const: 'source_pts' } }),
  object({ mode: { const: 'confirmed_fps' }, fps: rationalSchema }),
  object({ mode: { const: 'explicit_durations' }, durations: array(rationalSchema, 1) }),
] };
export const taskBriefSchema = object<TaskBrief>({ context: workContextSchema, source_id: id, ordered_source_frame_ids: { ...sourceFrameIds, minItems: 1 },
  goal:object({value:{type:'string',minLength:1,maxLength:4000},origin:{const:'user'}}),
  source_identity:object({kind:{enum:['video','png_sequence']},original_sha256:hash,frames:array(object({source_frame_id:sourceFrameId,sha256:hash}))}),
  subject_region: field(nullable(rect)), alignment: field(collaborationAlignmentSchema), timing: field(taskTimingSchema), loop: field(bool),
  sampling_limit: { ...positiveInt, maximum: 12 }, output: field(taskOutputSchema) },['goal','source_identity']);
export const collaborationTaskSchema = object<CollaborationTask>({ id, context: workContextSchema, brief_version: positiveInt, content_token: contentTokenSchema,
  state: { enum: COLLABORATION_TASK_STATES }, selected_candidate_id: nullable(id), acceptance_epoch: uint, operation_ids: ids });
export const frameRenderTransformSchema = object({ offset_x: number, offset_y: number, scale: number, rotation: number, opacity: { type: 'number', minimum: 0, maximum: 1 } });
const durationOrigin: Schema = { enum: ['next_pts', 'frame_duration', 'stream_end', 'estimated', 'confirmed_fps', 'explicit_durations'] };
export const draftFrameSchema = object<DraftFrame>({ frame_id: id, source_frame_id: sourceFrameId, source_index: uint, sequence_index: uint,
  duration: rationalSchema, duration_origin: durationOrigin, source_size: object({ width: positiveInt, height: positiveInt }),
  raw_path: text, raw_sha256: hash, mask_path: nullable(text), mask_sha256: nullable(hash), rgba_path: nullable(text), rgba_sha256: nullable(hash), mask_version_id: nullable(id), transform: frameRenderTransformSchema });
export const draftContentSchema = object<DraftContent>({ context: workContextSchema, token: contentTokenSchema, frames: array(draftFrameSchema), expected_source_frame_ids: sourceFrameIds, alignment: nullable(collaborationAlignmentSchema) });
export const sourceToCanvasSchema: Schema = { oneOf: [
  object({ matrix: { ...array(number), minItems: 6, maxItems: 6 }, inverse_matrix: { ...array(number), minItems: 6, maxItems: 6 }, noninvertible_reason: nil }),
  object({ matrix: nil, inverse_matrix: nil, noninvertible_reason: text }),
] };
const relativeFile:Schema={type:'string',pattern:'^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$'};
const size=object({width:positiveInt,height:positiveInt});
export const candidateFrameSchema = object<CandidateFrame>({ frame_id: id, source_frame_id: sourceFrameId, source_index: uint, sequence_index: uint, duration: rationalSchema, duration_origin: durationOrigin,
  source_size:size,rgba_sha256:hash,mask_provenance:object({kind:text,reasons:array(text)}),grid_cell:object({sheet_index:uint,rect:{type:'array',items:[uint,uint,positiveInt,positiveInt],minItems:4,maxItems:4,additionalItems:false}}),
  raw_sha256: hash, mask_version_id: id, mask_sha256: hash, png_sha256: hash, content_hash: hash,
  files: object({ raw: relativeFile, mask: relativeFile, rgba: relativeFile, png: relativeFile }), resolved_transform: frameRenderTransformSchema,
  resolved_root: object({ x: number, y: number }), source_to_canvas: sourceToCanvasSchema });
export const candidateManifestSchema = object<CandidateManifest>({ schema_version: { const: '1.0' }, candidate_id: id, parent_candidate_id: nullable(id), task_id: id, brief_version: positiveInt,
  content_token: contentTokenSchema, content_hash: hash, playback_hash: hash, compositor_hash: hash, alignment: collaborationAlignmentSchema,
  brief:taskBriefSchema,coverage:array(object({step_id:id,frame_id:id,source_frame_id:sourceFrameId}),1),compositor:object({source_hash:hash,pillow_version:text}),
  grid:object({cell:{...array(positiveInt),minItems:2,maxItems:2},margin:uint,gap:uint,columns:positiveInt,rows:positiveInt}),
  sheets:array(object({file:relativeFile,sha256:hash,width:positiveInt,height:positiveInt}),1),auxiliary_files:array(object({file:relativeFile,sha256:hash})),
  output: { ...taskOutputSchema, properties: { ...(taskOutputSchema.properties as object), loop: bool }, required: [...(taskOutputSchema.required as string[]), 'loop'] }, frames: array(candidateFrameSchema, 1) });
export const candidateRecordSchema = object<CandidateRecord>({ id, task_id: id, parent_candidate_id: nullable(id), manifest_path: text, manifest_sha256: hash, content_hash: hash,
  visibility: { enum: ['private', 'submitted'] }, technical_check_id: nullable(id), self_check_id: nullable(id), review_revision: uint });
export const candidateBuildRequestSchema = object<CandidateBuildRequest>({ project_id: id, axis_id: id, request_key: { ...text, maxLength: 256 }, task_id: id, base_content: contentTokenSchema, parent_candidate_id: id }, ['parent_candidate_id']);
export const frameReviewPatchSchema = object<FrameReviewPatch>({ frame_id: id, verdict: { enum: ['pending', 'approved', 'needs_repair'] } });
export const issuePatchSchema = object<IssuePatch>({ frame_ids: { ...ids, minItems: 1 }, rect: nullable(rect), coordinate_system: { const: 'final_canvas_pixels' }, text, severity: { enum: ['blocking', 'advisory'] } });
export const issueRepairPatchSchema = object<IssueRepairPatch>({ issue_id: id, repair_candidate_id: id, frame_ids: { ...ids, minItems: 1 }, note: text });
export const playbackReviewPatchSchema = object<PlaybackReviewPatch>({ playback_hash: hash, confirmed: bool });
export const wholeCandidateReviewPatchSchema = object<WholeCandidateReviewPatch>({content_hash:hash,playback_hash:hash,confirmed:{const:true}});
export const reviewResultSchema = object<ReviewResult>({ review_revision: uint, acceptance_epoch: nullable(positiveInt), accepted: bool, pending_delivery_operation_id: nullable(id) });
export const samplingPlanSchema = object<SamplingPlan>({ candidate_id: id, content_hash: hash, plan_hash: hash, budget: { ...positiveInt, maximum: 12 },
  samples: { ...array(object({ frame_id: id, reason: text, frame_content_hash: hash }), 1), maxItems: 12 }, uncovered_risks: {...ids},
  provenance: object({strategy:{const:'rational-interval-v1'},manifest_sha256:hash,caller_limit:positiveInt,user_limit:positiveInt,risks:array(object({frame_id:id,priority:{enum:[0,100,200,201,202,300]},reason:text}))}) }, ['provenance']);
export const sampleObservationSchema = object<SampleObservation>({ candidate_id: id, content_hash: hash, plan_hash: hash, frame_id: id, frame_content_hash: hash,
  viewed: bool, result: { enum: ['ok', 'issue', 'uncertain'] }, explanation: {...text,pattern:'\\S'}, evidence_source: {...text,pattern:'\\S'}, evidence_candidate_id:id }, ['evidence_candidate_id']);
(sampleObservationSchema as any).allOf=[{if:{properties:{viewed:{const:false}},required:['viewed']},then:{properties:{result:{const:'uncertain'}}}}];
export const impactReportSchema = object<ImpactReport>({ changed_frame_ids: ids, recheck_frame_ids: ids, inheritable_frame_ids: ids, playback_changed: bool,
  reasons: array(object({ frame_id: id, reasons: array(text, 1) })), preset_impacts: array(object({ context: workContextSchema, reason: text })) });
export const operationRecordSchema = object<OperationRecord>({ id, request_key: { ...text, maxLength: 256 }, payload_hash: hash, base_content: nullable(contentTokenSchema), kind: text,
  state: { enum: COLLABORATION_OPERATION_STATES }, attempt_job_ids: ids, result: {}, checkpoint: {} });
export const deliveryRequestSchema = object<DeliveryRequest>({ task_id: id, candidate_id: id, acceptance_epoch: positiveInt, operation_id: id });
/** items 不设摘要长度；调用方通过完整分页取得全部记录。 */
export const collaborationPageSchema = object<Page<unknown>>({ items: array({}), total: uint, next_cursor: nullable(text), complete: bool, content_token: contentTokenSchema });

export const sourceDefectPatchSchema=object<SourceDefectPatch>({issue_id:id,frame_ids:{...ids,minItems:1},reason:{...text,maxLength:10000,pattern:'\\S'}});
export const candidateSelectionRequestSchema=object<CandidateSelectionRequest>({task_id:id,candidate_id:id,expected_selected_candidate_id:nullable(id),expected_acceptance_epoch:uint,request_key:{...text,maxLength:256}});
export const reviewApprovalReferenceSchema=object<ReviewApprovalReference>({candidate_id:id,frame_id:id,frame_content_hash:hash,review_revision:positiveInt,operation_id:id,request_key:{...text,maxLength:256},actor:actorContextSchema,at:uint});
export const frameInheritanceBasisSchema=object<FrameInheritanceBasis>({parent:reviewApprovalReferenceSchema,original:reviewApprovalReferenceSchema,parent_manifest_sha256:hash,child_manifest_sha256:hash,impact_hash:hash});
export const frameReviewStateSchema=object<FrameReviewState>({frame_id:id,frame_content_hash:hash,verdict:{enum:['pending','approved','needs_repair']},valid:bool,approval:nullable(reviewApprovalReferenceSchema),inheritance:nullable(frameInheritanceBasisSchema)});
export const playbackReviewStateSchema=object<PlaybackReviewState>({playback_hash:hash,confirmed:bool,review_revision:positiveInt,operation_id:id,actor:actorContextSchema});
export const issueResolutionBasisSchema=object<IssueResolutionBasis>({association_operation_id:id,repair_candidate_id:id,after_review_revision:uint,approvals:array(reviewApprovalReferenceSchema,1),playback_operation_id:id});
export const sourceDefectBasisSchema=object<SourceDefectBasis>({operation_id:id,candidate_id:id,frame_ids:{...ids,minItems:1},reason:text,actor:actorContextSchema});
export const reviewIssueStateSchema=object<ReviewIssueState>({id,candidate_id:id,frame_ids:{...ids,minItems:1},rect:nullable(rect),coordinate_system:{const:'final_canvas_pixels'},text,severity:{enum:['blocking','advisory']},status:{enum:['open','repair_linked','resolved','accepted_exception']},blocks_candidate:bool,repair_candidate_id:nullable(id),repair_frame_ids:ids,repair_note:nullable(text),resolution:nullable(issueResolutionBasisSchema),source_exception:nullable(sourceDefectBasisSchema)});
export const reviewErrorSchema=object<ReviewError>({code:text,frame_id:id,issue_id:id},['frame_id','issue_id']);
export const reviewStateSchema=object<ReviewState>({review_revision:uint,acceptance_epoch:nullable(positiveInt),accepted:bool,pending_delivery_operation_id:nullable(id),task_id:id,candidate_id:id,selected:bool,task_acceptance_counter:uint,frame_reviews:array(frameReviewStateSchema),issues:array(reviewIssueStateSchema),playback_confirmed:bool,playback:nullable(playbackReviewStateSchema),errors:array(reviewErrorSchema)});
export const acceptanceSnapshotSchema=object<AcceptanceSnapshot>({version:{const:1},task_id:id,candidate_id:id,acceptance_epoch:positiveInt,review_revision:uint,manifest_sha256:hash,content_hash:hash,playback_hash:hash,technical_check_id:id,self_check_id:id,frame_approvals:array(object({approval:reviewApprovalReferenceSchema,inheritance:nullable(frameInheritanceBasisSchema)}),1),playback:playbackReviewStateSchema,issues:array(reviewIssueStateSchema)});
export const deliveryOperationInputSchema=object<DeliveryOperationInput>({task_id:id,candidate_id:id,acceptance_epoch:positiveInt,snapshot:acceptanceSnapshotSchema});
export const deliveryCheckpointSchema=object<DeliveryCheckpoint>({version:{const:1},phase:{enum:['packaging','prepared','committed']},operation_id:id,delivery_id:id,attempt_id:id,job_id:nullable(id),staging_directory:text,final_directory:text,manifest_sha256:hash,content_hash:hash,playback_hash:hash,files:array(object({file:text,sha256:hash}))});
export const deliveryResultSchema=object<DeliveryResult>({delivery_id:id,operation_id:id,task_id:id,candidate_id:id,acceptance_epoch:positiveInt,approval_status:{enum:['approved','withdrawn']},directory:text,committed_at:uint,review_revision:uint,manifest_sha256:hash,content_hash:hash,playback_hash:hash,checksums:{type:'object',additionalProperties:hash},archive_sha256:hash});
export const acceptanceCheckpointSchema=object<AcceptanceCheckpoint>({version:{const:1},snapshot:acceptanceSnapshotSchema,revocation:nullable(object({reason:text,at:uint,review_revision:nullable(uint)})),delivery:deliveryCheckpointSchema},['delivery']);

export const candidateCheckpointSchema=object<CandidateCheckpoint>({version:{const:1},phase:{enum:['freezing','prepared','committed']},operation_id:id,candidate_id:id,attempt_id:id,job_id:nullable(id),staging_directory:text,final_directory:text,base_content:contentTokenSchema,manifest_sha256:nullable(hash),content_hash:nullable(hash),files:array(object({file:text,sha256:hash}))});

export const reviewIssuePageSchema=object<ReviewIssuePage>({items:array(reviewIssueStateSchema),next_cursor:nullable({type:'string',maxLength:1024}),total:uint,complete:bool,content_token:contentTokenSchema,review_revision:uint});
