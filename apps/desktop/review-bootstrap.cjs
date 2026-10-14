const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');

// 按工作区保留界面偏好；每次打开都重做当前实例握手，旧 Cookie 不提供能力。
const desktopPartition = workspace => 'persist:sfs-' + createHash('sha256').update(process.platform === 'win32' ? path.resolve(workspace).toLowerCase() : path.resolve(workspace)).digest('hex');
const failure = code => new Error(code);
function pipeRequest(pipe, body) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe); let bytes = Buffer.alloc(0), finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(3000, () => finish(failure('DESKTOP_BOOTSTRAP_TIMEOUT')));
    socket.on('error', () => finish(failure('DESKTOP_BOOTSTRAP_UNAVAILABLE')));
    socket.on('end', () => { if (!finished) finish(failure('DESKTOP_BOOTSTRAP_TRUNCATED')); });
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 4096) return finish(failure('DESKTOP_BOOTSTRAP_FRAME'));
      const end = bytes.indexOf(10); if (end < 0) return;
      try {
        if (end !== bytes.length - 1) throw failure('DESKTOP_BOOTSTRAP_FRAME');
        const result = JSON.parse(bytes.subarray(0, end).toString('utf8'));
        if (result.code) return finish(failure('DESKTOP_BOOTSTRAP_REJECTED'));
        finish(null, result);
      } catch { finish(failure('DESKTOP_BOOTSTRAP_FRAME')); }
    });
  });
}
async function verifyLive(info, workspace) {
  if (!info || !/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) || !/^[a-f0-9]{64}$/.test(info.token) ||
      !Number.isSafeInteger(info.pid) || path.resolve(info.workspace) !== path.resolve(workspace)) throw failure('DESKTOP_SERVICE_IDENTITY');
  const response = await fetch(info.url + '/api/health', { signal: AbortSignal.timeout(2000) });
  const health = await response.json();
  if (!response.ok || health.pid !== info.pid || health.instance_id !== info.instance_id) throw failure('DESKTOP_SERVICE_IDENTITY');
}
async function obtainDesktopReviewSession(workspace, expectedInfo) {
  const info = JSON.parse(fs.readFileSync(path.join(workspace, '.sfs/service.json'), 'utf8'));
  if (expectedInfo && ['instance_id', 'pid', 'url', 'token'].some(key => expectedInfo[key] !== undefined && info[key] !== expectedInfo[key])) throw failure('DESKTOP_SERVICE_IDENTITY');
  await verifyLive(info, workspace);
  const configResponse = await fetch(info.url + '/api/config', { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000) });
  if (!configResponse.ok || (await configResponse.json()).sfs?.production_api_version !== '1.2') throw failure('BACKEND_VERSION_CONFLICT');
  const descriptor = JSON.parse(fs.readFileSync(path.join(workspace, '.sfs/desktop-bootstrap.json'), 'utf8'));
  const expectedPipe = process.platform === 'win32' ? `\\\\.\\pipe\\sfs-review-${info.instance_id}` : path.join(workspace, '.sfs', `review-${info.instance_id}.sock`);
  if (descriptor.instance_id !== info.instance_id || descriptor.pid !== info.pid || descriptor.pipe_name !== expectedPipe ||
      !/^[a-f0-9]{64}$/.test(descriptor.bootstrap_secret) || !Number.isFinite(Date.parse(descriptor.created_at)) ||
      Date.parse(descriptor.created_at) > Date.now() + 5000) throw failure('DESKTOP_BOOTSTRAP_IDENTITY');
  const common = { instance_id: info.instance_id, desktop_pid: process.pid };
  const issued = await pipeRequest(descriptor.pipe_name, { ...common, method: 'issue', bootstrap_secret: descriptor.bootstrap_secret });
  if (!/^[a-f0-9]{64}$/.test(issued.nonce)) throw failure('DESKTOP_BOOTSTRAP_NONCE');
  // nonce 消费前再次确认活跃服务，重启不能连接到旧描述。
  await verifyLive(info, workspace);
  const consumed = await pipeRequest(descriptor.pipe_name, { ...common, method: 'consume', nonce: issued.nonce });
  if (!/^[a-f0-9]{64}$/.test(consumed.reviewer_cookie)) throw failure('DESKTOP_BOOTSTRAP_COOKIE');
  return { info, instance_id: info.instance_id, reviewer_cookie: consumed.reviewer_cookie };
}
async function initializeDesktopSession(electronSession, workspace, expectedInfo) {
  const result = await obtainDesktopReviewSession(workspace, expectedInfo);
  const target = electronSession.fromPartition(desktopPartition(workspace));
  await target.cookies.set({ url: result.info.url + '/', name: 'sfs_token', value: result.info.token, httpOnly: true, sameSite: 'strict', path: '/' });
  await target.cookies.set({ url: result.info.url + '/', name: 'sfs_reviewer', value: result.reviewer_cookie, httpOnly: true, sameSite: 'strict', path: '/' });
  return { session: target, info: result.info };
}
module.exports = { obtainDesktopReviewSession, initializeDesktopSession, desktopPartition };
