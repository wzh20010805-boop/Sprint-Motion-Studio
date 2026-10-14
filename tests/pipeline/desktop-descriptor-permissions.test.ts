import { expect, test } from 'bun:test';
import { runCollaborationScript } from './collaborationFixtures';

test('desktop bootstrap publishes its secret only with a private descriptor owned by the current user', async () => {
  const result = await runCollaborationScript(`
    import assert from 'node:assert/strict';
    import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { spawnSync } from 'node:child_process';
    // Unix socket 路径上限较短，独立使用短临时目录。
    if (process.platform !== 'win32') process.env.SFS_WORKSPACE = mkdtempSync(join(tmpdir(), 'sfs-desc-'));
    const directory = join(process.env.SFS_WORKSPACE, '.sfs');
    const path = join(directory, 'desktop-bootstrap.json');
    mkdirSync(directory, { recursive: true });
    const powershell = script => {
      const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 10000, env: { ...process.env, SFS_DESCRIPTOR_PATH: path }, encoding: 'utf8',
      });
      assert.equal(result.status, 0, 'fixture ACL operation failed');
      return JSON.parse(result.stdout.trim());
    };
    if (process.platform === 'win32') {
      writeFileSync(path, '{}');
      // 提权启动时模拟 runner 的管理员组所有者；普通用户仍验证实际文件权限。
      const fixture = powershell(\`
        $ErrorActionPreference='Stop'; $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
        $principal=New-Object System.Security.Principal.WindowsPrincipal($identity);
        $admin=$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);
        if($admin) {
          $acl=[System.IO.File]::GetAccessControl($env:SFS_DESCRIPTOR_PATH);
          $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')));
          [System.IO.File]::SetAccessControl($env:SFS_DESCRIPTOR_PATH,$acl);
        } else {
          $acl=New-Object System.Security.AccessControl.FileSecurity;
          $acl.SetAccessRuleProtection($true,$false);
          $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User,'Modify','Allow')));
          $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
          $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl','Allow')));
          [System.IO.File]::SetAccessControl($env:SFS_DESCRIPTOR_PATH,$acl);
        };
        @{ administrators_owner_fixture=$admin } | ConvertTo-Json -Compress;
      \`);
      console.log('administrators_owner_fixture=' + fixture.administrators_owner_fixture);
    }
    const { startDesktopReviewBroker } = await import('./apps/server/src/desktopReviewBroker');
    const instance = crypto.randomUUID();
    const broker = await startDesktopReviewBroker(instance);
    try {
      const descriptor = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(descriptor.instance_id, instance);
      assert.match(descriptor.bootstrap_secret, /^[0-9a-f]{64}$/);
      if (process.platform === 'win32') {
        const actual = powershell(\`
          $ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
          $acl=[System.IO.File]::GetAccessControl($env:SFS_DESCRIPTOR_PATH);
          $aces=@($acl.Access | ForEach-Object { @{ sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; rights=[int]$_.FileSystemRights; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited } });
          @{ user=$sid; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; aces=$aces } | ConvertTo-Json -Depth 4 -Compress;
        \`);
        assert.equal(actual.owner, actual.user);
        assert.equal(actual.protected, true);
        assert.deepEqual(actual.aces.map(ace => ace.sid).sort(), [actual.user, 'S-1-5-18'].sort());
        for (const ace of actual.aces) {
          assert.equal(ace.type, 'Allow');
          assert.equal(ace.inherited, false);
          assert.equal(ace.rights, 2032127);
        }
      } else {
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
      console.log('descriptor_privacy_verified');
    } finally { broker.close(); }
    assert.equal(existsSync(path), false);
  `, 'desktop-descriptor');
  expect(result.stderr).toBe('');
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toContain('descriptor_privacy_verified');
}, 30000);

test.skipIf(process.platform !== 'win32')('descriptor permission failures report a safe reason and do not publish a secret', async () => {
  const result = await runCollaborationScript(`
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    const { startDesktopReviewBroker } = await import('./apps/server/src/desktopReviewBroker');
    const systemRoot = process.env.SystemRoot;
    process.env.SystemRoot = join(process.env.SFS_WORKSPACE, 'sensitive-failure-sentinel');
    try {
      await assert.rejects(startDesktopReviewBroker(crypto.randomUUID()), error => {
        assert.equal(error.message, 'BOOTSTRAP_DESCRIPTOR_PERMISSIONS: ENOENT');
        assert.equal(error.message.includes('sensitive-failure-sentinel'), false);
        return true;
      });
      assert.equal(existsSync(join(process.env.SFS_WORKSPACE, '.sfs/desktop-bootstrap.json')), false);
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    }
    const broker = await startDesktopReviewBroker(crypto.randomUUID());
    broker.close();
    console.log('permission_failure_verified');
  `, 'desktop-descriptor-failure');
  expect(result.stderr).toBe('');
  expect(result.exit_code).toBe(0);
  expect(result.stdout).toContain('permission_failure_verified');
}, 30000);
