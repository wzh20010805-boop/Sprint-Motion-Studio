import {setup} from './collaborationTask3Fixture';
export const candidateSetup=setup+String.raw`
const c=await import('./apps/server/src/pipeline/collaboration/candidates');
const {checkCandidate}=await import('./apps/server/src/pipeline/collaboration/checks');
const {fileHash}=await import('./apps/server/src/pipeline/alignment');
config.canvas={width:96,height:96};config.anchor=[48,80];config.roots=[{index:0,x:32,y:50}];
async function seedCandidate(n=2,sourceBytes=bytes,options={}){
 const imp=await importSeq(Array.from({length:n},(_,i)=>({name:'frame'+i+'.png',bytes:sourceBytes})),options);
 const brief={context,source_id:imp.source_id,ordered_source_frame_ids:getSource(project.id,imp.source_id).probe.frames.map(f=>f.source_frame_id),subject_region:{value:null,origin:'inferred'},alignment:{value:config,origin:'user'},timing,loop:{value:true,origin:'user'},sampling_limit:1,output:{value:{max_texture:256,gap:1,margin:1,formats:['png_sequence','spritesheet']},origin:'preset'}};
 brief.goal={value:'保留全部帧，制作测试跑步动作',origin:'user'};
 const task=d.createCollaborationTask(brief,{request_key:uid()},actor);
 const request=()=>({...context,task_id:task.id,base_content:d.readDraftContent(context).token,request_key:uid()});
 return {imp,brief,task,request};
}
`;
