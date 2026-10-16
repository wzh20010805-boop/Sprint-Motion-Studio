import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const evidence = join(root, 'fixtures/generated/editor-timeline-insert-ui', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(evidence, { recursive: true });
const build = await Bun.build({ entrypoints: [join(root, 'probes/desktop/editor-navigation-fixture.tsx')], target: 'browser', outdir: evidence });
if (!build.success) throw new Error(build.logs.join('\n'));
const axis = { id: 'axis', project_id: 'fixture', name: '插入拖放测试', fps: 1, idx: 0 };
const tracks = [0, 1].map(n => ({ id: `track-${n}`, axis_id: axis.id, project_id: 'fixture', name: n ? 'Overlay' : 'Main', is_primary: n ? 0 : 1, visible: 1, locked: n ? 1 : 0, idx: n }));
const initialSteps = [0, 1, 2, 3].map(n => ({ id: `step-${n}`, axis_id: axis.id, idx: n, duration: n + 1 }));
const frame = (id: string, track: string | null, step: string | null, idx: number) => ({ id, project_id: 'fixture', axis_id: axis.id, track_id: track, step_id: step, is_asset: 0, idx, raw_path: 'fixture.png', processed_path: null, offset_x: idx + 3, offset_y: 4, rotation: 0.1, scale: 1.2, opacity: 0.8, duration: 1, source: 'upload', status: 'ready', is_keyframe: 0, width: 32, height: 32, metadata: { retained: id } });
const initialFrames = tracks.flatMap(track => initialSteps.map((step, n) => frame(`${track.is_primary ? 'frame' : 'overlay'}-${n}`, track.id, step.id, n)));
const assetFrames = [0, 1].map(n => ({ ...frame(`asset-${n}`, null, null, n), is_asset: 1 }));
const initialEffects = [{ id: 'effect-0', project_id: 'fixture', track_id: 'track-0', step_id: 'step-0', created_at: 1, effect: { strokes: [{ color: '#ff8a18', size: 4, brush: 'slash', points: [{ x: 0, y: 0, pressure: 1 }, { x: 10, y: 0, pressure: 1 }] }], offset_x: 0, offset_y: 0, rotation: 0, scale: 1, opacity: 1, style: 'flame' } }];
let steps = structuredClone(initialSteps), frames = structuredClone(initialFrames), effects = structuredClone(initialEffects);
let history: Array<{ frames: typeof frames; steps: typeof steps; effects: typeof effects }> = [];
const mutations: Array<{ path: string; method: string; body: any }> = [];
let deferNextFramePatch = false, releaseFramePatch: (() => void) | undefined;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
  if (url.pathname === '/styles.css' || url.pathname === '/candy.css') return new Response(Bun.file(join(root, 'apps/web/src', url.pathname.slice(1))));
  if (url.pathname === '/fixture/reset') { releaseFramePatch?.(); releaseFramePatch = undefined; deferNextFramePatch = false; steps = structuredClone(initialSteps); frames = structuredClone(initialFrames); effects = structuredClone(initialEffects); history = []; mutations.length = 0; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/defer-next-frame-patch') { deferNextFramePatch = true; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/release-frame-patch') { releaseFramePatch?.(); releaseFramePatch = undefined; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/state') return Response.json({ axis, tracks, steps, frames, effects, assetFrames, mutations, history: history.length, pendingFramePatch: !!releaseFramePatch });
  if (request.method !== 'GET') {
    if (url.pathname === '/api/settings/layout') return Response.json({ ok: true });
    const body = await request.json().catch(() => ({})) as any;
    mutations.push({ path: url.pathname, method: request.method, body });
    if (request.method === 'PATCH' && /^\/api\/frames\/[^/]+$/.test(url.pathname)) {
      const target = frames.find(frame => frame.id === url.pathname.split('/').at(-1));
      if (!target) return new Response('Missing frame', { status: 404 });
      history.push(structuredClone({ frames, steps, effects }));
      if (deferNextFramePatch) { deferNextFramePatch = false; await new Promise<void>(resolve => { releaseFramePatch = resolve; }); }
      Object.assign(target, body); return Response.json({ frame: target });
    }
    await Bun.sleep(90);
    if (request.method === 'POST' && /^\/api\/tracks\/[^/]+\/cells\/reorder$/.test(url.pathname)) {
      const trackId = url.pathname.split('/')[3]!, source = frames.find(f => f.id === body.frameId && f.track_id === trackId);
      if (!source || tracks.find(t => t.id === trackId)?.locked) return new Response('Invalid or locked source', { status: 400 });
      const from = steps.findIndex(s => s.id === source.step_id), boundary = body.beforeStepId ? steps.findIndex(s => s.id === body.beforeStepId) : steps.length;
      if (boundary < 0) return new Response('Invalid boundary', { status: 400 });
      const to = boundary > from ? boundary - 1 : boundary;
      const cells = steps.map(step => ({ frame: frames.find(f => f.track_id === trackId && f.step_id === step.id), effect: effects.find(e => e.track_id === trackId && e.step_id === step.id) }));
      history.push(structuredClone({ frames, steps, effects })); const [moved] = cells.splice(from, 1); cells.splice(to, 0, moved!);
      const assignedFrames = cells.flatMap((cell, idx) => cell.frame ? [{ ...cell.frame, step_id: steps[idx]!.id, idx }] : []);
      const assignedEffects = cells.flatMap((cell, idx) => cell.effect ? [{ ...cell.effect, step_id: steps[idx]!.id }] : []);
      frames = [...frames.filter(f => f.track_id !== trackId), ...assignedFrames]; effects = [...effects.filter(e => e.track_id !== trackId), ...assignedEffects];
      return Response.json({ ok: true, frame: frames.find(f => f.id === body.frameId), affectedStepIds: steps.slice(Math.min(from, to), Math.max(from, to) + 1).map(s => s.id) });
    }
    if (request.method === 'POST' && url.pathname === '/api/axes/axis/steps/reorder') {
      history.push(structuredClone({ frames, steps, effects })); steps = body.stepIds.map((id: string, idx: number) => ({ ...steps.find(s => s.id === id)!, idx })); return Response.json({ ok: true });
    }
    if (url.pathname === '/api/projects/fixture/undo') {
      const previous = history.pop(); if (!previous) return new Response('没有可撤销的操作', { status: 404 });
      ({ frames, steps, effects } = previous); return Response.json({ ok: true });
    }
    if (request.method === 'POST' && /^\/api\/tracks\/[^/]+\/place-frames$/.test(url.pathname)) {
      history.push(structuredClone({ frames, steps, effects }));
      const trackId = url.pathname.split('/')[3]!, stepId = body.startStepId ?? steps[0]!.id;
      frames = frames.map(f => f.track_id === trackId && f.step_id === stepId ? { ...f, track_id: null, step_id: null } : f);
      const placed = body.frameIds.map((id: string, idx: number) => ({ ...assetFrames.find(f => f.id === id)!, id: `placed-${id}`, is_asset: 0, track_id: trackId, step_id: steps[steps.findIndex(step => step.id === stepId) + idx]?.id ?? stepId }));
      frames.push(...placed); return Response.json({ frameIds: placed.map((f: any) => f.id) });
    }
    return new Response('Unexpected fixture mutation', { status: 400 });
  }
  if (url.pathname === '/api/projects/fixture') return Response.json({ project: { id: 'fixture', name: '时间轴插入拖放测试', kind: 'frame', fps: 1 } });
  if (url.pathname === '/api/projects/fixture/timeline') return Response.json({ axis, axes: [axis], tracks, steps, frames: frames.filter(f => f.track_id && f.step_id), effects, poolFrames: [...assetFrames, ...frames.filter(f => !f.track_id)], assetFrames });
  if (url.pathname === '/api/v1/collaboration/action') return Response.json({ ok: true, data: { mode: 'legacy', tasks: [], timing: null } });
  if (url.pathname === '/api/settings') return Response.json({});
  if (url.pathname.endsWith('/image.png')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3QQQ0AMAgEwVJdKMYkBBV85gzsZaKz+h3uX8YdIECAAAECBAgQIECAAAECBFZgAKv/AySb4DmAAAAAAElFTkSuQmCC', 'base64'), { headers: { 'Content-Type': 'image/png' } });
  if (url.pathname.startsWith('/fonts/')) return new Response(Bun.file(join(root, 'apps/web/public', url.pathname)));
  return new Response('Fixture route not found', { status: 404 });
} });
try {
  const child = Bun.spawn([join(root, 'probes/desktop/node_modules/electron/dist/electron.exe'), join(root, 'probes/desktop/editor-timeline-insert-check.cjs')], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDITOR_CHECK_URL: server.url.toString(), EDITOR_CHECK_OUTPUT: evidence } });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, 'command-output.txt'), out + '\n' + err);
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ exit, evidence, checks: report.checks, failures: report.failures, consoleErrors: report.consoleErrors, passed: report.passed }, null, 2)); process.exitCode = exit;
} finally { releaseFramePatch?.(); await server.stop(true); writeFileSync(join(evidence, 'fixture-final-state.json'), JSON.stringify({ frames, steps, effects, mutations }, null, 2)); writeFileSync(join(evidence, 'fixture-lifecycle.json'), JSON.stringify({ electron_awaited: true, listener_stop_awaited: true, pending_requests: server.pendingRequests })); }
