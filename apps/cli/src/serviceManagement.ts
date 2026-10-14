import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from '../../server/src/runtime';
import { normalizeWorkspacePath, sameWorkspacePath } from './workspaces';

export const serviceCommands = ['service status', 'service stop', 'service clean'];
const success = (data: unknown) => ({ body: { schema_version: '1.0', ok: true, status: 'succeeded', data, error: null }, exitCode: 0 });
const blocked = (message: string) => ({ body: { schema_version: '1.0', ok: false, status: 'failed', data: null, error: { code: 'WORKSPACE_LOCKED', message } }, exitCode: 6 });

function descriptor(path: string): any {
  if (!existsSync(path)) return null;
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.instance_id === 'string' && value.instance_id ? value : undefined; }
  catch { return undefined; }
}
function validService(info: any, workspace: string) {
  return info && typeof info.workspace === 'string' && sameWorkspacePath(info.workspace,workspace) && /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) && /^[a-f0-9]{64}$/.test(info.token);
}
async function healthy(info: any) {
  try { const response = await fetch(info.url + '/api/health', { signal: AbortSignal.timeout(1000) }); const value = await response.json() as any; return response.ok && value.pid === info.pid && value.instance_id === info.instance_id; }
  catch { return false; }
}

/** 管理命令不启动后端，也不输出 token 或桌面私密描述。 */
export async function runServiceManagement(command: string, workspaceInput: string) {
  const workspace = normalizeWorkspacePath(workspaceInput), directory = join(workspace, '.sfs');
  const infoPath = join(directory, 'service.json'), lockPath = join(directory, 'service.lock');
  const info = descriptor(infoPath), lock = descriptor(lockPath);
  if (command === 'service status') {
    if (info === undefined || lock === undefined) return success({ workspace, status: 'invalid' });
    if (info && isProcessAlive(info.pid)) {
      const ready = validService(info, workspace) && await healthy(info);
      return success({ workspace, status: ready ? 'running' : 'unresponsive', pid: info.pid, ...(ready ? { url: info.url } : {}) });
    }
    if (lock && isProcessAlive(lock.pid)) return success({ workspace, status: 'starting', pid: lock.pid });
    return success({ workspace, status: info || lock ? 'stale' : 'stopped' });
  }
  if (command === 'service stop') {
    if (!info && !lock) return success({ workspace, status: 'stopped' });
    if (info !== undefined && lock !== undefined && (!info || !isProcessAlive(info.pid)) && (!lock || !isProcessAlive(lock.pid))) return success({ workspace, status: 'stopped' });
    if (!validService(info, workspace) || !await healthy(info) || (lock && (lock.pid !== info.pid || lock.instance_id !== info.instance_id))) return blocked('服务身份未确认，请先查看 service status；未终止任何进程。');
    const response = await fetch(info.url + '/api/jobs', { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000) });
    const jobs = await response.json() as any;
    if (!response.ok || !Array.isArray(jobs.jobs)) return blocked('无法核实后台任务，未停止服务。');
    if (jobs.jobs.some((job: any) => ['queued', 'running'].includes(job.status))) return blocked('工作区仍有后台任务，请等待完成或先明确取消任务。');
    // 由当前服务同步核实队列和连接并关闭入口；Windows 不使用外部强制终止。
    if (!await healthy(info) || descriptor(infoPath)?.instance_id !== info.instance_id || descriptor(lockPath)?.instance_id !== info.instance_id) return blocked('服务实例正在变化，未停止服务。');
    const stopResponse = await fetch(info.url+'/api/v1/runtime/stop',{method:'POST',headers:{Authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(2000)});
    const stopResult = await stopResponse.json() as any;
    if (!stopResponse.ok || stopResult.ok !== true) return blocked(stopResult.error?.message ?? '服务未接受安全退出请求；未强制终止。');
    const deadline = Date.now() + 5000;
    while (isProcessAlive(info.pid) && Date.now() < deadline) await Bun.sleep(50);
    if (isProcessAlive(info.pid)) return blocked('已请求退出，服务尚未退出；未强制终止。');
    return success({ workspace, status: 'stopped' });
  }
  if (command !== 'service clean') return blocked('未知服务管理命令。');
  if (!existsSync(directory)) return success({ workspace, removed: [] });
  const recoveryPath = join(directory, 'service.recovery');
  let recovery: number;
  try { recovery = openSync(recoveryPath, 'wx', 0o600); }
  catch { return blocked('服务正在启动，或启动恢复锁需要核查；未清理记录。'); }
  const removed: string[] = [];
  try {
    writeFileSync(recovery, JSON.stringify({ instance_id: 'service-clean', pid: process.pid }));
    const currentInfo = descriptor(infoPath), currentLock = descriptor(lockPath);
    if (currentInfo === undefined || currentLock === undefined || (currentInfo && !validService(currentInfo, workspace))) return blocked('服务记录损坏或归属不明，请人工核查；未清理记录。');
    if ((currentInfo && isProcessAlive(currentInfo.pid)) || (currentLock && isProcessAlive(currentLock.pid))) return blocked('工作区有活动进程；未清理服务记录。');
    if (currentInfo && currentLock && (currentInfo.pid !== currentLock.pid || currentInfo.instance_id !== currentLock.instance_id)) return blocked('服务记录与实例锁不匹配；未清理记录。');
    const privatePath = join(directory, 'desktop-bootstrap.json');
    if (!currentInfo && !currentLock && existsSync(privatePath)) return blocked('桌面记录没有可核实的旧服务归属，请人工核查。');
    // 保留数据库、素材、日志及所有候选；只删除已证明没有活动所有者的发现记录。
    for (const name of ['desktop-bootstrap.json', 'service.json', 'service.lock']) {
      const path = join(directory, name);
      if (existsSync(path)) { unlinkSync(path); removed.push(name); }
    }
    for (const name of readdirSync(directory)) {
      const match = /^service\.json(\.before-human-desktop-\d+)$/.exec(name);
      if (!match) continue;
      const historical = descriptor(join(directory,name)), previousLock = descriptor(join(directory,'service.lock'+match[1]));
      if (!validService(historical,workspace) || isProcessAlive(historical.pid) || previousLock === undefined || (previousLock && (previousLock.pid !== historical.pid || previousLock.instance_id !== historical.instance_id))) continue;
      for (const prefix of ['desktop-bootstrap.json','service.json','service.lock']) {
        const oldName = prefix+match[1], path = join(directory,oldName);
        if (existsSync(path)) { unlinkSync(path); removed.push(oldName); }
      }
    }
    return success({ workspace, removed });
  } catch (error) {
    const denied=['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');
    return {body:{schema_version:'1.0',ok:false,status:'failed',data:{workspace,removed},error:{code:denied?'CLEANUP_PERMISSION_DENIED':'WORKSPACE_CLEANUP_FAILED',message:denied?'没有权限清理部分旧连接记录；未修改文件权限，请由该工作区所有者清理。':'旧连接记录清理失败；已保留未删除的记录与所有项目数据。'}},exitCode:3};
  } finally { closeSync(recovery); unlinkSync(recoveryPath); }
}
