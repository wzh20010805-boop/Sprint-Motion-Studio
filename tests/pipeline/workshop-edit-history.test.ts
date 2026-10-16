import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktopTest = process.platform === 'win32' ? test : test.skip;
desktopTest('材料与对齐保存撤销保留真实历史，遮罩失败不冒充成功', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const evidence = join(repo, 'fixtures/generated/workshop-edit-history', crypto.randomUUID());
  mkdirSync(evidence, { recursive: true });
  const file = (value: string) => JSON.stringify(join(repo, value).replaceAll('\\', '/'));
  const fixture = join(evidence, 'fixture.tsx');
  writeFileSync(fixture, `import {createElement as h,useState} from ${file('apps/web/node_modules/react')};
import {createRoot} from ${file('apps/web/node_modules/react-dom/client')};
import {MaterialEditorProvider,useMaterialEditor} from ${file('apps/web/src/components/MaterialEditor.tsx')};
import AlignmentWorkshop from ${file('apps/web/src/components/AlignmentWorkshop.tsx')};
import MaskWorkshop from ${file('apps/web/src/components/MaskWorkshop.tsx')};
import {runEditingCommand,editingCommands} from ${file('apps/web/src/editingCommands.ts')};
import AppModals from ${file('apps/web/src/components/AppModals.tsx')};
(window as any).editCommands={run:runEditingCommand,state:()=>editingCommands.getSnapshot()};
function Cases(){const open=useMaterialEditor();const [align,setAlign]=useState(false),[mask,setMask]=useState(false);return h('main',null,h('button',{id:'open-material',onClick:()=>open({id:'material',name:'History fixture'})},'Material'),h('button',{id:'open-alignment',onClick:()=>setAlign(true)},'Alignment'),h('button',{id:'open-mask',onClick:()=>setMask(true)},'Mask'),align&&h(AlignmentWorkshop,{projectId:'project',axisId:'axis',frames:[],fps:8,onClose:()=>setAlign(false)}),mask&&h(MaskWorkshop,{projectId:'project',frames:[{id:'mask-frame',raw_path:'fixture.png'}],initialId:'mask-frame',onClose:()=>setMask(false),onChanged:()=>{}}));}
createRoot(document.getElementById('root')!).render(h(MaterialEditorProvider,null,h(Cases),h(AppModals)));`);
  const build = await Bun.build({ entrypoints: [fixture], target: 'browser', outdir: join(evidence, 'build') });
  expect(build.success, build.logs.join('\n')).toBeTrue();
  const config = { canvas: { width: 128, height: 128 }, anchor: [64, 112], scale: 1, resampling: 'cartoon', mode: 'fixed', roots: [{ index: 0, x: 64, y: 112 }], offsets: {} };
  let storedConfig = structuredClone(config), revision = 1, failSave = true, materialWrites = 0;
  const alignmentWrites: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response('<html lang="zh-CN"><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
    if (path === '/fixture.js') return new Response(Bun.file(build.outputs[0]!.path));
    if (path === '/styles.css') return new Response(Bun.file(join(repo, 'apps/web/src/styles.css')));
    if (path === '/api/materials/material/image.png' || path === '/api/v1/masks/mask-frame/image') return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3QQQ0AMAgEwVJdKMYkBBV85gzsZaKz+h3uX8YdIECAAAECBAgQIECAAAECBFZgAKv/AySb4DmAAAAAAElFTkSuQmCC', 'base64'), { headers: { 'Content-Type': 'image/png' } });
    if (path === '/api/v1/projects/project/masks') return Response.json({ ok: true, data: { active_job: null, frames: [] } });
    if (path === '/api/v1/masks/mask-frame') return Response.json({ ok: true, data: { frame_id: 'mask-frame', revision: 1, version_id: 'v1', reviewed: false, source_changed: false, current: { id: 'v1', parent_id: 'v0', kind: 'manual', info: '{"reasons":[]}' }, versions: [] } });
    if (path === '/api/v1/masks/mask-frame/strokes' || path === '/api/v1/masks/mask-frame/undo') return Response.json({ ok: false, error: { message: 'MASK_FAILED_FIXTURE' } }, { status: 409 });
    if (path === '/api/materials/material/replace-image') { materialWrites++; return Response.json({ material: { id: 'material' } }); }
    if (path === '/fixture/allow-save') { failSave = false; return Response.json({}); }
    if (path === '/fixture/conflict') { revision++; return Response.json({}); }
    if (path === '/fixture/state') return Response.json({ config: storedConfig, revision, materialWrites, alignmentWrites });
    if (path === '/api/v1/alignment') {
      if (request.method === 'GET') return Response.json({ ok: true, data: { config: storedConfig, revision } });
      const body = await request.json() as any; alignmentWrites.push(body);
      if (failSave || body.base_revision !== revision) return Response.json({ ok: false, error: { message: 'SAVE_FAILED_FIXTURE' } }, { status: 409 });
      storedConfig = body.config; revision++; return Response.json({ ok: true, data: { config: storedConfig, revision } });
    }
    return Response.json({});
  } });
  const runner = join(evidence, 'check.cjs');
  writeFileSync(runner, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(evidence, 'profile'))});
