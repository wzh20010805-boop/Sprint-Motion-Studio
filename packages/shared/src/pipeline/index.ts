/** 源时间以最简有理数保留；JSON 边界只允许安全整数。 */
export interface Rational { num: number; den: number }

export interface SourceFrameTiming {
  source_frame_id: string;
  source_index: number;
  file: string;
  pts: string;
  time_base: Rational;
  presentation_time: Rational;
  display_duration: Rational;
  duration_origin: "next_pts" | "frame_duration" | "stream_end" | "estimated";
  decode_status: "ok";
}

export interface SourceTiming {
  schema_version: "1.0";
  source_id: string;
  frames: SourceFrameTiming[];
  duration: Rational;
  warnings: string[];
}

export interface VideoProbeFrame { pts: string; duration: string | null }

export interface VideoProbe {
  streamIndex: number;
  width: number;
  height: number;
  codec: string;
  pixelFormat: string;
  timeBase: Rational;
  averageFrameRate: Rational | null;
  nominalFrameRate: Rational | null;
  sampleAspectRatio: Rational;
  streamStartPts: string | null;
  streamDurationPts: string | null;
  frames: VideoProbeFrame[];
  formatName: string;
  warnings: string[];
}

export interface ExtractionResult {
  sourceId: string;
  frameCount: number;
  rawDirectory: string;
  timing: SourceTiming;
  probe: VideoProbe;
  warnings: string[];
}
export * from './masks';
export * from './alignment';
export * from './schemas';
export * from './collaboration';
export * from './collaborationSchemas';

/** PNG 清单保存原件映射，不提供视频 PTS。 */
export interface PngSourceFrame { source_frame_id:string; source_index:number; original_name:string; canonical_path:string; sha256:string; width:number; height:number }
export interface PngSourceProbe { kind:'png_sequence'; schema_version:'1.0'; order_origin:'explicit'|'natural'; frames:PngSourceFrame[]; timing:import('./collaboration').TaskBrief['timing']; warnings:string[] }
