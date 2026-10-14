import type {McpHttpHandler} from '@modelcontextprotocol/server';
import {getRequestActor,requireCurrentMaker,LocalAuthError} from '../localSessions';
export const MCP_BODY_BYTES=1048576;
export const MULTIPART_BODY_BYTES=128*1024*1024;
/** 先认证，再有界解析一次；SDK parsedBody 保留 WeakMap 绑定的原 Request。 */
export async function authenticatedMcpFetch(request:Request,handler:Pick<McpHttpHandler,'fetch'>):Promise<Response> {
 try{requireCurrentMaker(getRequestActor(request));}catch(e){const error=e as LocalAuthError;return Response.json({jsonrpc:'2.0',id:null,error:{code:-32000,message:error.code??'UNAUTHORIZED'}},{status:error.status??401});}
 if(request.method!=='POST')return handler.fetch(request);
 const failure=(code:number,message:string,status=400)=>Response.json({jsonrpc:'2.0',id:null,error:{code,message}},{status});
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return failure(-32600,'Content-Type 必须为 application/json',415);
 const reader=request.body?.getReader();if(!reader)return failure(-32700,'JSON body required');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MCP_BODY_BYTES){await reader.cancel();return failure(-32600,'MCP HTTP JSON超过1048576字节；大素材请用CLI multipart',413);}chunks.push(value);}let parsedBody:unknown;try{parsedBody=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{return failure(-32700,'JSON解析失败');}return await handler.fetch(request,{parsedBody});}
 finally{reader.releaseLock();}
}
