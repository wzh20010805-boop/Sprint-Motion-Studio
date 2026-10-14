import type {CandidateFrame,CandidateManifest} from '@framebaker/shared';
import {collaborationHash} from './operations';

/** v1 显式投影：打包位置、路径、遮罩版本标签与时序不改变逐帧可审身份。 */
export function candidateFrameHash(frame:CandidateFrame,manifest:Pick<CandidateManifest,'alignment'|'compositor_hash'>):string {
  return collaborationHash({version:'candidate-frame-v1',frame_id:frame.frame_id,source_frame_id:frame.source_frame_id,
    raw_sha256:frame.raw_sha256,mask_sha256:frame.mask_sha256,rgba_sha256:frame.rgba_sha256,png_sha256:frame.png_sha256,
    source_size:frame.source_size,canvas:manifest.alignment.canvas,anchor:manifest.alignment.anchor,scale:manifest.alignment.scale,
    resampling:manifest.alignment.resampling,resolved_transform:frame.resolved_transform,resolved_root:frame.resolved_root,
    source_to_canvas:frame.source_to_canvas,compositor_hash:manifest.compositor_hash});
}
export function candidatePlaybackHash(manifest:Pick<CandidateManifest,'alignment'|'output'|'frames'>):string {
  return collaborationHash({version:'candidate-playback-v1',canvas:manifest.alignment.canvas,loop:manifest.output.loop,
    frames:manifest.frames.map(f=>({frame_id:f.frame_id,source_frame_id:f.source_frame_id,png_sha256:f.png_sha256,duration:f.duration}))});
}
export function candidateContentHash(manifest:CandidateManifest):string {
  const {content_hash:_,...content}=manifest;
  return collaborationHash({version:'candidate-manifest-v1',content});
}
export function candidateFiles(manifest:CandidateManifest):Array<{file:string;sha256:string}> {
  return [...manifest.frames.flatMap(f=>[{file:f.files.raw,sha256:f.raw_sha256},{file:f.files.mask,sha256:f.mask_sha256},
    {file:f.files.rgba,sha256:f.rgba_sha256},{file:f.files.png,sha256:f.png_sha256}]),
    ...manifest.sheets.map(s=>({file:s.file,sha256:s.sha256})),...manifest.auxiliary_files];
}
