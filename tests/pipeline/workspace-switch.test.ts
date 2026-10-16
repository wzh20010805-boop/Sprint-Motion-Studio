import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const windowsTest = process.platform === 'win32' ? test : test.skip;
windowsTest('旧窗口环境切换到另一真实工作区时，目标窗口身份独立、旧服务和生产登记保留', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const root = join(repo, 'fixtures/generated/workspace-switch', crypto.randomUUID());
  const fixtureRepo = join(root, 'repo');
  const first = join(root, '讲解员工作区'), second = join(root, '小兵工作区');
  for (const dir of [fixtureRepo, first, second, join(fixtureRepo, '.sfs')]) mkdirSync(dir, { recursive: true });
  for (const name of ['apps', 'probes']) symlinkSync(join(repo, name), join(fixtureRepo, name), 'junction');
  symlinkSync(resolve(repo, '../.runtime'), join(root, '.runtime'), 'junction');
  const registry = join(fixtureRepo, '.sfs/workspaces.json');
  writeFileSync(registry, JSON.stringify({ schema_version: 1, current: first, workspaces: [{ name: '讲解员', path: first }, { name: '小兵', path: second }] }));
  const productionRegistry = join(repo, '.sfs/workspaces.json');
  const originalSelection = existsSync(productionRegistry) ? readFileSync(productionRegistry, 'utf8') : null;
  const { createWorkspaceCli } = require(join(repo, 'probes/desktop/workspace-cli.cjs'));
  const run = createWorkspaceCli({ runtime: process.execPath, repositoryRoot: fixtureRepo, env: { ...process.env, SFS_WORKSPACE: first, SFS_SERVICE_URL: 'http://127.0.0.1:1', SFS_SERVICE_TOKEN: 'old-test-token', P0_PROFILE_DIR: join(first, 'wrong-profile'), SFS_PROBE_PATH: '/project/old-project', SFS_TEST_VISIBLE_START: '1' } });
  let guiPid: number | undefined;
  try {
    await run(['project', 'create', '--workspace', first, '--name', '原窗口项目']);
    const oldService = JSON.parse(readFileSync(join(first, '.sfs/service.json'), 'utf8'));
    const launched = await run(['gui', '--workspace', second]);
    guiPid = launched.data.pid;
    const receipt = join(second, '.sfs/gui-evidence/workspace-menu.json');
    for (let i = 0; i < 200 && !existsSync(receipt); i++) await Bun.sleep(100);
    expect(existsSync(receipt)).toBeTrue();
    // 普通用户窗口不能因开发探针截图失败而在首屏加载后自行退出。
    await Bun.sleep(2500);
    let windowAlive = true;
    try { process.kill(guiPid!, 0); } catch { windowAlive = false; }
    expect(windowAlive).toBeTrue();
    const menu = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(menu).toMatchObject({ visible: true, switchLabel: '切换工作区', workspace: second, currentName: '小兵', pagePath: '/' });
    const targetService = JSON.parse(readFileSync(join(second, '.sfs/service.json'), 'utf8'));
    expect(targetService.instance_id).not.toBe(oldService.instance_id);
    expect(targetService.workspace).toBe(second);
    expect((await fetch(oldService.url + '/api/health')).ok).toBeTrue();
    await run(['workspace', 'use', '--directory', second]);
    expect(JSON.parse(readFileSync(registry, 'utf8')).current).toBe(second);
    expect(existsSync(join(first, 'wrong-profile'))).toBe(false);
    writeFileSync(join(root, 'verification.json'), JSON.stringify({ menu, old_service_preserved: true, independent_service: true, production_registry_unchanged: originalSelection === (existsSync(productionRegistry) ? readFileSync(productionRegistry, 'utf8') : null) }, null, 2));
  } finally {
    // 只结束本测试新建目录中的进程，保留工作区和日志证据。
    if (guiPid) { try { process.kill(guiPid); } catch {} }
    for (const workspace of [first, second]) {
      const service = join(workspace, '.sfs/service.json');
      if (existsSync(service)) { try { process.kill(JSON.parse(readFileSync(service, 'utf8')).pid); } catch {} }
    }
    expect(existsSync(productionRegistry) ? readFileSync(productionRegistry, 'utf8') : null).toBe(originalSelection);
  }
}, 45000);
