import { test, expect } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const repo = resolve(import.meta.dir, '../..');
const evidence = join(repo, 'fixtures/generated/human-ai', `task-02-probe-compat-${crypto.randomUUID()}`);
mkdirSync(evidence, { recursive: true });

test('owned P0 package main loads with only its existing packaged main and service files', () => {
  const packageRoot = join(evidence, 'owned-package');
  const appRoot = join(packageRoot, 'resources/app');
  mkdirSync(appRoot, { recursive: true });
  for (const name of ['main.cjs', 'service.ts']) copyFileSync(join(repo, 'probes/desktop', name), join(appRoot, name));
  const main = join(appRoot, 'main.cjs'), packageRequire = createRequire(main);
  expect(existsSync(join(packageRoot, 'apps/desktop/review-bootstrap.cjs'))).toBe(false);
  let reachedReadiness = false;
  const electronBoundary = { app: { setPath() {}, commandLine: { appendSwitch() {} }, on() {}, exit() {}, whenReady() { reachedReadiness = true; throw Error('TEST_READY_BOUNDARY'); } }, session: {}, BrowserWindow: class {} };
  const context = {
    require: (name: string) => name === 'electron' ? electronBoundary : packageRequire(name),
    __dirname: appRoot,
    process: { resourcesPath: join(packageRoot, 'resources'), env: { P0_EVIDENCE_DIR: join(evidence, 'owned-evidence'), P0_PROFILE_DIR: join(evidence, 'owned-profile') }, argv: ['fixture'], cwd: () => packageRoot, versions: process.versions },
    console: { log() {}, error() {} }, URL, Buffer, setTimeout, clearTimeout,
  };
  // 到达 Electron readiness 就结束夹具，不启动原生应用或后端。
  expect(() => runInNewContext(readFileSync(main, 'utf8'), context, { filename: main })).not.toThrow();
  expect(reachedReadiness).toBe(true);
});

for (const script of ['run-playback-smoke.ts', 'run-p1-smoke.ts']) {
  for (const ambient of [undefined, 'unrelated-workspace']) {
    test(`${script} sends its created workspace to Electron when ambient workspace is ${ambient ?? 'absent'}`, async () => {
      const filename = join(repo, 'probes/desktop', script);
      const source = readFileSync(filename, 'utf8').replaceAll('import.meta.dir', JSON.stringify(join(repo, 'probes/desktop')));
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      let cliWorkspace: string | undefined, desktopEnv: Record<string, string> | undefined;
      const fsBoundary = {
        mkdirSync() {}, existsSync: () => true, writeFileSync() {},
        readFileSync(path: string) {
          if (path.endsWith('service.json')) return JSON.stringify({ url: 'http://127.0.0.1:43119', token: 'test-maker-only', workspace: cliWorkspace, pid: 1, instance_id: 'fixture' });
          throw Error(`Unexpected fixture read: ${path}`);
        },
      };
      const bunBoundary = {
        version: Bun.version,
        spawn(argv: string[], options: any) {
          if (argv[0]!.endsWith('electron.exe')) { desktopEnv = options.env; throw Error('STOP_AFTER_CAPTURED_DESKTOP_LAUNCH'); }
          const workspaceIndex = argv.indexOf('--workspace');
          if (workspaceIndex < 0) throw Error('Expected explicit CLI workspace');
          cliWorkspace ??= argv[workspaceIndex + 1];
          const output = { ok: true, status: 'succeeded', project_id: 'p', data: { source_id: 's', clip_id: 'c', project: { revision: 0 }, job: { result: { frame_count: 48 } } } };
          return { exited: Promise.resolve(0), stdout: new Response(JSON.stringify(output)).body, stderr: new Response('').body };
        },
      };
      const localProcess = { execPath: process.execPath, argv: ['fixture'], env: ambient === undefined ? {} : { SFS_WORKSPACE: ambient }, exitCode: 0 };
      const nativeRequire = createRequire(filename);
      await runInNewContext(`(async () => { ${compiled}\n })()`, {
        exports: {}, require: (name: string) => name === 'node:fs' ? fsBoundary : nativeRequire(name),
        Bun: bunBoundary, process: localProcess, Buffer, console: { log() {} },
        fetch: async () => Response.json({ axis: { id: 'axis' }, steps: [{ id: 'zero' }, { id: 'one' }] }),
        Response,
      }, { filename });
      expect(typeof cliWorkspace).toBe('string');
      expect(desktopEnv).toBeDefined();
      expect(desktopEnv!.SFS_WORKSPACE).toBe(cliWorkspace!);
      expect(desktopEnv!.SFS_SERVICE_URL).toBe('http://127.0.0.1:43119');
      writeFileSync(join(evidence, `${script}-${ambient ?? 'absent'}.json`), JSON.stringify({ cliWorkspace, desktopWorkspace: desktopEnv!.SFS_WORKSPACE, ambient }, null, 2));
    });
  }
}
