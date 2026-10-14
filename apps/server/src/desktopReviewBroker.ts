import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clearLocalSessions, equalLocalSecret, issueReviewerSession, LocalAuthError } from './localSessions';

const TTL = 30_000, MAX_FRAME = 4096;
type Nonce = { pid: number; expires: number; consumed: boolean };
let current: { instance: string; secret: string; nonces: Map<string, Nonce> } | undefined;
const fail = (code: string): never => { throw new LocalAuthError(code, 403); };
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;

export async function issueDesktopLaunchNonce(bootstrapSecret: string, desktopPid: number): Promise<{ nonce: string }> {
  if (!current || !equalLocalSecret(bootstrapSecret, current.secret)) fail('BOOTSTRAP_UNAUTHORIZED');
  if (!validPid(desktopPid)) fail('BOOTSTRAP_INVALID_REQUEST');
  for (const [key, value] of current!.nonces) if (Date.now() > value.expires + TTL) current!.nonces.delete(key);
  if (current!.nonces.size >= 1024) fail('BOOTSTRAP_CAPACITY');
  const nonce = randomBytes(32).toString('hex');
  current!.nonces.set(nonce, { pid: desktopPid, expires: Date.now() + TTL, consumed: false });
  return { nonce };
}
export async function consumeDesktopLaunchNonce(nonce: string, desktopPid: number): Promise<{ reviewer_cookie: string }> {
  if (!validPid(desktopPid)) fail('BOOTSTRAP_INVALID_REQUEST');
  const value = current?.nonces.get(nonce);
  if (!value) fail('BOOTSTRAP_INVALID_NONCE');
  if (value!.consumed) fail('BOOTSTRAP_REPLAY');
  if (Date.now() > value!.expires) fail('BOOTSTRAP_EXPIRED');
  if (value!.pid !== desktopPid) fail('BOOTSTRAP_PID_MISMATCH');
  // 在任何异步边界前标记，两个连接不能重复消费。
  value!.consumed = true;
  return { reviewer_cookie: issueReviewerSession(current!.instance) };
}

/** 文件尚无秘密时收紧 DACL；验明后才写秘密，不依赖 Windows 的 POSIX mode。 */
function protectDescriptor(path: string) {
  if (process.platform !== 'win32') return;
  const script = `$ErrorActionPreference='Stop'; $reason='DACL_SETUP'; try {
    $p=$env:SFS_DESCRIPTOR_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $reason='DACL_READ_OWNER'; $owner=[System.IO.File]::GetAccessControl($p).GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    $reason='DACL_SETUP'; $acl=New-Object System.Security.AccessControl.FileSecurity;
    $acl.SetAccessRuleProtection($true,$false);
    foreach($id in @($sid.Value,'S-1-5-18')) {
      $identity=New-Object System.Security.Principal.SecurityIdentifier($id);
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow');
      $acl.AddAccessRule($rule);
    };
    $reason='DACL_APPLY'; if($owner -ne $sid.Value){$acl.SetOwner($sid)};
    [System.IO.File]::SetAccessControl($p,$acl);
    $reason='DACL_READ'; $actual=[System.IO.File]::GetAccessControl($p);
    $reason='DACL_OWNER'; if($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw $reason};
    $reason='DACL_NOT_PROTECTED'; if(!$actual.AreAccessRulesProtected){throw $reason};
    $reason='DACL_UNEXPECTED_ACE'; foreach($ace in $actual.Access){
      $id=$ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
      if($id -notin @($sid.Value,'S-1-5-18') -or $ace.AccessControlType -ne 'Allow'){throw $reason};
    };
    $reason='DACL_EMPTY'; if(@($actual.Access).Count -lt 1){throw $reason};
  } catch { [Console]::Error.WriteLine($reason); exit 1 };`;
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 10000, env: { ...process.env, SFS_DESCRIPTOR_PATH: path }, encoding: 'utf8',
  });
  if (result.status !== 0) {
    // 只返回固定阶段或系统错误码，避免原始 PowerShell 错误包含路径及敏感内容。
    const stage = result.stderr?.match(/(?:^|\r?\n)(DACL_(?:SETUP|APPLY|READ_OWNER|READ|OWNER|NOT_PROTECTED|UNEXPECTED_ACE|EMPTY))(?=\r?\n|$)/)?.[1];
    const systemCode = result.error && 'code' in result.error && typeof result.error.code === 'string' ? result.error.code : '';
    const reason = systemCode.match(/^[A-Z][A-Z0-9_]{1,40}$/)?.[0] ??
      stage ?? 'DACL_VERIFICATION_FAILED';
    throw new Error(`BOOTSTRAP_DESCRIPTOR_PERMISSIONS: ${reason}`);
  }
}

