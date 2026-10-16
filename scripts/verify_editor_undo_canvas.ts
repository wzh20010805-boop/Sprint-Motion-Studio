import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const evidence = join(root, 'fixtures/generated/editor-undo-canvas-ui', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(evidence, { recursive: true });
const build = await Bun.build({ entrypoints: [join(root, 'probes/desktop/editor-undo-canvas-fixture.tsx')], target: 'browser', outdir: evidence });
if (!build.success) throw new Error(build.logs.join('\n'));

const axis = { id: 'axis', project_id: 'fixture', name: '撤销测试', fps: 8, idx: 0 };
const steps = Array.from({ length: 20 }, (_, idx) => ({ id: `step-${idx}`, axis_id: axis.id, idx, duration: 1 }));
const tracks = [0, 1].map(n => ({ id: `track-${n}`, axis_id: axis.id, project_id: 'fixture', name: n ? 'Overlay' : 'Main', is_primary: n ? 0 : 1, visible: 1, locked: n ? 1 : 0, idx: n }));
const initialFrames = tracks.flatMap(track => steps.map((step, idx) => ({ id: `${track.is_primary ? 'frame' : 'overlay'}-${idx}`, project_id: 'fixture', axis_id: axis.id, track_id: track.id, step_id: step.id, is_asset: 0, idx, raw_path: 'fixture.png', processed_path: null, offset_x: idx % 4, offset_y: 4, rotation: 0, scale: 4, opacity: 1, duration: 1, source: 'upload', status: 'ready', is_keyframe: 0, width: 32, height: 32, metadata: {} })));
let frames = structuredClone(initialFrames), imageDelay = 0, undoCount = 0;
// Successive Undo revisions age the texture cache past its budget of eight.
// The eighth state restores both onion neighbors while replacement PNGs load slowly.
const undoStates = Array.from({ length: 8 }, (_, idx) => structuredClone(initialFrames)
  .filter(frame => idx === 7 || !['frame-8', 'frame-10'].includes(frame.id))
  .map(frame => frame.id === 'frame-9' ? { ...frame, offset_x: idx + 1 } : frame));
const assetFrames = [{ ...initialFrames[0], id: 'asset-0', track_id: null, step_id: null, is_asset: 1 }];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
  if (url.pathname === '/styles.css' || url.pathname === '/candy.css') return new Response(Bun.file(join(root, 'apps/web/src', url.pathname.slice(1))));
  if (url.pathname === '/fixture/image-delay') { imageDelay = 220; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/state') return Response.json({ undoCount, frameIds: frames.map(frame => frame.id) });
  if (request.method === 'POST' && url.pathname === '/api/projects/fixture/undo') {
    const next = undoStates.shift();
    if (!next) return new Response('No fixture history', { status: 404 });
    frames = next; undoCount++;
    return Response.json({ ok: true });
  }
  if (url.pathname === '/api/settings/layout') return Response.json({ ok: true });
  if (request.method !== 'GET') return Response.json({ error: 'Unexpected fixture mutation' }, { status: 400 });
  if (url.pathname === '/api/projects/fixture') return Response.json({ project: { id: 'fixture', name: '连续撤销画布回归', kind: 'frame', fps: 8 } });
  if (url.pathname === '/api/projects/fixture/timeline') return Response.json({ axis, axes: [axis], tracks, steps, frames, effects: [], poolFrames: assetFrames, assetFrames });
  if (url.pathname === '/api/v1/collaboration/action') return Response.json({ ok: true, data: { mode: 'legacy', tasks: [], timing: null } });
  if (url.pathname === '/api/settings') return Response.json({});
  if (url.pathname.endsWith('/image.png')) {
    if (imageDelay) await Bun.sleep(imageDelay);
    return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3QQQ0AMAgEwVJdKMYkBBV85gzsZaKz+h3uX8YdIECAAAECBAgQIECAAAECBFZgAKv/AySb4DmAAAAAAElFTkSuQmCC', 'base64'), { headers: { 'Content-Type': 'image/png' } });
  }
  if (url.pathname.startsWith('/fonts/')) return new Response(Bun.file(join(root, 'apps/web/public', url.pathname)));
  return new Response('Missing fixture route', { status: 404 });
} });
try {
  const child = Bun.spawn([join(root, 'probes/desktop/node_modules/electron/dist/electron.exe'), join(root, 'probes/desktop/editor-undo-canvas-check.cjs')], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDITOR_CHECK_URL: server.url.toString(), EDITOR_CHECK_OUTPUT: evidence } });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, 'command-output.txt'), out + '\n' + err);
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ exit, evidence, checks: report.checks, failures: report.failures, consoleErrors: report.consoleErrors, samples: report.samples.map((sample: any) => ({ name: sample.name, pixels: sample.pixels })) }, null, 2));
  process.exitCode = exit;
} finally {
  await server.stop(true);
  writeFileSync(join(evidence, 'fixture-final-state.json'), JSON.stringify({ undoCount, frameIds: frames.map(frame => frame.id), remainingHistory: undoStates.length }));
  writeFileSync(join(evidence, 'fixture-lifecycle.json'), JSON.stringify({ electron_awaited: true, listener_stop_awaited: true, pending_requests: server.pendingRequests }));
}
