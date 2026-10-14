export interface IdleStopRequest {
 activeJobs:number;
 pendingRequests:number;
 pendingWebSockets:number;
 onStop:()=>void;
}
export type IdleStopResult={ok:true}|{ok:false;code:'WORKSPACE_BUSY'};

/** 在同一同步步骤核实空闲并关闭新请求入口，避免先查询、再从外部终止的竞态。 */
export function createIdleShutdownGuard() {
 let stopping=false;
 return {
  isStopping:()=>stopping,
  requestStop(input:IdleStopRequest):IdleStopResult {
   if(stopping)return {ok:true};
   const counts=[input.activeJobs,input.pendingRequests,input.pendingWebSockets];
   if(counts.some(value=>!Number.isSafeInteger(value)||value<0)||input.activeJobs>0||input.pendingRequests>1||input.pendingWebSockets>0)return {ok:false,code:'WORKSPACE_BUSY'};
   stopping=true;
   // 为当前 HTTP 响应留下发送时间；调用方的关闭回调负责释放其服务实例。
   setTimeout(input.onStop,25);
   return {ok:true};
  },
 };
}
