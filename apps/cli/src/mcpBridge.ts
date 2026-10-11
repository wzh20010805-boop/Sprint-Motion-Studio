import { createInterface } from 'node:readline';
import type { ServiceInfo } from '../../server/src/runtime';

/** 标准stdio JSON-RPC转发到同一个已鉴权SDK HTTP端点，业务不会在CLI执行。 */
export async function bridgeStdio(service:ServiceInfo) {
 let session:string|null=null;
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
 // stdio客户没有GUI WebSocket；轻量健康检查保持同一鉴权服务的客户租约。
 const heartbeat=setInterval(()=>{void fetch(service.url+'/api/health',{headers:{Authorization:`Bearer ${service.token}`},signal:AbortSignal.timeout(3000)}).catch(()=>{});},Math.max(100,Math.min(30000,Number(process.env.SFS_IDLE_TIMEOUT_MS??300000)/3)));
 try {for await(const line of lines){if(!line.trim())continue;let message:any;
  try{
   if(line.length>1024*1024)throw new Error('MCP消息过大');message=JSON.parse(line);
   const response:Response=await fetch(service.url+'/mcp',{method:'POST',headers:{Authorization:`Bearer ${service.token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{})},body:line});
   session=response.headers.get('mcp-session-id')??session;
   if(response.status===202||response.status===204)continue;
   const text=await response.text();
   if(response.headers.get('content-type')?.includes('text/event-stream')){for(const data of text.split(/\r?\n/).filter(v=>v.startsWith('data:'))){const parsed=JSON.parse(data.slice(5));if(parsed.id!==undefined)process.stdout.write(JSON.stringify(parsed)+'\n');}}
   else if(text.trim()){const parsed=JSON.parse(text);if(parsed.id!==undefined)process.stdout.write(JSON.stringify(parsed)+'\n');}
  }catch(e){if(message?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:(e as Error).message}})+'\n');}
 }
 }finally{clearInterval(heartbeat);lines.close();}
}
