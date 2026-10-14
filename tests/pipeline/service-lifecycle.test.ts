import { expect, test } from 'bun:test';
import { createIdleShutdownGuard } from '../../apps/server/src/serviceLifecycle';

test('空闲退出拒绝处理任务、其他请求和已连接桌面，且不改变服务状态',()=>{
 const guard=createIdleShutdownGuard();let stops=0;
 const idle={activeJobs:0,pendingRequests:1,pendingWebSockets:0,onStop:()=>{stops++;}};
 for(const input of [{...idle,activeJobs:1},{...idle,pendingRequests:2},{...idle,pendingWebSockets:1}]){
  expect(guard.requestStop(input)).toEqual({ok:false,code:'WORKSPACE_BUSY'});
  expect(guard.isStopping()).toBe(false);
 }
 expect(stops).toBe(0);
});

test('退出决定同步关闭请求入口，HTTP响应后只执行一次关闭回调',async()=>{
 const guard=createIdleShutdownGuard();let stops=0;
 const input={activeJobs:0,pendingRequests:1,pendingWebSockets:0,onStop:()=>{stops++;}};
 expect(guard.requestStop(input)).toEqual({ok:true});
 expect(guard.isStopping()).toBe(true);
 expect(stops).toBe(0);
 expect(guard.requestStop(input)).toEqual({ok:true});
 expect(guard.requestStop({...input,onStop:()=>{stops+=100;}})).toEqual({ok:true});
 await Bun.sleep(60);
 expect(stops).toBe(1);
});

test('无法确认运行计数时保守拒绝退出',()=>{
 const guard=createIdleShutdownGuard();const idle={activeJobs:0,pendingRequests:1,pendingWebSockets:0,onStop:()=>{throw new Error('unexpected stop');}};
 for(const input of [{...idle,activeJobs:NaN},{...idle,pendingRequests:-1},{...idle,pendingWebSockets:0.5}])expect(guard.requestStop(input)).toEqual({ok:false,code:'WORKSPACE_BUSY'});
 expect(guard.isStopping()).toBe(false);
});
