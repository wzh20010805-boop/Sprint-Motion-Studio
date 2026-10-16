import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const evidence = join(root, 'fixtures/generated/skeletal-editing-commands-ui', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(evidence, { recursive: true });
const build = await Bun.build({ entrypoints: [join(root, 'probes/desktop/skeletal-editing-commands-fixture.tsx')], target: 'browser', outdir: evidence });
if (!build.success) throw new Error(build.logs.join('\n'));
const workerBuild = await Bun.build({ entrypoints: [join(root, 'apps/web/src/imageops/imageOps.worker.ts')], target: 'browser', outdir: join(evidence, 'worker') });
if (!workerBuild.success) throw new Error(workerBuild.logs.join('\n'));
const identity = () => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const skeleton = { schemaVersion: 1, kind: 'skeleton', id: 'skeleton-fixture', name: '测试骨骼', coordinateSystem: { handedness: 'right', upAxis: 'y', forwardAxis: '+z', unit: 'pixel' }, bones: [{ id: 'root', name: 'Root', parentId: null, rest: identity(), tipOffset: [40, 0, 0] }, { id: 'child', name: 'Child', parentId: 'root', rest: { ...identity(), translation: [40, 0, 0] }, tipOffset: [40, 0, 0] }] };
const clip = { schemaVersion: 1, kind: 'motion-clip', id: 'motion-fixture', name: '测试动作', skeletonId: skeleton.id, duration: 1, loop: false, tracks: [], events: [], provenance: { source: 'manual' } };
const binding = { schemaVersion: 1, kind: 'character-binding', id: 'binding-fixture', name: '测试部件绑定', skeletonId: skeleton.id, attachments: [{ id: 'region', name: 'Region', type: 'region', materialId: 'material', imageSlot: 'raw', size: [32, 32], pivot: [.5, .5], rest: identity() }], slots: [{ id: 'slot', name: 'Slot', boneId: 'root', attachmentId: 'region', drawOrder: 0 }] };
const initialDocument = { schemaVersion: 1, projectId: 'fixture', character: { binding }, animations: [{ id: 'action', name: '动作', motionClipId: clip.id, speed: 1, repeat: 1, loop: false }], activeAnimationId: 'action' };
const project = { id: 'fixture', name: '骨骼编辑命令测试', kind: 'skeletal', fps: 8 };
const materials = [{ id: 'material', name: '测试图片', kind: 'image', raw_path: 'fixture.png', processed_path: null, width: 32, height: 32, metadata: {}, created_at: 1 }];
let assets: Record<string, any> = structuredClone({ [skeleton.id]: skeleton, [clip.id]: clip });
let document = structuredClone(initialDocument);
let failNext = false;
const mutations: Array<{ path: string; method: string; body: any; succeeded: boolean }> = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
  if (url.pathname === '/imageops/imageOps.worker.js') return new Response(Bun.file(workerBuild.outputs[0]!.path), { headers: { 'Content-Type': 'application/javascript' } });
  if (url.pathname === '/styles.css' || url.pathname === '/candy.css') return new Response(Bun.file(join(root, 'apps/web/src', url.pathname.slice(1))));
  if (url.pathname === '/fixture/reset') { assets = structuredClone({ [skeleton.id]: skeleton, [clip.id]: clip }); document = structuredClone(initialDocument); mutations.length = 0; failNext = false; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/fail-next') { failNext = true; return Response.json({ ok: true }); }
  if (url.pathname === '/fixture/data') return Response.json({ skeleton: assets[skeleton.id], clip: assets[clip.id], document, project, materials, mutations });
  if (request.method === 'POST' && url.pathname === '/api/materials/material/replace-image') {
    const form = await request.formData(), image = form.get('file') as File;
    const mutation = { path: url.pathname, method: request.method, body: { slot: form.get('slot'), size: image.size, type: image.type }, succeeded: false }; mutations.push(mutation);
    await Bun.sleep(120);
    if (failNext) { failNext = false; return new Response('模拟图片保存失败', { status: 503 }); }
    mutation.succeeded = true; return Response.json({ material: materials[0] });
  }
  if (request.method === 'PUT') {
    const body = await request.json();
    const mutation = { path: url.pathname, method: request.method, body, succeeded: false }; mutations.push(mutation);
    await Bun.sleep(120);
    if (failNext) { failNext = false; return new Response('模拟保存失败', { status: 503 }); }
    if (url.pathname === '/api/projects/fixture/skeletal-document') { document = body; mutation.succeeded = true; return Response.json({ document }); }
    const id = url.pathname.split('/').at(-1)!;
    if (url.pathname.startsWith('/api/animation-assets/') && assets[id]) { assets[id] = (body as any).asset; mutation.succeeded = true; return Response.json({ animationAsset: { asset: assets[id], folderId: null } }); }
    return new Response('Unexpected mutation', { status: 400 });
  }
  if (url.pathname === '/api/animation-assets') return Response.json({ assets: Object.values(assets).map(asset => ({ id: asset.id, name: asset.name, kind: asset.kind, skeleton_id: asset.skeletonId ?? null, folder_id: null, schema_version: asset.schemaVersion, updated_at: 1 })) });
  if (url.pathname.startsWith('/api/animation-assets/')) { const asset = assets[url.pathname.split('/').at(-1)!]; return asset ? Response.json({ animationAsset: { asset, folderId: null } }) : new Response('Missing asset', { status: 404 }); }
  if (url.pathname === '/api/projects/fixture/skeletal-document') return Response.json({ document });
  if (url.pathname === '/api/materials') return Response.json({ materials });
  if (url.pathname === '/api/folders') return Response.json({ folders: [] });
  if (url.pathname.endsWith('/image.png')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3QQQ0AMAgEwVJdKMYkBBV85gzsZaKz+h3uX8YdIECAAAECBAgQIECAAAECBFZgAKv/AySb4DmAAAAAAElFTkSuQmCC', 'base64'), { headers: { 'Content-Type': 'image/png' } });
  if (url.pathname.startsWith('/fonts/')) return new Response(Bun.file(join(root, 'apps/web/public', url.pathname)));
  return new Response('Fixture route not found', { status: 404 });
} });
try {
  const child = Bun.spawn([join(root, 'probes/desktop/node_modules/electron/dist/electron.exe'), join(root, 'probes/desktop/skeletal-editing-commands-check.cjs')], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, EDITOR_CHECK_URL: server.url.toString(), EDITOR_CHECK_OUTPUT: evidence } });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, 'command-output.txt'), out + '\n' + err);
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ exit, evidence, ...report }, null, 2)); process.exitCode = exit;
} finally { await server.stop(true); writeFileSync(join(evidence, 'fixture-final-state.json'), JSON.stringify({ assets, document, mutations }, null, 2)); writeFileSync(join(evidence, 'fixture-lifecycle.json'), JSON.stringify({ electron_awaited: true, listener_stop_awaited: true, pending_requests: server.pendingRequests })); }
