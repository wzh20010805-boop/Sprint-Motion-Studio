import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const helper = join(import.meta.dir, '../../probes/desktop/workspace-menu.cjs');
type Item = { id?: string; label?: string; role?: string; type?: string; enabled?: boolean; checked?: boolean; submenu?: Item[]; click?: () => Promise<unknown> };
const success = (data: unknown = {}) => ({ schema_version: '1.0', ok: true, status: 'succeeded', data, error: null });

async function fixture(options: { registered?: boolean; omitCurrent?: boolean; listFailure?: boolean; cli?: (args: string[]) => Promise<any>; onSwitched?: (target: string) => Promise<void> } = {}) {
  expect(existsSync(helper)).toBeTrue();
  const { installWorkspaceMenu } = require(helper);
  const root = mkdtempSync(join(tmpdir(), 'sfs-workspace-menu-'));
  const current = join(root, '当前 工作区'), target = join(root, '目标 工作区');
  mkdirSync(current); mkdirSync(target);
  const missing = join(root, '已移除'), file = join(root, 'file.txt'); writeFileSync(file, 'not a workspace');
  const commands: string[][] = [], events: string[] = [], errors: Error[] = [], dialogs: any[] = [];
  const visibility: boolean[] = [], autoHide: boolean[] = [];
  let installed: any, picker = { canceled: true, filePaths: [] as string[] }, closes = 0;
  const window = {
    setMenu(menu: any) { installed = menu; },
    setMenuBarVisibility(value: boolean) { visibility.push(value); },
    setAutoHideMenuBar(value: boolean) { autoHide.push(value); },
    close() { closes++; }, destroy() { closes++; },
  };
  const find = (items: Item[], id: string): Item | undefined => {
    for (const item of items) { if (item.id === id) return item; const nested = item.submenu && find(item.submenu, id); if (nested) return nested; }
  };
  const Menu = {
    buildFromTemplate(template: Item[]) {
      const copy = (items: Item[]): Item[] => items.map(item => ({ ...item, ...(item.submenu ? { submenu: copy(item.submenu) } : {}) }));
      const native = copy(template);
      return { template: native, getMenuItemById: (id: string) => find(native, id) };
    },
    setApplicationMenu(menu: any) { installed = menu; },
  };
  const entries = [
    { name: '当前项目素材', path: current, registered: options.registered !== false, current: false, default: false, exists: true, service: { status: 'running', pid: 100, url: 'http://127.0.0.1:1234' } },
    { name: '另一个已登记素材', path: target, registered: true, current: true, default: false, exists: true, service: { status: 'stopped' } },
    { name: '失效目录', path: missing, registered: true, current: false, default: false, exists: false, service: { status: 'stopped' } },
    { name: '普通文件', path: file, registered: true, current: false, default: false, exists: true, service: { status: 'stopped' } },
  ];
  const api = await installWorkspaceMenu({
    Menu, dialog: { async showOpenDialog(parent: any, config: any) { expect(parent).toBe(window); dialogs.push(config); return picker; } },
    window, workspace: current,
    runCli: async (args: string[]) => {
      commands.push([...args]);
      if (args[0] === 'workspace' && args[1] === 'list') {
        if (options.listFailure) throw new Error('登记暂时不可读');
        return success({ current: target, registry: join(root, '.sfs/workspaces.json'), entries: options.omitCurrent ? entries.slice(1) : entries });
      }
      events.push(args[0] === 'gui' ? 'gui' : 'use');
      return options.cli ? options.cli(args) : success({ workspace: args.at(-1) });
    },
    onSwitched: async (workspace: string) => { events.push('notified'); await options.onSwitched?.(workspace); },
    onError: (error: Error) => errors.push(error),
  });
  commands.length = 0;
  const switchItem = installed.getMenuItemById('switch-workspace') as Item;
  return { ...api, root, current: realpathSync(current), target: realpathSync(target), commands, events, errors, dialogs, visibility, autoHide, installed, switchItem, get closes() { return closes; }, choose(value: typeof picker) { picker = value; } };
}

test('常显素材工坊菜单显示实际窗口工作区，保留常规菜单角色并过滤无效目录', async () => {
  const f = await fixture();
  expect(f.template[0].label).toBe('素材工坊');
  expect(f.currentName).toBe('当前项目素材');
  const display = f.template[0].submenu.filter((item: Item) => item.enabled === false);
  expect(display.some((item: Item) => item.label?.includes('当前项目素材'))).toBeTrue();
  expect(display.some((item: Item) => item.label?.includes(f.current))).toBeTrue();
  expect(f.autoHide).toEqual([false]); expect(f.visibility).toEqual([true]);
  expect(f.template.map((item: Item) => item.role).filter(Boolean)).toEqual(['editMenu', 'viewMenu', 'windowMenu']);
  expect(f.switchItem.label).toBe('切换工作区');
  expect(f.switchItem.submenu?.[0]).toMatchObject({ enabled: false, label: '在新窗口打开，当前窗口和后台任务保留' });
  const choices = f.switchItem.submenu!.filter(item => item.type === 'radio');
  expect(choices.map(item => ({ label: item.label, checked: item.checked }))).toEqual([
    { label: '当前项目素材', checked: true }, { label: '另一个已登记素材', checked: false },
  ]);
});

test('未登记的当前目录以真实目录名称显示，不采用 selected 提示名称', async () => {
  const f = await fixture({ registered: false });
  expect(f.currentName).toBe(basename(f.current));
});

