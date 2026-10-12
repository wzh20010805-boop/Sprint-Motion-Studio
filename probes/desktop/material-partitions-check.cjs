const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { join } = require('node:path');
const fs = require('node:fs');
app.setPath('userData', join(process.env.MATERIAL_CHECK_OUTPUT, 'profile'));
const report = { checks: [], failures: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = code => {
  report.passed = code === 0;
  fs.writeFileSync(join(process.env.MATERIAL_CHECK_OUTPUT, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(code);
};
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1380, height: 960, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if(event.level === 'error') (report.consoleErrors ??= []).push(event.message); });
  const js = source => window.webContents.executeJavaScript(source);
  const check = async (name, work) => { try { await work(); report.checks.push(name); } catch (error) { report.failures.push({ name, error: error.message }); } };
  const click = async selector => { assert.ok(await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return false;b.click();return true})()`), selector); await delay(200); };
  const ids = () => js("[...document.querySelectorAll('.mat-card')].map(e=>e.dataset.materialId).sort()");
  await window.loadURL(process.env.MATERIAL_CHECK_URL);
  for(let n=0;n<80;n++){if(await js("document.querySelectorAll('.mat-card').length===5"))break;await delay(50);}
  await check('Project partition tree is mounted on the actual materials page', async () => {
    assert.equal(await js("!!document.querySelector('[data-testid=material-project-tree]')"), true);
  });
  if(report.failures.length) return finish(1);
  await check('Project roots include shared materials and distinguish projects with the same name', async () => {
    await click('[data-project-id="project-a"][data-kind="all"]');
    assert.deepEqual(await ids(), ['a-image', 'a-video', 'shared-image']);
    await click('[data-project-id="project-b"][data-kind="all"]');
    assert.deepEqual(await ids(), ['b-video', 'shared-image']);
  });
  await check('Each project has independent video and photo children classified by material kind', async () => {
    await click('[data-project-id="project-a"][data-kind="video"]'); assert.deepEqual(await ids(), ['a-video']);
    await click('[data-project-id="project-a"][data-kind="image"]'); assert.deepEqual(await ids(), ['a-image', 'shared-image']);
    await click('[data-project-id="project-b"][data-kind="video"]'); assert.deepEqual(await ids(), ['b-video']);
    await click('[data-project-id="project-b"][data-kind="image"]'); assert.deepEqual(await ids(), ['shared-image']);
  });
  await check('All and unassigned views retain every material without duplicating shared images', async () => {
    await click('[data-scope="unassigned"][data-kind="all"]'); assert.deepEqual(await ids(), ['free-image']);
    await click('[data-scope="all"]'); assert.deepEqual(await ids(), ['a-image', 'a-video', 'b-video', 'free-image', 'shared-image']);
  });
  await check('Changing partitions clears batch selection', async () => {
    await click('[data-project-id="project-a"][data-kind="all"]'); await click('[data-material-id="shared-image"] .mat-check');
    assert.equal(await js("document.querySelectorAll('.mat-card.selected').length"), 1);
    await click('[data-project-id="project-b"][data-kind="all"]');
    assert.equal(await js("document.querySelectorAll('.mat-card.selected').length"), 0);
    assert.equal(await js("!!document.querySelector('.batch-bar')"), false);
  });
  await check('Custom folders remain available alongside project partitions', async () => {
    assert.equal(await js("document.querySelector('.material-library-sidebar .folder-tree-head')?.textContent.includes('自定义文件夹')"), true);
    assert.equal(await js("!!document.querySelector('.material-library-sidebar .folder-tree-head button')"), true);
    assert.equal(await js("!![...document.querySelectorAll('.folder-name')].find(e=>e.textContent==='自建收藏')"), true);
    await js("[...document.querySelectorAll('.folder-name')].find(e=>e.textContent==='自建收藏').closest('.folder-row').click()"); await delay(200);
    assert.deepEqual(await ids(), ['a-image', 'shared-image']);
  });
  await check('Upload defaults to selected project and sends the chosen projectId', async () => {
    await click('[data-project-id="project-a"][data-kind="image"]'); await click('.home-header .mat-actions button');
    assert.equal(await js("document.querySelector('[data-testid=material-project-select]')?.value"), 'project-a');
    assert.deepEqual(await js("[...document.querySelector('[data-testid=material-project-select]').options].map(e=>e.value).sort()"), ['', 'project-a', 'project-b']);
    await js("(()=>{const select=document.querySelector('[data-testid=material-project-select]');select.value='project-b';select.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('.import-modal input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([137,80,78,71])],'isolated-upload.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()"); await delay(150);
    await click('.import-modal .modal-actions button');
    const uploads = await js("fetch('/__fixture/uploads').then(r=>r.json())");
    assert.equal(uploads.length, 1); assert.equal(uploads[0].projectId, 'project-b');
    assert.equal(uploads[0].file, 'isolated-upload.png');
  });
  await js("document.querySelector('.import-modal button[title=关闭]')?.click()"); await delay(200);
  await check('Deleting the active project clears hidden selected materials and reconciles stale associations', async () => {
    await click('[data-project-id="project-a"][data-kind="all"]');
    await click('[data-material-id="shared-image"] .mat-check');
    assert.equal(await js("document.querySelectorAll('.mat-card.selected').length"), 1);
    await js("fetch('/__fixture/delete-project-a',{method:'POST'}).then(r=>r.json())");
    for(let n=0;n<60;n++){if(await js("document.querySelector('[data-testid=material-partition-title]')?.textContent==='未归属素材'"))break;await delay(50);}
    await delay(220); // 等待批量栏退出动画，不把仍在播放的动画误报为保留选择。
    assert.equal(await js("document.querySelector('[data-testid=material-partition-title]')?.textContent"), '未归属素材');
    assert.deepEqual(await ids(), ['a-image', 'a-video', 'free-image']);
    assert.equal(await js("document.querySelectorAll('.mat-card.selected').length"), 0);
    assert.equal(await js("!!document.querySelector('.batch-bar')"), false);
    assert.equal(await js("document.querySelector('[data-scope=unassigned][data-kind=all] small')?.textContent"), '3');
  });
  await check('Deleting a project while its upload modal is open resets and submits an unassigned upload', async () => {
    await click('[data-project-id="project-b"][data-kind="all"]'); await click('.home-header .mat-actions button');
    assert.equal(await js("document.querySelector('[data-testid=material-project-select]')?.value"), 'project-b');
    await js("fetch('/__fixture/delete-project-b',{method:'POST'}).then(r=>r.json())");
    for(let n=0;n<60;n++){if(await js("document.querySelector('[data-testid=material-project-select]')?.options.length===1"))break;await delay(50);}
    assert.equal(await js("document.querySelector('[data-testid=material-project-select]')?.value"), '');
    await js("(()=>{const input=document.querySelector('.import-modal input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([137,80,78,71])],'unassigned-upload.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()"); await delay(150);
    await click('.import-modal .modal-actions button');
    const uploads = await js("fetch('/__fixture/uploads').then(r=>r.json())");
    assert.equal(uploads.length, 2); assert.equal(uploads[1].projectId, null);
    assert.equal(uploads[1].file, 'unassigned-upload.png');
    await js("document.querySelector('.import-modal button[title=关闭]')?.click()"); await delay(200);
  });
  fs.writeFileSync(join(process.env.MATERIAL_CHECK_OUTPUT, 'materials.png'), (await window.webContents.capturePage()).toPNG());
  finish(report.failures.length ? 1 : 0);
}).catch(error => { report.failures.push({ name: 'Fixture initialization', error: error.stack }); finish(1); });
