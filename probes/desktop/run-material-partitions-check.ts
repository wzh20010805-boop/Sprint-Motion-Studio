import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dir, '../..');
const output = join(repo, 'fixtures/generated/material-partitions-ui', `run-${Date.now()}`);
mkdirSync(output, { recursive: true });
const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'material-partitions-fixture.tsx')], target: 'browser', outdir: join(output, 'bundle'), minify: false });
if (!build.success) throw new Error(build.logs.join('\n'));
const bundle = build.outputs.find(file => file.path.endsWith('.js'))!;
const css = build.outputs.find(file => file.path.endsWith('.css'));
const projects = ['a', 'b'].map(letter => ({ id: `project-${letter}`, name: '同名项目', kind: 'frame', created_at: 1, updated_at: 1, frame_count: 0 }));
const materials = [
  ['a-image', 'image', ['project-a'], 'custom-folder', 'image.png'],
  ['a-video', 'video', ['project-a'], null, 'video.gif'],
  ['shared-image', 'image', ['project-a', 'project-b'], 'custom-folder', 'source.png'],
  ['b-video', 'video', ['project-b'], null, 'video.mp4'],
  ['free-image', 'image', [], null, 'free.png'],
].map(([id, kind, project_ids, folder_id, raw_path]) => ({ id, name: id, kind, project_ids, folder_id, raw_path, processed_path: null, status: 'raw', source: 'import', created_at: 1, width: 2, height: 2 }));
const folders = [{ id: 'custom-folder', name: '自建收藏', kind: 'material', parent_id: null, sort: 0, created_at: 1 }];
const uploads: unknown[] = [];
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP4z8Dwn4GBgYGJAQoAHgQCAcnqLpcAAAAASUVORK5CYII=', 'base64');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, service) {
  const path = new URL(request.url).pathname;
  if(path === '/ws') { if(service.upgrade(request)) return undefined; return new Response('Upgrade failed', { status: 400 }); }
  if(path === '/') return new Response('<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if(path === '/bundle.js') return new Response(Bun.file(bundle.path));
  if(path === '/bundle.css') return css ? new Response(Bun.file(css.path)) : new Response('');
  if(path === '/styles.css' || path === '/candy.css') return new Response(Bun.file(join(repo, 'apps/web/src', path.slice(1))));
  if(path === '/api/config') return Response.json({ gen: { providers: [] }, sfs: { production_api_version: '1.1' }, promptEnhancers: [], imageLayers: { configured: false } });
  if(path === '/api/materials') return Response.json({ materials });
  if(path === '/api/projects') return Response.json({ projects });
  if(path === '/api/folders') return Response.json({ folders });
  if(path === '/__fixture/uploads') return Response.json(uploads);
  if(/^\/__fixture\/delete-project-[ab]$/.test(path) && request.method === 'POST') {
    const id = path.endsWith('-a') ? 'project-a' : 'project-b';
    const index = projects.findIndex(project => project.id === id);
    if(index >= 0) projects.splice(index, 1);
    // 两个列表请求之间发生删除时，素材快照仍可能带已不存在的项目 ID。
    service.publish('fixture', JSON.stringify({ type: 'project_deleted', payload: { id } }));
    return Response.json({ ok: true });
  }
  if(path === '/api/materials/upload' && request.method === 'POST') {
    const data = await request.formData(); uploads.push({ projectId: data.get('projectId'), file: (data.get('file') as File)?.name, folderId: data.get('folderId') });
    return Response.json({ material: materials[0] });
  }
  if(path.match(/^\/api\/materials\/.+\/image(\.png)?$/)) return new Response(image, { headers: { 'Content-Type': 'image/png' } });
  if(path === '/favicon.ico') return new Response(null, { status: 204 });
  return new Response('Fixture route not found', { status: 404 });
}, websocket: { open(socket) { socket.subscribe('fixture'); }, message() {} } });
try {
  const child = Bun.spawn([join(import.meta.dir, 'node_modules/electron/dist/electron.exe'), join(import.meta.dir, 'material-partitions-check.cjs')], { cwd: repo, stdout: 'pipe', stderr: 'pipe', windowsHide: true, env: { ...process.env, MATERIAL_CHECK_URL: server.url.href, MATERIAL_CHECK_OUTPUT: output } });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(output, 'stdout.log'), stdout); writeFileSync(join(output, 'stderr.log'), stderr);
  console.log(JSON.stringify({ output, exit, report: JSON.parse(readFileSync(join(output, 'report.json'), 'utf8')) }));
  process.exitCode = exit;
} finally { server.stop(true); }