test('显式启动的未登记工作区不在列表中时仍有正确勾选的当前目录', async () => {
  const f = await fixture({ omitCurrent: true });
  expect(f.currentName).toBe(basename(f.current));
  const choices = f.switchItem.submenu!.filter(item => item.type === 'radio');
  expect(choices.map(item => ({ label: item.label, checked: item.checked }))).toEqual([
    { label: '另一个已登记素材', checked: false }, { label: basename(f.current), checked: true },
  ]);
});

test('切换先打开目标 GUI，再持久化选择，最后通知且保留旧窗口', async () => {
  const f = await fixture();
  expect(await f.switchTo(f.target)).toMatchObject({ status: 'opened', workspace: f.target });
  expect(f.commands).toEqual([['gui', '--workspace', f.target], ['workspace', 'use', '--directory', f.target]]);
  expect(f.events).toEqual(['gui', 'use', 'notified']);
  expect(f.closes).toBe(0); expect(f.errors).toEqual([]);
});

test('同目录和目录链接均不启动 GUI 或修改登记', async () => {
  const f = await fixture();
  const alias = join(f.root, 'alias'); symlinkSync(f.current, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await f.switchTo(join(f.current, '.'))).status).toBe('unchanged');
  expect((await f.switchTo(alias)).status).toBe('unchanged');
  expect(f.commands).toEqual([]); expect(f.events).toEqual([]);
});

for (const stage of ['gui', 'use', 'notified'] as const) {
  test(`${stage} 阶段未完成时重复点击不会启动另一轮切换`, async () => {
    let resume!: () => void, arrive!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const f = await fixture({
      cli: async args => { if (stage === (args[0] === 'gui' ? 'gui' : 'use')) { arrive(); await gate; } return success(); },
      onSwitched: async () => { if (stage === 'notified') { arrive(); await gate; } },
    });
    const pending = f.switchTo(f.target);
    await arrived;
    expect((await f.switchTo(f.target)).status).toBe('busy');
    expect(f.commands).toEqual(stage === 'gui' ? [['gui', '--workspace', f.target]] : [['gui', '--workspace', f.target], ['workspace', 'use', '--directory', f.target]]);
    resume(); await pending;
    expect(f.events).toEqual(['gui', 'use', 'notified']);
  });
}

test('目录选择取消不改变当前选择，选择器只允许已有文件夹', async () => {
  const f = await fixture();
  const pickerItem = f.switchItem.submenu!.find(item => item.id === 'choose-workspace-directory')!;
  await pickerItem.click!();
  expect(f.dialogs).toHaveLength(1);
  expect(f.dialogs[0]).toMatchObject({ defaultPath: f.current, properties: ['openDirectory'] });
  expect(f.commands).toEqual([]); expect(f.events).toEqual([]);
  expect(f.switchItem.submenu!.filter(item => item.type === 'radio').map(item => item.checked)).toEqual([true, false]);
});

test('菜单绑定可打开已登记工作区，也可打开用户选择的真实目录', async () => {
  const f = await fixture();
  const radios = f.switchItem.submenu!.filter(item => item.type === 'radio');
  radios[0].checked = false; radios[1].checked = true;
  await radios[1].click!();
  expect(f.commands).toEqual([['gui', '--workspace', f.target], ['workspace', 'use', '--directory', f.target]]);
  expect(radios.map(item => item.checked)).toEqual([true, false]);
  f.commands.length = 0;
  f.choose({ canceled: false, filePaths: [f.target] });
  await f.switchItem.submenu!.find(item => item.id === 'choose-workspace-directory')!.click!();
  expect(f.commands).toEqual([['gui', '--workspace', f.target], ['workspace', 'use', '--directory', f.target]]);
  expect(f.closes).toBe(0);
});

for (const step of ['gui', 'use'] as const) {
  test(`${step} 业务失败不继续成功通知，不关闭旧窗口且释放 busy`, async () => {
    let failing = true;
    const f = await fixture({ cli: async args => failing && (step === 'gui' ? args[0] === 'gui' : args[0] === 'workspace')
      ? { schema_version: '1.0', ok: false, status: 'failed', data: null, error: { code: 'UNAVAILABLE', message: '目标暂时不可用' } }
      : success() });
    expect((await f.switchTo(f.target)).status).toBe('failed');
    expect(f.commands).toEqual(step === 'gui' ? [['gui', '--workspace', f.target]] : [['gui', '--workspace', f.target], ['workspace', 'use', '--directory', f.target]]);
    expect(f.events).not.toContain('notified'); expect(f.closes).toBe(0);
    expect(String(f.errors[0])).toContain('目标暂时不可用');
    failing = false;
    expect((await f.switchTo(f.target)).status).toBe('opened');
  });
}

test('CLI进程异常通过错误回调报告，旧窗口与登记保持不动', async () => {
  const f = await fixture({ cli: async () => { throw new Error('启动失败'); } });
  expect((await f.switchTo(f.target)).status).toBe('failed');
  expect(f.commands).toEqual([['gui', '--workspace', f.target]]);
  expect(String(f.errors[0])).toContain('启动失败'); expect(f.closes).toBe(0);
});

test('目录消失时在启动前报告，不能通过切换隐式创建工作区', async () => {
  const f = await fixture(), missing = join(f.root, '未创建');
  expect((await f.switchTo(missing)).status).toBe('failed');
  expect(f.commands).toEqual([]); expect(existsSync(missing)).toBeFalse();
  expect(f.errors).toHaveLength(1); expect(f.closes).toBe(0);
});

test('登记读取失败仍安装菜单和目录选择入口，并报告错误', async () => {
  const f = await fixture({ listFailure: true });
  expect(f.currentName).toBe(basename(f.current));
  expect(f.switchItem.submenu!.some(item => item.id === 'choose-workspace-directory')).toBeTrue();
  expect(String(f.errors[0])).toContain('登记暂时不可读');
});
