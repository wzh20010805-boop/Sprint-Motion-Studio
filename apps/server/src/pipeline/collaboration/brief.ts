import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {TaskBrief} from '@framebaker/shared';
import {getSource,PipelineError} from '../service';
import {collaborationHash} from './operations';
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
/** 原件的实际字节为权威；传入身份只可作一致性校验。历史记录读取不经过此入口。 */
export function verifiedTaskBrief(brief:TaskBrief):TaskBrief {
 if(!brief?.goal||brief.goal.origin!=='user'||typeof brief.goal.value!=='string'||!brief.goal.value.trim()||brief.goal.value.length>4000)throw new PipelineError('TASK_GOAL_REQUIRED','需要保留用户原话目标（1–4000字符）');
 const source=getSource(brief.context.project_id,brief.source_id),original=hash(source.original_path);
 if(original!==source.sha256)throw new PipelineError('SOURCE_IDENTITY_CONFLICT','原素材字节与导入身份不一致',409);
 const identity:NonNullable<TaskBrief['source_identity']>={kind:source.probe.kind==='png_sequence'?'png_sequence':'video',original_sha256:original,frames:[]};
 if(source.probe.kind==='png_sequence')identity.frames=source.probe.frames.map(f=>{const sha256=hash(f.canonical_path);if(sha256!==f.sha256)throw new PipelineError('SOURCE_IDENTITY_CONFLICT','原PNG字节已变化',409);return {source_frame_id:f.source_frame_id,sha256};});
 if(brief.source_identity&&collaborationHash(brief.source_identity)!==collaborationHash(identity))throw new PipelineError('SOURCE_IDENTITY_CONFLICT','客户端源身份与服务验证结果不一致',409);
 return {...structuredClone(brief),source_identity:identity};
}
