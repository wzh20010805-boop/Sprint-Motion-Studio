const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { join } = require('node:path');
const fs = require('node:fs');
app.setPath('userData', join(process.env.EDITOR_CHECK_OUTPUT, 'profile'));
const report = { checks: [], failures: [], consoleErrors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = () => { report.passed = !report.failures.length && !report.consoleErrors.length; fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'report.json'), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1); };
const timeout = setTimeout(() => { report.failures.push({ name: 'Probe timeout', error: 'Exceeded 50 seconds' }); finish(); }, 50000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') report.consoleErrors.push(event.message); });
  const js = source => window.webContents.executeJavaScript(source);
  const check = async (name, work) => { try { await work(); report.checks.push(name); } catch (e) { report.failures.push({ name, error: e.stack }); } };
  const key = async (keyCode, modifiers = [], settle = 60) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(settle); };
  const state = () => js("fetch('/fixture/state').then(r=>r.json())");
  const calls = async () => (await state()).mutations.filter(m => m.phase === 'start');
  const reset = async () => {
    await js("fetch('/fixture/reset',{method:'POST'})"); await window.loadURL(process.env.EDITOR_CHECK_URL);
    for (let n = 0; n < 100; n++) { if (await js("document.querySelectorAll('.tl-cell').length===8 && !!document.querySelector('.pixi-wrap canvas')")) return; await delay(40); }
    throw new Error('Editor fixture did not mount');
  };
  const cell = async (index = 4) => { await js(`document.querySelectorAll('.tl-cell')[${index}].click();document.activeElement?.blur()`); await delay(60); };
  const settled = async () => { await delay(400); assert.equal((await state()).pending, 0); };
  await window.loadURL(process.env.EDITOR_CHECK_URL); await reset();
  await check('Toolbar deletes only selected frame; whole-axis control lives in primary track and is disabled for the final axis', async () => {
    assert.equal(await js("document.querySelectorAll('.tl-controls [data-timeline-delete-frame]').length"), 1);
    assert.equal(await js("document.querySelectorAll('.tl-controls [data-timeline-delete-axis]').length"), 0);
    assert.equal(await js("document.querySelectorAll('.tl-track [data-timeline-delete-axis]').length"), 1);
    assert.equal(await js("document.querySelector('[data-timeline-delete-axis]').closest('.tl-track').querySelector('span').textContent"), 'Main');
    assert.equal(await js("document.querySelector('[data-timeline-delete-axis]').disabled"), true);
    assert.equal(await js("!!document.querySelector('[data-timeline-delete-axis]').getAttribute('aria-label')"), true);
    assert.equal(await js("!!document.querySelector('[data-timeline-undo]')"), true);
  });
  await check('D removes one placement while preserving step, effect, other track, assets and empty-cell selection', async () => {
    await reset(); await cell(); const before = await state(); await key('D'); await settled(); const after = await state();
    assert.deepEqual((await calls()).map(m => [m.method, m.path]), [['DELETE', '/api/frames/frame-0/placement']]);
    assert.deepEqual(after.frames, before.frames.filter(f => f.id !== 'frame-0'));
    for (const prop of ['axis', 'tracks', 'steps', 'effects', 'assetFrames']) assert.deepEqual(after[prop], before[prop], prop);
    assert.equal(await js("document.querySelectorAll('.tl-cell')[4].classList.contains('active')"), true);
    assert.equal(await js("document.querySelectorAll('.tl-cell')[4].querySelector('img')===null"), true);
    assert.equal(await js("document.querySelectorAll('.tl-cell')[4].classList.contains('has-effect')"), true);
    await key('D'); await settled(); assert.equal((await calls()).length, 1);
    await key('Z', ['control']); await settled(); assert.deepEqual((await state()).frames, before.frames);
  });
  await check('Delete button has the same one-placement semantics and visible undo restores exact frame', async () => {
    await reset(); await cell(5); const before = await state();
    await js("document.querySelector('[data-timeline-delete-frame]').click()"); await settled();
    assert.deepEqual((await calls()).map(m => [m.method, m.path]), [['DELETE', '/api/frames/frame-1/placement']]);
    assert.equal((await state()).steps.length, 3, 'Removing the only image must also remove its empty frame number');
    assert.deepEqual((await state()).steps.map(step => step.idx), [0, 1, 2]);
    assert.equal(await js("document.querySelectorAll('.tl-step').length"), 3);
    assert.equal(await js("[...document.querySelectorAll('.tl-step')].findIndex(step=>step.classList.contains('active'))"), 1, 'Selection follows the next frame rather than jumping to the beginning');
    await js("document.querySelector('[data-timeline-undo]').click()"); await settled(); assert.deepEqual((await state()).frames, before.frames); assert.deepEqual((await state()).steps, before.steps);
  });
  await check('Previously empty columns are removed in one reversible cleanup without touching other-track cells', async () => {
    await reset(); await js("fetch('/fixture/empty-slot',{method:'POST'})"); await window.loadURL(process.env.EDITOR_CHECK_URL); await delay(300);
    const before = await state();
    await js("document.querySelector('[data-timeline-prune-empty]').click()"); await delay(60);
    await js("document.querySelector('.confirm-modal .danger').click()"); await settled();
    const after = await state(); assert.equal(after.steps.length, 3); assert.deepEqual(after.frames, before.frames); assert.deepEqual(after.effects, before.effects);
    assert.deepEqual((await calls()).map(m=>m.path), ['/api/axes/axis/steps/prune-empty']);
    await key('Z', ['control']); await settled(); assert.deepEqual((await state()).steps, before.steps);
  });
  await check('Ctrl+S waits for a pending deletion and displays saved only after persistence finishes', async () => {
    await reset(); await cell(5);
    await js("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true}));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))");
    await delay(40); assert.equal(await js("document.querySelector('[data-edit-save]').disabled"), true);
    assert.equal(await js("[...document.querySelectorAll('.toast')].some(n=>n.textContent==='已保存')"), false);
    await settled(); assert.equal(await js("[...document.querySelectorAll('.toast')].some(n=>n.textContent==='已保存')"), true);
    assert.equal((await state()).steps.length, 3); assert.equal((await calls()).length, 1);
    await js("document.querySelector('[data-edit-undo]').click()"); await settled(); assert.equal((await state()).steps.length, 4);
  });
  await check('Immediate Ctrl+Z queues behind pending D; held and busy D never cascade into another frame', async () => {
    await reset(); await cell(); const before = await state();
    await js("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true}));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true,repeat:true}));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true}));document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))");
    await settled(); assert.deepEqual((await state()).frames, before.frames);
    assert.deepEqual((await calls()).map(m => [m.method, m.path]), [['DELETE', '/api/frames/frame-0/placement'], ['POST', '/api/projects/fixture/undo']]);
    assert.equal((await state()).maxPending, 1);
  });
  await check('Separate frame removals undo in reverse order with their transforms and metadata intact', async () => {
    await reset(); const before = await state(); await cell(); await key('D'); await settled();
    await cell(5); await key('D'); await settled();
    assert.deepEqual((await state()).frames, before.frames.filter(f => f.id !== 'frame-0' && f.id !== 'frame-1'));
    await key('Z', ['control']); await settled();
    assert.deepEqual((await state()).frames, before.frames.filter(f => f.id !== 'frame-0'));
    await js("document.querySelector('[data-timeline-undo]').click()"); await settled();
    assert.deepEqual((await state()).frames, before.frames);
    assert.equal((await state()).history, 0);
  });
  await check('A legacy placed asset returns to the pool without stealing selection from the next frame', async () => {
    await reset(); await js("fetch('/fixture/placed-asset',{method:'POST'})"); await window.loadURL(process.env.EDITOR_CHECK_URL); await delay(300);
    await cell(5); await key('D'); await settled();
    assert.equal((await state()).steps.length, 3);
    assert.equal((await state()).frames.find(frame => frame.id === 'frame-1').track_id, null);
    assert.equal(await js("document.querySelector('[data-timeline-delete-frame]').disabled"), false, 'The next placed frame must remain actionable');
    await key('D'); await settled();
    assert.deepEqual((await calls()).map(call => call.path), ['/api/frames/frame-1/placement', '/api/frames/frame-2/placement']);
    assert.ok((await state()).frames.find(frame => frame.id === 'overlay-2'), 'Other-track cell remains intact');
  });
  await check('Empty cells, locked tracks and source-asset selections never issue frame deletions', async () => {
    await reset();
    for (const index of [6, 0, 2]) {
      await cell(index); await key('D');
      assert.equal(await js("document.querySelector('[data-timeline-delete-frame]').disabled"), true);
      await js("document.querySelector('[data-timeline-delete-frame]').click()");
    }
    await js("document.querySelectorAll('.fl-item')[0].click();document.activeElement?.blur()"); await delay(60); await key('D');
    assert.equal(await js("document.querySelector('[data-timeline-delete-frame]').disabled"), true);
    await settled(); assert.deepEqual(await calls(), []);
  });
  await check('Typing, modifiers, IME, key repeats and previously prevented events retain their behavior', async () => {
    await reset(); await cell();
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      await js(`(()=>{const e=document.createElement('${tag}');e.id='typing-probe';if('${tag}'==='div')e.contentEditable='true';document.body.append(e);e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));e.remove()})()`);
    }
    await js("for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{isComposing:true},{repeat:true}])document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'d',bubbles:true,...extra}));const e=new KeyboardEvent('keydown',{key:'d',bubbles:true,cancelable:true});e.preventDefault();document.body.dispatchEvent(e)");
    await settled(); assert.deepEqual(await calls(), []);
    await js("document.querySelector('.px-select-btn').click()"); await delay(40); await key('D'); await key('Escape');
    await settled(); assert.deepEqual(await calls(), []);
  });
  await check('Visible collaboration and confirmation dialogs block shortcuts; hidden collaboration permits D', async () => {
    await reset(); await cell();
    assert.equal(await js("!!document.querySelector('.collaboration-dialog') && !document.querySelector('.collaboration-dialog').getClientRects().length"), true);
    await js("document.querySelector('[data-collaboration=manage]').click()"); await delay(80); await key('D'); await key('Z', ['control']);
    await settled(); assert.deepEqual(await calls(), []);
    await js("document.querySelector('.collaboration-dialog header button').click()"); await delay(60);
    await js("void window.fixtureConfirm()"); await delay(80); await key('D'); await key('Z', ['control']);
    await settled(); assert.deepEqual(await calls(), []);
    await js("document.querySelector('.confirm-modal button').click()");
    for (let n = 0; n < 40; n++) { if (!await js("!!document.querySelector('.modal-mask')")) break; await delay(30); }
    await key('D'); await settled();
    assert.deepEqual((await calls()).map(m => [m.method, m.path]), [['DELETE', '/api/frames/frame-0/placement']]);
  });
  await check('Pointer gestures, native drags and playback protect the selected frame', async () => {
    await reset(); await cell();
    await js("document.querySelector('.pixi-wrap canvas').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,buttons:1}))");
    await key('D');
    await js("window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,button:0,buttons:0}));document.querySelector('.fl-item').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}))");
    await key('D');
    await js("window.dispatchEvent(new DragEvent('dragend',{bubbles:true}))"); await settled(); assert.deepEqual(await calls(), []);
    await js("Array.from(document.querySelectorAll('header button')).find(e=>e.textContent.includes('播放预览')).click()"); await delay(70); await key('D'); await key('Z', ['control']);
    assert.equal(await js("document.querySelector('[data-timeline-delete-frame]').disabled"), true);
    await settled(); assert.deepEqual(await calls(), []);
  });
  await js("Array.from(document.querySelectorAll('header button')).find(e=>e.textContent.includes('播放预览')).click()");
  await cell();
  // 仅为证据截图展示完整主轨：临时增高 footer，不写布局或改变产品默认值。
  await js("document.querySelector('.timeline').style.height='240px'");
  await delay(120);
  fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'editor.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(timeout); finish();
}).catch(e => { clearTimeout(timeout); report.failures.push({ name: 'Fixture initialization', error: e.stack }); finish(); });
