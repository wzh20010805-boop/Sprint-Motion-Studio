import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const evidence = join(root, 'fixtures/generated/editor-frame-delete-ui', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(evidence, { recursive: true });
const build = await Bun.build({ entrypoints: [join(root, 'probes/desktop/editor-navigation-fixture.tsx')], target: 'browser', outdir: evidence });
if (!build.success) throw new Error(build.logs.join('\n'));
const axis = { id: 'axis', project_id: 'fixture', name: '测试动作', fps: 1, idx: 0 };
const tracks = [0, 1].map(n => ({ id: `track-${n}`, axis_id: axis.id, project_id: 'fixture', name: n ? 'Overlay' : 'Main', is_primary: n ? 0 : 1, visible: 1, locked: n ? 1 : 0, idx: n }));
const initialSteps = [0, 1, 2, 3].map(n => ({ id: `step-${n}`, axis_id: axis.id, idx: n, duration: n + 1 }));
let steps = structuredClone(initialSteps);
const frame = (id: string, track: string | null, step: string | null, idx: number) => ({ id, project_id: 'fixture', axis_id: axis.id, track_id: track, step_id: step, is_asset: 0, idx, raw_path: 'fixture.png', processed_path: null, offset_x: idx + 3, offset_y: 4, rotation: 0.1, scale: 1.2, opacity: 0.8, duration: 1, source: 'upload', status: 'ready', is_keyframe: 0, width: 32, height: 32, metadata: { source: 'retained' } });
const initialFrames = [0, 1, 3].map(n => frame(`frame-${n}`, 'track-0', `step-${n}`, n));
initialFrames.push(frame('overlay-0', 'track-1', 'step-0', 0), frame('overlay-2', 'track-1', 'step-2', 2));
const assetFrames = [0, 1, 2].map(n => frame(`asset-${n}`, null, null, n));
const effects = [{ id: 'effect-0', project_id: 'fixture', track_id: 'track-0', step_id: 'step-0', created_at: 1, effect: { strokes: [{ color: '#ff8a18', size: 4, brush: 'slash', points: [{ x: 0, y: 0, pressure: 1 }, { x: 10, y: 0, pressure: 1 }] }], offset_x: 0, offset_y: 0, rotation: 0, scale: 1, opacity: 1, style: 'flame' } }];
let frames = structuredClone(initialFrames);
let history: Array<{ frames: typeof frames; steps: typeof steps }> = [];
const mutations: { path: string; method: string; body: string; phase: string }[] = [];
let pending = 0;
let maxPending = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
  if (url.pathname === '/styles.css' || url.pathname === '/candy.css') return new Response(Bun.file(join(root, 'apps/web/src', url.pathname.slice(1))));
  if (url.pathname === '/fixture/reset') { frames = structuredClone(initialFrames); steps = structuredClone(initialSteps); history = []; mutations.length = 0; maxPending = 0; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/empty-slot') { frames = frames.filter(frame => frame.id !== 'frame-3'); return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/placed-asset') { frames.find(frame => frame.id === 'frame-1')!.is_asset = 1; frames.push(frame('frame-2', 'track-0', 'step-2', 2)); return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/state') return Response.json({ axis, tracks, steps, frames, effects, assetFrames, mutations, history: history.length, pending, maxPending });
  if (request.method !== 'GET') {
    const body = await request.text();
    if (url.pathname === '/api/settings/layout') return Response.json({ ok: true });
    mutations.push({ path: url.pathname, method: request.method, body, phase: 'start' });
    pending++; maxPending = Math.max(maxPending, pending);
    try {
      // 人为延迟服务响应，明确复现 D 后立即撤销的竞争窗口。
      if (request.method === 'DELETE' && /^\/api\/frames\/[^/]+\/placement$/.test(url.pathname)) {
        await Bun.sleep(120);
        const id = url.pathname.split('/')[3]!;
        if (!frames.some(f => f.id === id)) return Response.json({ error: 'not found' }, { status: 404 });
        history.push(structuredClone({ frames, steps }));
        const deleted = frames.find(f => f.id === id)!;
        frames = deleted.is_asset ? frames.map(f => f.id === id ? { ...f, track_id: null, step_id: null } : f) : frames.filter(f => f.id !== id);
        if (url.searchParams.get('removeEmptyStep') === 'true' && !frames.some(frame => frame.step_id === deleted.step_id) && !effects.some(effect => effect.step_id === deleted.step_id)) {
          steps = steps.filter(step => step.id !== deleted.step_id).map((step, idx) => ({ ...step, idx }));
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === '/api/axes/axis/steps/prune-empty') {
        history.push(structuredClone({ frames, steps }));
        const removedStepIds = steps.filter(step => !frames.some(frame => frame.step_id === step.id) && !effects.some(effect => effect.step_id === step.id)).map(step => step.id);
        steps = steps.filter(step => !removedStepIds.includes(step.id)).map((step, idx) => ({ ...step, idx }));
        return Response.json({ ok: true, removedStepIds });
      }
      if (url.pathname === '/api/projects/fixture/undo') {
        await Bun.sleep(40);
        const old = history.pop();
        if (!old) return new Response('没有可撤销的操作', { status: 404 });
        frames = old.frames; steps = old.steps;
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'Unexpected fixture mutation' }, { status: 400 });
    } finally { pending--; mutations.push({ path: url.pathname, method: request.method, body, phase: 'finish' }); }
  }
  if (url.pathname === '/api/projects/fixture') return Response.json({ project: { id: 'fixture', name: '单帧删除撤销测试', kind: 'frame', fps: 1 } });
  if (url.pathname === '/api/projects/fixture/timeline') return Response.json({ axis, axes: [axis], tracks, steps, frames: frames.filter(frame => frame.track_id && frame.step_id), effects, poolFrames: [...assetFrames, ...frames.filter(frame => frame.is_asset && !frame.track_id)], assetFrames: [...assetFrames, ...frames.filter(frame => frame.is_asset)] });
  if (url.pathname === '/api/v1/collaboration/action') return Response.json({ ok: true, data: { mode: 'legacy', tasks: [], timing: null } });
  if (url.pathname === '/api/settings') return Response.json({});
  if (url.pathname.endsWith('/image.png')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3QQQ0AMAgEwVJdKMYkBBV85gzsZaKz+h3uX8YdIECAAAECBAgQIECAAAECBFZgAKv/AySb4DmAAAAAAElFTkSuQmCC', 'base64'), { headers: { 'Content-Type': 'image/png' } });
  if (url.pathname.startsWith('/fonts/')) return new Response(Bun.file(join(root, 'apps/web/public', url.pathname)));
  return new Response('Fixture route not found', { status: 404 });
} });
try {
  const child = Bun.spawn([join(root, 'probes/desktop/node_modules/electron/dist/electron.exe'), join(root, 'probes/desktop/editor-frame-delete-check.cjs')], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDITOR_CHECK_URL: server.url.toString(), EDITOR_CHECK_OUTPUT: evidence } });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, 'command-output.txt'), out + '\n' + err);
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ exit, evidence, ...report }, null, 2));
  process.exitCode = exit;
} finally {
  await server.stop(true);
  writeFileSync(join(evidence, 'fixture-final-state.json'), JSON.stringify({ frames, effects, steps, tracks, assetFrames, mutations, pending, maxPending }, null, 2));
  writeFileSync(join(evidence, 'fixture-lifecycle.json'), JSON.stringify({ electron_awaited: true, listener_stop_awaited: true, pending_requests: server.pendingRequests }));
}
