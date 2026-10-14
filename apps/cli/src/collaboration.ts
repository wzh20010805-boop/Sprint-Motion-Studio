import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ServiceInfo} from '../../server/src/runtime';
import {CliError,errorExit,requestService} from './client';
export const collaborationCommands=['task cancel','operation cancel','action create','task create','task inspect','candidate create','candidate inspect','candidate samples','candidate observe','candidate submit','candidate compare','candidate check','issue list','issue repair','rework start','operation inspect','operation resume','frames list','source extract'];
export async function waitOperation(service:ServiceInfo,id:string,timeout:number){const deadline=Date.now()+timeout*1000;let body:any;
 do{body=await requestService(service,`/api/v1/collaboration/operations/${encodeURIComponent(id)}`);const op=body.data;if(['succeeded','failed','interrupted','needs_input','cancelled'].includes(op.state))return {body,exitCode:op.state==='succeeded'?0:op.state==='cancelled'?5:op.state==='needs_input'?4:errorExit(op.result?.error_code)};await Bun.sleep(100);}while(Date.now()<deadline);
 throw new CliError('WAIT_TIMEOUT','等待超时，原操作仍可查询',1,{schema_version:'1.0',ok:false,status:body?.data?.state??'running',operation_id:id,job_id:body?.data?.attempt_job_ids?.at(-1)??null,timed_out:true,cancelled_job:false,data:body?.data??{},error:{code:'WAIT_TIMEOUT',message:'等待超时，原操作未取消'}});
}
export async function runCollaboration(command:string,flags:Record<string,unknown>,service:ServiceInfo,timeout:number){
 const required=(key:string)=>{const v=flags[key];if(typeof v!=='string'||!v.trim())throw new CliError('INVALID_ARGUMENT',`缺少--${key}`);return v;};
 const parse=(value:string,label:string)=>{try{return JSON.parse(value);}catch{throw new CliError('INVALID_INPUT',`${label}必须为JSON`);}};
 const input=flags.file?parse(readFileSync(resolve(required('file')),'utf8'),'file'):{};
 const mappings:Record<string,string>={'task cancel':'cancel_task','operation cancel':'cancel_operation','action create':'create_action','task create':'create_task','task inspect':'inspect_task','candidate create':'create_candidate','candidate inspect':'inspect_candidate','candidate samples':'get_candidate_samples','candidate observe':'record_sample_observations','candidate submit':'submit_candidate','candidate compare':'compare_candidates','candidate check':'check_candidate','issue list':'list_review_issues','issue repair':'record_issue_repair','rework start':'start_rework','operation inspect':'inspect_operation','operation resume':'resume_operation','frames list':'list_frames','source extract':'extract_source'};
 const data:Record<string,unknown>={...input};
 for(const [flag,field] of Object.entries({project:'project_id',axis:'axis_id',source:'source_id',clip:'clip_id',task:'task_id',candidate:'candidate_id',parent:'parent_candidate_id',operation:'operation_id','request-key':'request_key',cursor:'cursor',name:'name','content-hash':'content_hash'}))if(flags[flag]!==undefined)data[field]=required(flag);
 for(const [flag,field] of Object.entries({'base-content':'base_content'}))if(flags[flag]!==undefined)data[field]=parse(required(flag),flag);
 for(const [flag,field] of Object.entries({'expected-acceptance-epoch':'expected_acceptance_epoch',limit:'limit',fps:'fps','base-revision':'base_revision'}))if(flags[flag]!==undefined)data[field]=Number(required(flag));
 const body=await requestService(service,'/api/v1/collaboration/maker/'+mappings[command],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 if(flags.wait){const op=body.data?.operation_id??(body.data?.kind?body.data.id:null);if(op)return waitOperation(service,op,timeout);}
 return {body,exitCode:body.status==='needs_input'?4:0};
}
