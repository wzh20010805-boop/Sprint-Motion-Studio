import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 独立的合成页面：只验证真实组件，不连接工作区或正式后台。
const root = resolve(import.meta.dir, '..');
const evidence = process.argv.includes('--public-runtime')?join(root,'fixtures/generated/human-ai','t12-mask-'+crypto.randomUUID().replaceAll('-','').slice(0,8)):join(root, 'fixtures/generated/mask-navigation', new Date().toISOString().replaceAll(':', '-'));
const electron=join(root,'probes/desktop/node_modules/electron/dist/electron.exe');
mkdirSync(evidence, { recursive: true });
const build = await Bun.build({ entrypoints: [join(root, 'probes/desktop/mask-navigation-fixture.tsx')], target: 'browser', outdir: evidence });
if (!build.success) throw new Error(build.logs.join('\n'));
const states = [1, 2, 3].map(n => ({ frame_id: `frame-${n}`, revision: 1, version_id: `version-${n}`, reviewed: false, source_changed: false, current: { id: `version-${n}`, parent_id: null, kind: 'automatic', info: '{"reasons":[]}' }, versions: [] }));
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/candy.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
  if (url.pathname === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
  if (url.pathname === '/styles.css' || url.pathname === '/candy.css') return new Response(Bun.file(join(root, 'apps/web/src', url.pathname.slice(1))));
  if (url.pathname === '/api/v1/projects/fixture/masks') return Response.json({ ok: true, data: { active_job: null, frames: states.map(s => ({ id: s.frame_id, reviewed: 0, info: null })) } });
  if (url.pathname.endsWith('/image')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="white"/><rect x="32" y="24" width="64" height="96" fill="' + (url.searchParams.get('kind') === 'mask' ? 'white' : 'red') + '"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
  const state = states.find(s => url.pathname === '/api/v1/masks/' + s.frame_id);
  if (state) { await Bun.sleep(state.frame_id === 'frame-2' ? 180 : 10); return Response.json({ ok: true, data: state }); }
  return new Response('Fixture route not found', { status: 404 });
} });
try {
  const child = Bun.spawn([electron, join(root, 'probes/desktop/mask-navigation-check.cjs')], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, MASK_CHECK_URL: server.url.toString(), MASK_CHECK_OUTPUT: evidence } });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  writeFileSync(join(evidence, 'command-output.txt'), out + '\n' + err);
  const report = JSON.parse(readFileSync(join(evidence, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ exit, evidence, ...report }, null, 2));
  process.exitCode = exit;
} finally { await server.stop(true); writeFileSync(join(evidence,'fixture-lifecycle.json'),JSON.stringify({electron_awaited:true,listener_stop_awaited:true,pending_requests:server.pendingRequests})); }
