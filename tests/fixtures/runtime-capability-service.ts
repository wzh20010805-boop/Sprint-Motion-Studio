// 仅测试入口：先运行真实锁/bootstrap，再追加受角色保护的测试动作。
await import('../../apps/server/src/runtimeBootstrap');
const { app } = await import('../../apps/server/src/app');
const { getRequestActor, requireRole, LocalAuthError } = await import('../../apps/server/src/localSessions');
app.post('/__fixture/review', ({ request }) => {
 try { const actor=getRequestActor(request);requireRole(actor,'reviewer');return {role:actor.role}; }
 catch(error){const failure=error as InstanceType<typeof LocalAuthError>;return Response.json({code:failure.code},{status:failure.status??500});}
});
app.compile();
console.log('CAPABILITY_FIXTURE_READY');
