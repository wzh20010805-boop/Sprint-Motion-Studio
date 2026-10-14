import type { Rational } from './index';
import type { AlignmentConfig, FrameRenderTransform } from './alignment';
import type { JsonValue } from '../json';

export type WorkContext = { project_id: string; axis_id: string };
/** 已成功进入返工的制作副本；不代表候选已被修改。 */
export type DraftEditContext = WorkContext & {task_id:string;parent_candidate_id:string;content_token:ContentToken};
export interface ActionCollaborationState {mode:'legacy'|'collaboration';tasks:CollaborationTask[];timing:TaskBrief['timing']|null}
export type ContentToken = { revision: number; hash: string };
export type RequestIdentity = { request_key: string };
export type ActorContext = { session_id: string; role: 'maker' | 'reviewer' };
export type FieldOrigin = 'user' | 'preset' | 'inferred';
export type TaskField<T> = { value: T; origin: FieldOrigin };
export type ReviewContext = RequestIdentity & { task_id: string; candidate_id: string; base_review_revision: number };
export type PixelRect = [number, number, number, number];
export type TaskTiming = { mode: 'source_pts' } | { mode: 'confirmed_fps'; fps: Rational } | { mode: 'explicit_durations'; durations: Rational[] };
export type DurationOrigin = 'next_pts' | 'frame_duration' | 'stream_end' | 'estimated' | 'confirmed_fps' | 'explicit_durations';
export type OutputFormat = 'png_sequence' | 'spritesheet' | 'contact_sheet' | 'preview_mp4' | 'zip';
export interface TaskOutput { max_texture: number; gap: number; margin: number; formats: OutputFormat[] }
export interface TaskBrief {
  /** 历史要求可缺失；新建时由核心服务验证并冻结。 */
  goal?: {value:string;origin:'user'};
  source_identity?: {kind:'video'|'png_sequence';original_sha256:string;frames:Array<{source_frame_id:string;sha256:string}>};
  context: WorkContext;
  source_id: string;
  ordered_source_frame_ids: string[];
  subject_region: TaskField<PixelRect | null>;
  alignment: TaskField<AlignmentConfig>;
  timing: TaskField<TaskTiming>;
  loop: TaskField<boolean>;
  sampling_limit: number;
  output: TaskField<TaskOutput>;
}
export const COLLABORATION_TASK_STATES = ['preparing', 'producing', 'checking', 'awaiting_review', 'reworking', 'accepted', 'packaging', 'delivered', 'needs_input', 'failed', 'cancelled'] as const;
export type CollaborationTaskState = typeof COLLABORATION_TASK_STATES[number];
export interface CollaborationTask {
  id: string;
  context: WorkContext;
  brief_version: number;
  content_token: ContentToken;
  state: CollaborationTaskState;
  selected_candidate_id: string | null;
  acceptance_epoch: number;
  operation_ids: string[];
}
export interface DraftFrame {
  frame_id: string; source_frame_id: string; source_index: number; sequence_index: number;
  duration: Rational; duration_origin: DurationOrigin; source_size: { width: number; height: number };
  raw_path: string; raw_sha256: string;
  mask_path: string | null; mask_sha256: string | null; rgba_path: string | null; rgba_sha256: string | null;
  mask_version_id: string | null; transform: FrameRenderTransform;
}
export interface DraftContent { context: WorkContext; token: ContentToken; frames: DraftFrame[]; expected_source_frame_ids: string[]; alignment: AlignmentConfig | null }
/** Canvas 顺序 [a,b,c,d,tx,ty]：x'=a*x+c*y+tx，y'=b*x+d*y+ty；坐标指像素边界，中心加0.5。 */
export type AffineMatrix = [number, number, number, number, number, number];
export type SourceToCanvas = { matrix: AffineMatrix; inverse_matrix: AffineMatrix; noninvertible_reason: null } | { matrix: null; inverse_matrix: null; noninvertible_reason: string };
export interface CandidateFrame {
  frame_id: string; source_frame_id: string; source_index: number; sequence_index: number;
  duration: Rational; duration_origin: DurationOrigin;
  source_size: { width: number; height: number }; rgba_sha256: string;
  mask_provenance: { kind: string; reasons: string[] };
  grid_cell: { sheet_index: number; rect: PixelRect };
  raw_sha256: string; mask_version_id: string; mask_sha256: string; png_sha256: string; content_hash: string;
  files: { raw: string; mask: string; rgba: string; png: string };
  resolved_transform: FrameRenderTransform; resolved_root: { x: number; y: number }; source_to_canvas: SourceToCanvas;
}
export interface CandidateManifest {
  schema_version: '1.0'; candidate_id: string; parent_candidate_id: string | null; task_id: string; brief_version: number;
  content_token: ContentToken; content_hash: string; playback_hash: string; compositor_hash: string;
  alignment: AlignmentConfig; output: TaskOutput & { loop: boolean }; frames: CandidateFrame[];
  brief: TaskBrief;
  coverage: Array<{ step_id: string; frame_id: string; source_frame_id: string }>;
  compositor: { source_hash: string; pillow_version: string };
  grid: { cell: [number, number]; margin: number; gap: number; columns: number; rows: number };
  sheets: Array<{ file: string; sha256: string; width: number; height: number }>;
  auxiliary_files: Array<{ file: string; sha256: string }>;
}
export interface CandidateCheckReport {
  id: string; candidate_id: string; content_hash: string; manifest_sha256: string;
  checked_frame_count: number; blocking_errors: Array<{ code: string; frame_id?: string; detail?: string }>; warnings: Array<{ code: string; frame_id?: string }>;
}
/** Task9 恢复只读此检查点；prepared 目录不等于已提交候选。 */
export interface CandidateCheckpoint {
  version: 1; phase: 'freezing' | 'prepared' | 'committed'; operation_id: string; candidate_id: string;
  attempt_id: string; job_id: string | null; staging_directory: string; final_directory: string;
  base_content: ContentToken; manifest_sha256: string | null; content_hash: string | null;
  files: Array<{ file: string; sha256: string }>;
}
/** 内容清单固定，检查与审核仅通过附加记录关联。 */
export interface CandidateRecord {
  id: string; task_id: string; parent_candidate_id: string | null;
  manifest_path: string; manifest_sha256: string; content_hash: string;
  visibility: 'private' | 'submitted'; technical_check_id: string | null; self_check_id: string | null; review_revision: number;
}
export type CandidateBuildRequest = WorkContext & RequestIdentity & { task_id: string; base_content: ContentToken; parent_candidate_id?: string };
export type FrameReviewPatch = { frame_id: string; verdict: 'pending' | 'approved' | 'needs_repair' };
export type IssuePatch = { frame_ids: string[]; rect: PixelRect | null; coordinate_system: 'final_canvas_pixels'; text: string; severity: 'blocking' | 'advisory' };
export type IssueRepairPatch = { issue_id: string; repair_candidate_id: string; frame_ids: string[]; note: string };
export type PlaybackReviewPatch = { playback_hash: string; confirmed: boolean };
/** 人工已检查整段最终帧和播放后，一次确认固定候选。 */
export type WholeCandidateReviewPatch = { content_hash: string; playback_hash: string; confirmed: true };
export type ReviewResult = { review_revision: number; acceptance_epoch: number | null; accepted: boolean; pending_delivery_operation_id: string | null };
export type SourceDefectPatch = { issue_id: string; frame_ids: string[]; reason: string };
export type CandidateSelectionRequest = RequestIdentity & { task_id: string; candidate_id: string; expected_selected_candidate_id: string | null; expected_acceptance_epoch: number };
export interface ReviewApprovalReference {
  candidate_id: string; frame_id: string; frame_content_hash: string; review_revision: number;
  operation_id: string; request_key: string; actor: ActorContext; at: number;
}
export interface FrameInheritanceBasis {
  parent: ReviewApprovalReference; original: ReviewApprovalReference;
  parent_manifest_sha256: string; child_manifest_sha256: string; impact_hash: string;
}
export interface FrameReviewState {
  frame_id: string; frame_content_hash: string; verdict: FrameReviewPatch['verdict']; valid: boolean;
  approval: ReviewApprovalReference | null; inheritance: FrameInheritanceBasis | null;
}
export interface PlaybackReviewState { playback_hash: string; confirmed: boolean; review_revision: number; operation_id: string; actor: ActorContext }
export interface IssueResolutionBasis {
  association_operation_id: string; repair_candidate_id: string; after_review_revision: number;
  approvals: ReviewApprovalReference[]; playback_operation_id: string;
}
export interface SourceDefectBasis { operation_id: string; candidate_id: string; frame_ids: string[]; reason: string; actor: ActorContext }
export interface ReviewIssueState {
  id: string; candidate_id: string; frame_ids: string[]; rect: PixelRect | null;
  coordinate_system: 'final_canvas_pixels'; text: string; severity: IssuePatch['severity'];
  status: 'open' | 'repair_linked' | 'resolved' | 'accepted_exception'; blocks_candidate: boolean;
  repair_candidate_id: string | null; repair_frame_ids: string[]; repair_note: string | null;
  resolution: IssueResolutionBasis | null; source_exception: SourceDefectBasis | null;
}
export interface ReviewError { code: string; frame_id?: string; issue_id?: string }
export interface ReviewState extends ReviewResult {
  task_id: string; candidate_id: string; selected: boolean; task_acceptance_counter: number;
  frame_reviews: FrameReviewState[]; issues: ReviewIssueState[]; playback_confirmed: boolean;
  playback: PlaybackReviewState | null; errors: ReviewError[];
}
export interface AcceptanceSnapshot {
  version: 1; task_id: string; candidate_id: string; acceptance_epoch: number; review_revision: number;
  manifest_sha256: string; content_hash: string; playback_hash: string; technical_check_id: string; self_check_id: string;
  frame_approvals: Array<{ approval: ReviewApprovalReference; inheritance: FrameInheritanceBasis | null }>;
  playback: PlaybackReviewState; issues: ReviewIssueState[];
}
/** operation_id 仅在调度信封中加入，避免原负载哈希自引用。 */
export interface DeliveryOperationInput { task_id: string; candidate_id: string; acceptance_epoch: number; snapshot: AcceptanceSnapshot }
export interface AcceptanceRevocation { reason: string; at: number; review_revision: number | null }
export interface DeliveryCheckpoint {
  version: 1; phase: 'packaging' | 'prepared' | 'committed'; operation_id: string; delivery_id: string;
  attempt_id: string; job_id: string | null; staging_directory: string; final_directory: string;
  manifest_sha256: string; content_hash: string; playback_hash: string;
  files: Array<{ file: string; sha256: string }>;
}
export interface AcceptanceCheckpoint { version: 1; snapshot: AcceptanceSnapshot; revocation: AcceptanceRevocation | null; delivery?: DeliveryCheckpoint }
export interface DeliveryResult {
  delivery_id: string; operation_id: string; task_id: string; candidate_id: string; acceptance_epoch: number;
  approval_status: 'approved' | 'withdrawn'; directory: string; committed_at: number; review_revision: number;
  manifest_sha256: string; content_hash: string; playback_hash: string;
  checksums: Record<string,string>; archive_sha256: string;
}
export type ActionExportResolution = {mode:'legacy'} | {mode:'ambiguous'; task_ids:string[]} | {
  mode:'candidate'; candidate_id:string; delivery_id:string; files:Array<{file:string;url:string}>;
};
export interface SamplingPlan {
  candidate_id: string; content_hash: string; plan_hash: string; budget: number;
  samples: Array<{ frame_id: string; reason: string; frame_content_hash: string }>;
  uncovered_risks: string[];
  provenance?: { strategy: 'rational-interval-v1'; manifest_sha256: string; caller_limit: number; user_limit: number; risks: SamplingRisk[] };
}
export interface SamplingRisk { frame_id: string; priority: 0 | 100 | 200 | 201 | 202 | 300; reason: string }
export interface SampleObservation {
  candidate_id: string; content_hash: string; plan_hash: string; frame_id: string; frame_content_hash: string;
  viewed: boolean; result: 'ok' | 'issue' | 'uncertain'; explanation: string; evidence_source: string;
  evidence_candidate_id?: string;
}
/** completed 仅表示事实记录完整；uncertain 与 issue 保留给人工验收。 */
export interface CandidateSelfCheck {
  id: string; candidate_id: string; content_hash: string; manifest_sha256: string; plan_hash: string;
  completed: boolean; blocking_errors: CandidateCheckReport['blocking_errors']; technical_check: CandidateCheckReport;
  observations: SampleObservation[]; viewed_frame_ids: string[]; unviewed_frame_ids: string[];
  reused_frame_ids: string[]; issue_frame_ids: string[]; uncovered_risks: string[];
}
export interface ImpactReport {
  changed_frame_ids: string[]; recheck_frame_ids: string[]; inheritable_frame_ids: string[]; playback_changed: boolean;
  reasons: Array<{ frame_id: string; reasons: string[] }>;
  preset_impacts: Array<{ context: WorkContext; reason: string }>;
}
export const COLLABORATION_OPERATION_STATES = ['claimed', 'queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'needs_input'] as const;
export interface OperationRecord {
  id: string; request_key: string; payload_hash: string; base_content: ContentToken | null; kind: string;
  state: typeof COLLABORATION_OPERATION_STATES[number]; attempt_job_ids: string[]; result: JsonValue; checkpoint: JsonValue;
}
export type DeliveryRequest = { task_id: string; candidate_id: string; acceptance_epoch: number; operation_id: string };
export interface Page<T> { items: T[]; total: number; next_cursor: string | null; complete: boolean; content_token: ContentToken }
export interface ReviewIssuePage extends Page<ReviewIssueState> {review_revision:number}
