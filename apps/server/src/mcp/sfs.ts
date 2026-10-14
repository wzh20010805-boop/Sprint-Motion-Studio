import {createMcpHandler,McpServer} from '@modelcontextprotocol/server';
import serverPackage from '../../package.json' with {type:'json'};
import {getRequestActor} from '../localSessions';
import {makerTools,runMakerTool} from './makerTools';
import {authenticatedMcpFetch} from './request';
const handler=createMcpHandler(()=>{
 const server=new McpServer({name:'soldier-frame-studio',version:serverPackage.version});
 for(const [name,tool] of Object.entries(makerTools))server.registerTool(name,{description:tool.description,inputSchema:tool.schema,annotations:{destructiveHint:false}},async(input,ctx)=>{
  try{if(!ctx.http?.req)throw Object.assign(new Error('UNAUTHORIZED'),{code:'UNAUTHORIZED'});const value=await runMakerTool(name,input,getRequestActor(ctx.http.req));return {content:[{type:'text',text:JSON.stringify(value)}]};}
  catch(e){const error=e as Error&{code?:string};return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{code:error.code??'EXECUTION_ERROR',message:error.message}})}]};}
 });return server;
});
export const sfsMcpHandler={fetch:(request:Request)=>authenticatedMcpFetch(request,handler)};
