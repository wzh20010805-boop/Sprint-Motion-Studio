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
  const window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.debugger.attach('1.3');
  let interceptedDrag;
  window.webContents.debugger.on('message', (_event, method, params) => { if (method === 'Input.dragIntercepted') interceptedDrag = params.data; });
  await window.webContents.debugger.sendCommand('Input.setInterceptDrags', { enabled: true });
  window.webContents.on('console-message', event => { if (event.level === 'error') report.consoleErrors.push(event.message); });
  const js = source => window.webContents.executeJavaScript(source);
  const check = async (name, work) => { try { await work(); report.checks.push(name); } catch (e) { report.failures.push({ name, error: e.stack }); } };
  const state = () => js("fetch('/fixture/state').then(r=>r.json())");
  const reset = async () => {
    await js("fetch('/fixture/reset',{method:'POST'})"); await window.loadURL(process.env.EDITOR_CHECK_URL);
    for (let n = 0; n < 100; n++) { if (await js("document.querySelectorAll('.tl-cell').length===8 && !!document.querySelector('.pixi-wrap canvas')")) break; await delay(40); }
    // 探针展示完整两轨，临时增高，不写入布局设置。
    await js("document.querySelector('.timeline').style.height='260px';window.fixtureDragEvents=[];window.fixtureKeys=[];window.addEventListener('keydown',e=>window.fixtureKeys.push({key:e.key,trusted:e.isTrusted}),true);for(const type of ['dragstart','dragenter','dragover','drop','dragend'])document.addEventListener(type,event=>window.fixtureDragEvents.push({type,trusted:event.isTrusted,x:event.clientX,y:event.clientY,target:event.target.closest('.tl-cell,.tl-step,.tl-grid')?.className,types:Array.from(event.dataTransfer?.types??[])}),true)"); await delay(80);
  };
  const bounds = (selector, index = 0) => js(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}],r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const beginNative = async (selector, index) => {
    interceptedDrag = undefined;
    if (selector === '.tl-cell') { await js(`document.querySelectorAll('.tl-cell')[${index}].click();document.activeElement?.blur()`); await delay(30); }
    const box = await bounds(selector, index), point = { x: Math.round(box.x + box.width * .45), y: Math.round(box.y + box.height * .5) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); await delay(30);
    for (const offset of [4, 10, 18]) { window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + offset, y: point.y, modifiers: ['leftbuttondown'] }); await delay(30); }
    for (let n = 0; n < 30 && !interceptedDrag; n++) await delay(20);
    assert.ok(interceptedDrag, 'Real mouse movement must start Chromium native HTML5 drag and expose the intercepted DataTransfer');
    return interceptedDrag;
  };
  const nativeHover = async (data, selector, index, fraction = .75) => {
    const box = await bounds(selector, index), point = { x: box.x + box.width * fraction, y: box.y + box.height / 2 };
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', ...point, data }); await delay(30); return point;
  };
  const cancelNative = async () => {
    if (interceptedDrag) await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: 20, y: 20, data: interceptedDrag });
    await window.webContents.debugger.sendCommand('Input.cancelDragging');
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 20, y: 20 }); await delay(50);
    // 截获拖拽先释放浏览器状态，再把真实 Esc 送到页面；避免 Chromium 原生层吞键。
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await delay(40);
    (report.cancelTargets??=[]).push(await js("({keys:window.fixtureKeys,events:window.fixtureDragEvents,grid:document.querySelector('.tl-grid')?.className})"));
  };
  const dropNative = async (data, point) => {
    // 原生鼠标停留时持续收到 dragover；CDP 需显式补发，保持原始指针坐标不变。
    await delay(200);
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
    const hit = await js(`(()=>{const e=document.elementFromPoint(${point.x},${point.y});return{tag:e?.tagName,classes:e?.className,track:e?.closest('[data-track-id]')?.dataset.trackId}})()`);
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'drop', ...point, data });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(point.x), y: Math.round(point.y) }); await delay(260);
    (report.dropTargets??=[]).push({ point, hit, events: await js('window.fixtureDragEvents') });
  };
  const marker = kind => js(`(()=>{const e=document.querySelector('[data-timeline-insert-marker][data-kind=${kind}]');if(!e)return null;const r=e.getBoundingClientRect();return{beforeStepId:e.dataset.beforeStepId,index:e.dataset.insertIndex,visible:!!r.width&&!!r.height}})()`);
  const order = (data, trackId = 'track-0') => data.steps.map(step => data.frames.find(frame => frame.track_id === trackId && frame.step_id === step.id)?.id ?? null);
  await window.loadURL(process.env.EDITOR_CHECK_URL);
  await check('Hidden Electron receives trusted native HTML5 dragstart and trusted browser hover events', async () => {
    await reset();
    try {
      const data = await beginNative('.tl-cell', 4); await nativeHover(data, '.tl-cell', 6);
      const events = await js('window.fixtureDragEvents'); report.nativeDragEvidence = { events, data };
      assert.ok(events.some(event => event.type === 'dragstart' && event.trusted));
      assert.ok(events.some(event => event.type === 'dragover' && event.trusted));
      assert.deepEqual((await state()).mutations, []);
    } finally { await cancelNative(); }
  });
  await check('Frame hover previews an insertion gap and smoothly displaces neighbors without persisting', async () => {
    await reset(); const before = await bounds('.tl-cell', 5);
    try {
      const data = await beginNative('.tl-cell', 4); await nativeHover(data, '.tl-cell', 6);
      const mid = await bounds('.tl-cell', 5);
      const transition = await js("(()=>{const e=document.querySelectorAll('.tl-cell')[5],s=getComputedStyle(e);return{duration:s.transitionDuration,property:s.transitionProperty,animations:e.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))}})()");
      await delay(200); const gap = await marker('frame'); assert.ok(gap?.visible, 'Insertion gap must actually be visible');
      assert.equal(gap.beforeStepId, 'step-3'); assert.equal(gap.index, '3');
      const after = await bounds('.tl-cell', 5); assert.ok(Math.abs(after.x - before.x) >= 40, 'The neighboring frame must visibly make room during hover');
      assert.ok(transition.duration.split(',').some(value => parseFloat(value) > 0), 'Neighbor movement must have a CSS transition');
      assert.ok(transition.property.split(',').some(value => ['all', 'transform'].includes(value.trim())), 'The CSS transition must animate positional transform');
      report.frameHover = { before, mid, after, transition, gap };
      assert.deepEqual((await state()).mutations, []);
      fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'frame-hover.png'), (await window.webContents.capturePage()).toPNG());
    } finally { await cancelNative(); }
    await delay(200); assert.deepEqual(await bounds('.tl-cell', 5), before); assert.deepEqual((await state()).mutations, []); assert.equal(await marker('frame'), null);
  });
  await check('Column hover displaces the entire timeline column and cancellation restores it without writes', async () => {
    await reset(); const before = await bounds('.tl-step', 1), topBefore = await bounds('.tl-cell', 1), mainBefore = await bounds('.tl-cell', 5);
    try {
      const data = await beginNative('.tl-step', 0); await nativeHover(data, '.tl-step', 2); await delay(200);
      const gap = await marker('step'); assert.ok(gap?.visible); assert.equal(gap.beforeStepId, 'step-3');
      const after = await bounds('.tl-step', 1); assert.ok(Math.abs(after.x - before.x) >= 40, 'The neighboring header must visibly make room during hover');
      assert.ok(Math.abs((await bounds('.tl-cell', 1)).x - topBefore.x) >= 40, 'Overlay column must move with its header');
      assert.ok(Math.abs((await bounds('.tl-cell', 5)).x - mainBefore.x) >= 40, 'Main column must move with its header');
      assert.deepEqual((await state()).mutations, []);
      fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'column-hover.png'), (await window.webContents.capturePage()).toPNG());
    } finally { await cancelNative(); }
    await delay(200); assert.deepEqual(await bounds('.tl-step', 1), before); assert.deepEqual((await state()).mutations, []); assert.equal(await marker('step'), null);
  });
  await check('Dropping after a frame inserts the selected cell and effect instead of swapping; undo restores both', async () => {
    await reset(); const before = await state();
    const data = await beginNative('.tl-cell', 4), point = await nativeHover(data, '.tl-cell', 6); assert.deepEqual((await state()).mutations, []);
    await dropNative(data, point); const after = await state();
    assert.deepEqual(after.mutations.map(m => [m.method, m.path, m.body]), [['POST', '/api/tracks/track-0/cells/reorder', { frameId: 'frame-0', beforeStepId: 'step-3' }]]);
    assert.deepEqual(order(after), ['frame-1', 'frame-2', 'frame-0', 'frame-3']); assert.deepEqual(order(after, 'track-1'), order(before, 'track-1'));
    assert.deepEqual(after.steps, before.steps); assert.deepEqual(after.assetFrames, before.assetFrames); assert.equal(after.effects[0].step_id, 'step-2');
    assert.equal(await js("document.querySelector('.tl-cell.active').dataset.frameId"), 'frame-0');
    assert.ok((await js('window.fixtureDragEvents')).some(event => event.type === 'drop' && event.trusted));
    await js("document.querySelector('[data-timeline-undo]').click()"); await delay(260); const undone = await state();
    assert.deepEqual(undone.frames, before.frames); assert.deepEqual(undone.effects, before.effects); assert.deepEqual(undone.steps, before.steps);
  });
  await check('The left half of a target inserts before it when dragging backward', async () => {
    await reset(); const data = await beginNative('.tl-cell', 7), point = await nativeHover(data, '.tl-cell', 5, .25);
    assert.equal((await marker('frame')).beforeStepId, 'step-1'); await dropNative(data, point);
    assert.deepEqual(order(await state()), ['frame-0', 'frame-3', 'frame-1', 'frame-2']);
  });
  await check('Dropping a header inserts the whole column with both tracks and duration; undo restores order', async () => {
    await reset(); const before = await state(); const data = await beginNative('.tl-step', 0), point = await nativeHover(data, '.tl-step', 2);
    await dropNative(data, point); const after = await state();
    assert.deepEqual(after.mutations.map(m => [m.method, m.path, m.body]), [['POST', '/api/axes/axis/steps/reorder', { stepIds: ['step-1', 'step-2', 'step-0', 'step-3'] }]]);
    assert.deepEqual(after.steps.map(step => step.duration), [2, 3, 1, 4]);
    assert.deepEqual(order(after), ['frame-1', 'frame-2', 'frame-0', 'frame-3']); assert.deepEqual(order(after, 'track-1'), ['overlay-1', 'overlay-2', 'overlay-0', 'overlay-3']);
    assert.deepEqual(after.effects, before.effects);
    await js("document.querySelector('[data-timeline-undo]').click()"); await delay(260); const undone = await state();
    assert.deepEqual(undone.steps, before.steps); assert.deepEqual(undone.frames, before.frames);
  });
  await check('An adjacent insertion with unchanged order commits no write', async () => {
    await reset(); const data = await beginNative('.tl-cell', 4), point = await nativeHover(data, '.tl-cell', 5, .25); await dropNative(data, point);
    assert.deepEqual((await state()).mutations, []);
  });
  await check('Dropping on the visible gap itself remains an insertion target', async () => {
    await reset(); const data = await beginNative('.tl-cell', 4);
    const grid = await bounds('.tl-grid'), main = await bounds('.tl-cell', 4), point = { x: grid.x + 190 + 4 + 3 * 68 - 2, y: main.y + main.height / 2 };
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data });
    await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', ...point, data }); await delay(100);
    assert.ok((await marker('frame'))?.visible, 'The grid gap must retain its insertion preview');
    await dropNative(data, point); assert.deepEqual(order(await state()), ['frame-1', 'frame-2', 'frame-0', 'frame-3']);
  });
  await check('Locked tracks cannot initiate a native cell drag', async () => {
    await reset(); const box = await bounds('.tl-cell', 0), point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    assert.equal(await js("document.querySelectorAll('.tl-cell')[0].draggable"), false);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 20, y: point.y, modifiers: ['leftbuttondown'] }); await delay(90);
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 20, y: point.y });
    assert.equal((await js('window.fixtureDragEvents')).some(event => event.type === 'dragstart'), false); assert.deepEqual((await state()).mutations, []);
  });
  await check('Source-asset dragging retains the existing batch placement path', async () => {
    await reset(); const data = await beginNative('.fl-item', 0), point = await nativeHover(data, '.tl-cell', 6);
    assert.equal(await marker('frame'), null); await dropNative(data, point);
    const after = await state(); assert.deepEqual(after.mutations.map(m => [m.method, m.path, m.body]), [['POST', '/api/tracks/track-0/place-frames', { startStepId: 'step-2', frameIds: ['asset-0'] }]]);
    assert.equal(after.assetFrames.length, 2);
  });
  await check('A pending frame edit delays insertion and blocks effect edits until the move finishes', async () => {
    await reset();
    await js("document.querySelectorAll('.tl-cell')[4].click();document.activeElement?.blur()"); await delay(40);
    await js("fetch('/fixture/defer-next-frame-patch',{method:'POST'});document.querySelectorAll('.toolbar .transform-stepper button')[2].click()");
    for (let n = 0; n < 60 && !(await state()).pendingFramePatch; n++) await delay(20);
    assert.equal((await state()).pendingFramePatch, true);
    const data = await beginNative('.tl-cell', 4), point = await nativeHover(data, '.tl-cell', 6); await dropNative(data, point);
    assert.equal(await js("document.querySelector('.attack-delete').disabled"), true);
    assert.equal(await js("document.querySelector('.editor-main').inert"), true);
    assert.equal(await js("document.querySelectorAll('.tl-step')[0].draggable"), false);
    await js("document.querySelector('.attack-delete').click();document.querySelectorAll('.toolbar .transform-stepper button')[2].click()"); await delay(50);
    assert.deepEqual((await state()).mutations.map(m => [m.method, m.path]), [['PATCH', '/api/frames/frame-0']]);
    await js("fetch('/fixture/release-frame-patch',{method:'POST'})"); await delay(350);
    const saved = await state(); assert.deepEqual(saved.mutations.map(m => [m.method, m.path]), [['PATCH', '/api/frames/frame-0'], ['POST', '/api/tracks/track-0/cells/reorder']]);
    assert.deepEqual(order(saved), ['frame-1', 'frame-2', 'frame-0', 'frame-3']);
    assert.equal(saved.frames.find(frame => frame.id === 'frame-0').scale, 1.3); assert.equal(saved.effects[0].step_id, 'step-2'); assert.equal(saved.effects[0].effect.strokes.length, 1);
    assert.equal(await js("document.querySelector('.attack-delete').disabled"), false);
    assert.equal(await js("document.querySelector('.editor-main').inert"), false);
  });
  fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'editor.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(timeout); finish();
}).catch(e => { clearTimeout(timeout); report.failures.push({ name: 'Fixture initialization', error: e.stack }); finish(); });
