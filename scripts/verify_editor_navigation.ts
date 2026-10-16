import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const onionOrder = process.argv.includes('--onion-order');
const evidence = process.argv.includes('--public-runtime')?join(root,'fixtures/generated/human-ai','t12-editor-'+crypto.randomUUID().replaceAll('-','').slice(0,8)):join(root, onionOrder ? 'fixtures/generated/editor-onion-ui' : 'fixtures/generated/editor-navigation-ui', new Date().toISOString().replaceAll(':', '-'));
const electron=join(root,'probes/desktop/node_modules/electron/dist/electron.exe');
mkdirSync(evidence, { recursive: true });
// 洋葱皮探针只替换渲染终点；选择、时间轴和资产列表均运行真实组件。
const build = await Bun.build({ entrypoints: [join(root, 'probes/desktop/editor-navigation-fixture.tsx')], target: 'browser', outdir: evidence, plugins: onionOrder ? [{
  name: 'record-editor-onion-props',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]components[\\/]FrameEditor\.tsx$/ }, ({ path }) => ({
      loader: 'tsx', resolveDir: dirname(path), contents: `
        import { createElement } from 'react';
        export default function FrameEditor(props) {
          window.fixtureOnion = JSON.parse(JSON.stringify({ frame: props.frame, prev: props.prev, next: props.next, composite: props.composite }));
          return createElement('div', { id: 'onion-props-ready' });
        }
      `,
    }));
  },
}] : [] });
if (!build.success) throw new Error(build.logs.join('\n'));
const axis = { id: 'axis', project_id: 'fixture', name: '测试动作', fps: 1, idx: 0 };
const tracks = [0, 1].map(n => ({ id: `track-${n}`, axis_id: axis.id, project_id: 'fixture', name: n ? 'Overlay' : 'Main', is_primary: n ? 0 : 1, visible: 1, locked: n ? 1 : 0, idx: n }));
const steps = [0, 1, 2, 3].map(n => ({ id: `step-${n}`, axis_id: axis.id, idx: n, duration: 1 }));
const frame = (id: string, track: string | null, step: string | null, idx: number) => ({ id, project_id: 'fixture', axis_id: axis.id, track_id: track, step_id: step, idx, raw_path: 'fixture.png', processed_path: null, offset_x: 0, offset_y: 0, rotation: 0, scale: 1, opacity: 1, duration: 1, source: 'upload', status: 'ready', is_keyframe: 0, width: 32, height: 32, metadata: {} });
const frames = [0, 1, 3].map(n => frame(`frame-${n}`, 'track-0', `step-${n}`, n));
frames.push(frame('overlay', 'track-1', 'step-2', 2));
const assetFrames = [0, 1, 2].map(n => frame(`asset-${n}`, null, null, n));
if (onionOrder) {
  // 实例顺序刻意不等于步骤顺序；相同原图的资产与实例仍有不同的 ID 和变换。
  frames.splice(0, frames.length,
    { ...frame('frame-3', 'track-0', 'step-3', 0), offset_x: 77, rotation: 0.4 },
    { ...frame('frame-1', 'track-0', 'step-1', 8), offset_x: 31, offset_y: 9, scale: 1.3, rotation: 0.2 },
    { ...frame('frame-0', 'track-0', 'step-0', 9), offset_x: -44, scale: 0.8, rotation: -0.35, opacity: 0.6 },
    { ...frame('overlay', 'track-1', 'step-2', 2), offset_y: 53 },
    frame('hidden-0', 'track-hidden', 'step-0', 0),
    frame('hidden-1', 'track-hidden', 'step-1', 1));
  tracks.push({ ...tracks[1]!, id: 'track-hidden', name: 'Hidden', idx: 2, visible: 0 });
}
const mutations: { path: string; method: string; body: string }[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
  if (url.pathname === '/styles.css' || url.pathname === '/candy.css') return new Response(Bun.file(join(root, 'apps/web/src', url.pathname.slice(1))));
  if (request.method !== 'GET') {
    const body = await request.text();
    mutations.push({ path: url.pathname, method: request.method, body });
    const patched = [...frames, ...assetFrames].find(frame => url.pathname === `/api/frames/${frame.id}`);
    return Response.json(patched ? { frame: { ...patched, ...JSON.parse(body) } } : { ok: true });
  }
  if (url.pathname === '/fixture/mutations') return Response.json(mutations.filter(m => m.path !== '/api/settings/layout'));
  if (onionOrder && url.pathname === '/fixture/data') return Response.json({ axis, tracks, steps, frames, assetFrames });
  if (url.pathname === '/api/projects/fixture') return Response.json({ project: { id: 'fixture', name: '逐帧预览测试', kind: 'frame', fps: 1 } });
  if (url.pathname === '/api/projects/fixture/timeline') return Response.json({ axis, axes: [axis], tracks, steps, frames, effects: [], poolFrames: assetFrames, assetFrames });
  if (url.pathname === '/api/v1/collaboration/action') return Response.json({ok:true,data:{mode:'legacy',tasks:[],timing:null}});
  if (url.pathname === '/api/settings') return Response.json({});
  if (url.pathname.endsWith('/image.png')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3QQQ0AMAgEwVJdKMYkBBV85gzsZaKz+h3uX8YdIECAAAECBAgQIECAAAECBFZgAKv/AySb4DmAAAAAAElFTkSuQmCC', 'base64'), { headers: { 'Content-Type': 'image/png' } });
  if (url.pathname.startsWith('/fonts/')) return new Response(Bun.file(join(root, 'apps/web/public', url.pathname)));
  return new Response('Fixture route not found', { status: 404 });
} });
try {
  const child = Bun.spawn([electron, join(root, onionOrder ? 'probes/desktop/editor-onion-check.cjs' : 'probes/desktop/editor-navigation-check.cjs')], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDITOR_CHECK_URL: server.url.toString(), EDITOR_CHECK_OUTPUT: evidence } });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, 'command-output.txt'), out + '\n' + err);
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ exit, evidence, ...report }, null, 2));
  process.exitCode = exit;
} finally { await server.stop(true); writeFileSync(join(evidence,'fixture-lifecycle.json'),JSON.stringify({electron_awaited:true,listener_stop_awaited:true,pending_requests:server.pendingRequests})); }
