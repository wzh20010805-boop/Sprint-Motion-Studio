import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = join(import.meta.dir, '../../probes/desktop/workspace-cli.cjs');
function runner(source: string, extraEnv: Record<string, string> = {}) {
  expect(existsSync(helper)).toBeTrue();
  const root = mkdtempSync(join(tmpdir(), 'sfs-workspace-cli-'));
  const cli = join(root, 'apps/cli/src');
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, 'index.ts'), source);
  const { createWorkspaceCli } = require(helper);
  return { root, run: createWorkspaceCli({ runtime: process.execPath, repositoryRoot: root, env: { ...process.env, ...extraEnv } }) };
}

test('工作区子进程清除旧服务、项目路由和窗口配置，并传入明确目标', async () => {
  const { root, run } = runner(`console.log(JSON.stringify({ok:true,data:{args:process.argv.slice(2),cwd:process.cwd(),root:process.env.SFS_REPO_ROOT,page:process.env.SFS_PROBE_PATH,stale:Object.keys(process.env).filter(k=>/^(SFS_SERVICE_|SFS_TEST_|SFS_SMOKE_|P0_)/.test(k)||k==='SFS_WORKSPACE')}}));`, {
    SFS_WORKSPACE: 'old-workspace', SFS_SERVICE_URL: 'http://127.0.0.1:1', SFS_SERVICE_TOKEN: 'old-test-token',
    SFS_PROBE_PATH: '/project/old-project', SFS_PROBE_SCENARIO: 'old-scenario', SFS_TEST_VISIBLE_START: '1',
    SFS_SMOKE_PAGE: '/project/old-project', P0_PROFILE_DIR: 'old-profile', P0_EVIDENCE_DIR: 'old-evidence',
  });
  const target = join(root, '另一个工作区');
  const reply = await run(['gui', '--workspace', target]);
  expect(reply.data).toEqual({ args: ['gui', '--workspace', target, '--json'], cwd: root, root, page: '/', stale: [] });
});

test('CLI失败返回具体业务错误，非JSON输出不暴露原始内容', async () => {
  const business = runner(`console.log(JSON.stringify({ok:false,error:{message:'目标工作区无法读取'}}));process.exit(6);`);
  await expect(business.run(['workspace', 'use'])).rejects.toThrow('目标工作区无法读取');
  const invalid = runner(`console.log('private-test-token');process.exit(1);`);
  try { await invalid.run(['workspace', 'list']); throw new Error('expected rejection'); }
  catch (error) { expect(String(error)).toContain('未返回有效结果'); expect(String(error)).not.toContain('private-test-token'); }
});
