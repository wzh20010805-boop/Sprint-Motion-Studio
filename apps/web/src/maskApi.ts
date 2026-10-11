import type { MaskStroke, MatteRequest } from '@framebaker/shared';
export interface MaskVersion { id:string; parent_id:string|null; kind:string; info:string }
export interface MaskState { frame_id:string; revision:number; version_id:string|null; reviewed:boolean; source_changed:boolean; current:MaskVersion|null; versions:MaskVersion[] }
async function request<T>(path:string, body?:unknown):Promise<T> {
 const response=await fetch('/api/v1'+path, body === undefined ? undefined : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const envelope=await response.json(); if (!response.ok || !envelope.ok) throw new Error(envelope.error?.message ?? `HTTP ${response.status}`); return envelope as T;
}
export const maskApi={
 resume:async(id:string)=>(await request<{data:{active_job:string|null}}>(`/projects/${id}/masks`)).data.active_job,
 summary:async(id:string)=>(await request<{data:{frames:Array<{id:string;reviewed:number;info:string|null}>}}>(`/projects/${id}/masks`)).data.frames,
 state:async(id:string)=>(await request<{data:MaskState}>(`/masks/${id}`)).data,
 image:(id:string,kind:'raw'|'mask'|'rgba',version?:string|null)=>`/api/v1/masks/${id}/image?kind=${kind}${version?'&version='+encodeURIComponent(version):''}`,
 matte:(body:MatteRequest)=>request<{job_id:string}>('/matte',body),
 job:(id:string)=>request<{status:string;data:{job:{progress:string;result:any;error:string}};error?:{message:string}}>(`/jobs/${id}`),
 cancel:(id:string)=>request(`/jobs/${id}/cancel`,{}),
 save:async(id:string,state:MaskState,strokes:MaskStroke[])=>(await request<{data:MaskState}>(`/masks/${id}/strokes`,{version_id:state.version_id,revision:state.revision,strokes})).data,
 undo:async(id:string,state:MaskState)=>(await request<{data:MaskState}>(`/masks/${id}/undo`,{version_id:state.version_id,revision:state.revision})).data,
 review:async(id:string,state:MaskState)=>(await request<{data:MaskState}>(`/masks/${id}/review`,{version_id:state.version_id,revision:state.revision})).data,
};