app.whenReady().then(async()=>{const w=new BrowserWindow({width:1360,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});const js=s=>w.webContents.executeJavaScript(s);const pause=ms=>new Promise(r=>setTimeout(r,ms));const until=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await pause(40);}throw Error('Timed out: '+s);};try{
await w.loadURL(${JSON.stringify(server.url.toString())});await js("document.querySelector('#open-material').click()");await until("!!document.querySelector('.material-editor-toolbar button[aria-pressed]') && !document.querySelector('.material-editor-toolbar button[aria-pressed]').disabled");
await js("document.querySelector('.material-editor-toolbar button[aria-pressed]').click()");await pause(40);
assert.equal(await js("[...document.querySelectorAll('.material-editor-toolbar button')].find(b=>b.title.includes('撤销')).disabled"),false,'flip must enter undo history');
await js("[...document.querySelectorAll('.material-editor-toolbar button')].find(b=>b.title.includes('撤销')).click()");await pause(40);assert.equal(await js("document.querySelector('.material-editor-toolbar button[aria-pressed]').getAttribute('aria-pressed')"),'false');
await js("document.querySelector('.material-editor-toolbar button[aria-pressed]').click()");await pause(40);await js("[...document.querySelectorAll('.material-editor-modal .modal-actions button')].find(b=>b.textContent.includes('重置')).click()");await pause(40);await js("[...document.querySelectorAll('.material-editor-toolbar button')].find(b=>b.title.includes('撤销')).click()");await pause(40);assert.equal(await js("document.querySelector('.material-editor-toolbar button[aria-pressed]').getAttribute('aria-pressed')"),'true','undo reset restores flip');
assert.equal(await js("window.editCommands.run('save')"),true,await js("JSON.stringify(window.editCommands.state())+document.body.innerText"));await pause(50);assert.equal(await js("!!document.querySelector('.material-editor-modal')"),true,'save keeps editable history open');assert.equal(await js("window.editCommands.state().dirty"),false);
assert.equal(await js("window.editCommands.run('undo')"),true);await pause(50);assert.equal(await js("window.editCommands.state().dirty"),true,'undo a saved edit is an explicit unsaved draft');assert.equal(await js("document.querySelector('[data-material-edit-status]').textContent.includes('未保存')"),true);assert.equal(await js("window.editCommands.run('save')"),true);assert.equal(await js("fetch('/fixture/state').then(r=>r.json()).then(s=>s.materialWrites)"),2,'saving undo writes original pixels back');
await js("document.querySelector('.material-editor-modal .form-inline button').click();document.querySelector('#open-alignment').click()");await until("!!document.querySelector('.alignment-workshop')");
await js("(()=>{const input=document.querySelector('.alignment-controls input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'256');input.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause(50);
assert.equal(await js("[...document.querySelectorAll('.alignment-controls button')].some(b=>b.textContent.includes('撤销'))"),true,'alignment needs real local history');
await js("[...document.querySelectorAll('.alignment-controls button')].find(b=>b.textContent.includes('撤销')).click()");await pause(50);assert.equal(await js("document.querySelector('.alignment-controls input[type=number]').value"),'128');
await js("(()=>{const input=document.querySelector('.alignment-controls input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'256');input.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause(50);assert.equal(await js("window.editCommands.run('save')"),false);await pause(50);assert.equal(await js("window.editCommands.state().dirty"),true,'failed alignment save keeps dirty draft');assert.equal(await js("document.querySelector('.alignment-controls input[type=number]').value"),'256');
await js("fetch('/fixture/allow-save')");assert.equal(await js("window.editCommands.run('save')"),true);await pause(50);assert.equal(await js("window.editCommands.run('undo')"),true);await pause(50);assert.equal(await js("fetch('/fixture/state').then(r=>r.json()).then(s=>s.config.canvas.width)"),128,'undo after save persists inverse alignment with latest revision');
await js("(()=>{const input=document.querySelector('.alignment-controls input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'384');input.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause(50);assert.equal(await js("window.editCommands.run('save')"),true);await pause(50);await js("fetch('/fixture/conflict')");assert.equal(await js("window.editCommands.run('undo')"),false);await pause(50);assert.equal(await js("document.querySelector('.alignment-controls input[type=number]').value"),'384','conflicting undo does not consume history or overwrite state');assert.equal(await js("window.editCommands.state().canUndo"),true);
await js("document.querySelector('.alignment-workshop header button').click();document.querySelector('#open-mask').click()");await until("!!document.querySelector('.mask-workshop') && !document.querySelector('.mask-loading') && window.editCommands.state().canUndo");
assert.equal(await js("window.editCommands.run('undo')"),false,'backend mask undo failure propagates');await pause(50);assert.equal(await js("window.editCommands.state().result"),'failed');
await js("document.querySelector('.mask-tool-pair button').click()");await pause(50);await js("(()=>{const c=document.querySelector('[data-testid=mask-canvas]');c.setPointerCapture=()=>{};const r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,button:0}));})()");await pause(50);assert.equal(await js("window.editCommands.state().dirty"),true);assert.equal(await js("window.editCommands.run('save')"),false,'mask save failure propagates');await pause(50);assert.equal(await js("window.editCommands.state().dirty"),true,'failed mask save preserves brush draft');assert.equal(await js("window.editCommands.run('undo')"),true);await pause(50);assert.equal(await js("window.editCommands.state().dirty"),false,'local mask stroke undo is real');
fs.writeFileSync(${JSON.stringify(join(evidence, 'result.json'))},JSON.stringify({ok:true}));app.exit(0);
}catch(e){fs.writeFileSync(${JSON.stringify(join(evidence, 'result.json'))},JSON.stringify({ok:false,error:e.stack}));app.exit(1);}});`);
  try {
    const child = Bun.spawn([join(repo, 'probes/desktop/node_modules/electron/dist/electron.exe'), runner], { cwd: repo, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const result = existsSync(join(evidence, 'result.json')) ? readFileSync(join(evidence, 'result.json'), 'utf8') : 'Electron did not write a result';
    expect(code, `${result}\n${stdout}\n${stderr}\n${evidence}`).toBe(0);
    expect(JSON.parse(result).ok).toBeTrue();
  } finally { await server.stop(true); }
}, 30000);