export async function startDesktopReviewBroker(instanceId: string): Promise<{ pipe_name: string; close(): void }> {
  if (current || !/^[a-zA-Z0-9-]+$/.test(instanceId)) throw new Error('BOOTSTRAP_ALREADY_STARTED');
  const directory = join(resolve(process.env.SFS_WORKSPACE!), '.sfs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'desktop-bootstrap.json');
  const pipe_name = process.platform === 'win32' ? `\\\\.\\pipe\\sfs-review-${instanceId}` : join(directory, `review-${instanceId}.sock`);
  const state = { instance: instanceId, secret: randomBytes(32).toString('hex'), nonces: new Map<string, Nonce>() };
  current = state;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    let buffer = Buffer.alloc(0), done = false;
    const reply = (value: unknown) => { if (done) return; done = true; socket.end(JSON.stringify(value) + '\n'); };
    const deadline = setTimeout(() => { reply({ code: 'BOOTSTRAP_TIMEOUT' }); socket.destroySoon(); }, 3000);
    socket.on('close', () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.on('data', async chunk => {
      if (done) return;
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_FRAME) return reply({ code: 'BOOTSTRAP_FRAME_TOO_LARGE' });
      const end = buffer.indexOf(10); if (end < 0) return;
      if (end !== buffer.length - 1) return reply({ code: 'BOOTSTRAP_INVALID_REQUEST' });
      try {
        const request = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        if (!request || request.instance_id !== state.instance || current !== state) fail('BOOTSTRAP_INSTANCE_MISMATCH');
        if (!validPid(request.desktop_pid)) fail('BOOTSTRAP_INVALID_REQUEST');
        // 一连接一请求；先停止接收，再执行异步响应。
        socket.pause();
        if (request.method === 'issue' && typeof request.bootstrap_secret === 'string') reply(await issueDesktopLaunchNonce(request.bootstrap_secret, request.desktop_pid));
        else if (request.method === 'consume' && typeof request.nonce === 'string') reply(await consumeDesktopLaunchNonce(request.nonce, request.desktop_pid));
        else fail('BOOTSTRAP_INVALID_REQUEST');
      } catch (error) { reply({ code: error instanceof LocalAuthError ? error.code : 'BOOTSTRAP_INVALID_REQUEST' }); }
    });
  });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy(); server.close();
    if (current === state) { current = undefined; state.nonces.clear(); clearLocalSessions(instanceId); }
    try { if (JSON.parse(readFileSync(path, 'utf8')).instance_id === instanceId) unlinkSync(path); } catch { /* 只移除自己的描述 */ }
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe_name, resolve); });
    // 先写无秘密的实例标识，启动失败仍能按实例归属清理。
    writeFileSync(path, JSON.stringify({ instance_id: instanceId }), { mode: 0o600 });
    protectDescriptor(path);
    writeFileSync(path, JSON.stringify({ schema_version: '1.0', instance_id: instanceId, pid: process.pid, created_at: new Date().toISOString(), pipe_name, bootstrap_secret: state.secret }));
    return { pipe_name, close };
  } catch (error) { close(); throw error; }
}
