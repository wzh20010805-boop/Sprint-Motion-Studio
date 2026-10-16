const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const { join } = require('node:path');
const fs = require('node:fs');
app.setPath('userData', join(process.env.EDITOR_CHECK_OUTPUT, 'profile'));
const report = { checks: [], failures: [], consoleErrors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = () => { report.passed = !report.failures.length && !report.consoleErrors.length; fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'report.json'), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1); };
const timeout = setTimeout(() => { report.failures.push({ name: 'Probe timeout', error: 'Exceeded 30 seconds' }); finish(); }, 30000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') report.consoleErrors.push(event.message); });
  const js = source => window.webContents.executeJavaScript(source);
  const check = async (name, work) => { try { await work(); report.checks.push(name); } catch (e) { report.failures.push({ name, error: e.message }); } };
  const key = async (keyCode, modifiers = []) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(45); };
  const step = () => js("Array.from(document.querySelectorAll('.tl-step')).findIndex(e=>e.classList.contains('active'))");
  const cell = async (index = 4) => { await js(`document.querySelectorAll('.tl-cell')[${index}].click();document.activeElement?.blur()`); await delay(60); };
  await window.loadURL(process.env.EDITOR_CHECK_URL);
  for (let n = 0; n < 80; n++) { if (await js("document.querySelectorAll('.tl-cell').length===8 && !!document.querySelector('.pixi-wrap canvas')")) break; await delay(50); }
  await delay(600);
  await check('Mounted hidden collaboration dialog does not block arrows; visible dialog blocks until closed', async () => {
    const dialogState = () => js("(()=>{const dialog=document.querySelector('.collaboration-dialog');return{mounted:!!dialog,visible:!!dialog?.getClientRects().length}})()");
    assert.deepEqual(await dialogState(), { mounted: true, visible: false });
    await cell(0); await key('Right'); assert.equal(await step(), 1);
    await js("document.querySelector('[data-collaboration=manage]').click()"); await delay(50);
    assert.deepEqual(await dialogState(), { mounted: true, visible: true });
    await key('Right'); assert.equal(await step(), 1);
    await js("document.querySelector('.collaboration-dialog header button').click()"); await delay(50);
    assert.deepEqual(await dialogState(), { mounted: true, visible: false });
    await key('Right'); assert.equal(await step(), 2);
  });
  await check('Arrow keys follow timeline steps, including empty cells, and stay inside first / last frame', async () => {
    await cell(); await key('Left'); assert.equal(await step(), 0);
    await key('Right'); assert.equal(await step(), 1);
    await key('Right'); assert.equal(await step(), 2); assert.equal(await js("document.querySelector('.tl-cell.active img')===null"), true);
    await key('Right'); await key('Right'); assert.equal(await step(), 3);
    await key('Left'); assert.equal(await step(), 2);
  });
  await check('Rapid repeated arrows preserve every step and selected track', async () => {
    await cell(0);
    await js("for(let n=0;n<3;n++)document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,repeat:true}))");
    await delay(80); assert.equal(await step(), 3); assert.equal(await js("document.querySelector('.tl-track.active span').textContent"), 'Overlay');
  });
  await check('Asset preview advances only through the asset list and clears multi-selection', async () => {
    await js("document.querySelectorAll('.fl-item')[0].click();document.querySelectorAll('.fl-item')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))"); await delay(70);
    await key('Right'); assert.equal(await js("Array.from(document.querySelectorAll('.fl-item')).findIndex(e=>e.classList.contains('active'))"), 2);
    assert.equal(await step(), -1); assert.equal(await js("document.querySelectorAll('.fl-item.selected').length"), 0);
    await key('Right'); assert.equal(await js("Array.from(document.querySelectorAll('.fl-item')).findIndex(e=>e.classList.contains('active'))"), 2);
    await key('Left'); assert.equal(await js("Array.from(document.querySelectorAll('.fl-item')).findIndex(e=>e.classList.contains('active'))"), 1);
  });
  await check('Typing, controls, modifiers, IME and prevented key events retain their normal behavior', async () => {
    await cell();
    for (const modifiers of [['control'], ['alt'], ['shift'], ['meta']]) await key('Right', modifiers);
    await js("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,isComposing:true}));const e=new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});e.preventDefault();document.body.dispatchEvent(e)");
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      await js(`(()=>{const e=document.createElement('${tag}');e.id='typing-probe';if('${tag}'==='div')e.contentEditable='true';document.body.append(e);e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));e.remove()})()`);
    }
    assert.equal(await step(), 0);
    await js("document.querySelector('.px-select-btn').click()"); await delay(30); await key('Right'); assert.equal(await step(), 0); await key('Escape');
  });
  await check('Confirmation dialogs do not change the editor selection underneath', async () => {
    await cell(); await js("void window.fixtureConfirm()"); await delay(80); await key('Right'); assert.equal(await step(), 0);
    await js("document.querySelector('.confirm-modal button').click()");
    for(let n=0;n<30;n++){if(!await js("!!document.querySelector('.modal-mask')"))break;await delay(30);}
    await key('Right'); assert.equal(await step(), 1);
  });
  await check('Held pointer and native drag protect the current canvas frame until released', async () => {
    await cell();
    await js("document.querySelector('.pixi-wrap canvas').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,button:0,buttons:1}))");
    await key('Right'); assert.equal(await step(), 0);
    await js("window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,button:0,buttons:0}))");
    await key('Right'); assert.equal(await step(), 1);
    await js("document.querySelector('.fl-item').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}))");
    await js("window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}))");
    await key('Right'); assert.equal(await step(), 1);
    await js("window.dispatchEvent(new DragEvent('dragend',{bubbles:true}))"); await key('Right'); assert.equal(await step(), 2);
  });
  await check('Playback arrows pause and preview one adjacent step without changing project data', async () => {
    await cell(); await js("Array.from(document.querySelectorAll('header button')).find(e=>e.textContent.includes('播放预览')).click()"); await delay(50);
    await key('Right'); assert.equal(await js("document.querySelector('.frame-indicator').textContent"), '2 / 4');
    await delay(1100); assert.equal(await js("document.querySelector('.frame-indicator').textContent"), '2 / 4');
    await js("for(let n=0;n<4;n++)document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); await delay(50);
    assert.equal(await js("document.querySelector('.frame-indicator').textContent"), '4 / 4');
    await key('Left'); assert.equal(await js("document.querySelector('.frame-indicator').textContent"), '3 / 4');
    assert.deepEqual(await js("fetch('/fixture/mutations').then(r=>r.json())"), []);
  });
  await check('Real mouse drag keeps the original frame selected and commits to that frame only', async () => {
    await js("Array.from(document.querySelectorAll('header button')).find(e=>e.textContent.includes('播放预览')).click()");
    await cell(); await delay(100);
    const rect = await js("(()=>{const r=document.querySelector('.pixi-wrap canvas').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()");
    // 从实际渲染的粉色方块找到拖拽起点，避免假设 Pixi 与 CSS 的适配中心相同。
    const capture = await window.webContents.capturePage();
    const bitmap = capture.toBitmap(), size = capture.getSize();
    report.dragProbe = { rect, size, centerPixel: [...bitmap.subarray((534 * size.width + 809) * 4, (534 * size.width + 809) * 4 + 4)] };
    let sumX = 0, sumY = 0, count = 0;
    for(let y=Math.ceil(rect.y);y<Math.min(size.height,rect.y+rect.height);y++)for(let x=Math.ceil(rect.x);x<Math.min(size.width,rect.x+rect.width);x++){
      const i=(y*size.width+x)*4;
      if(bitmap[i+1]===60&&((bitmap[i]===170&&bitmap[i+2]===255)||(bitmap[i]===255&&bitmap[i+2]===170))){sumX+=x;sumY+=y;count++;}
    }
    assert.ok(count>20, 'Fixture sprite must be visible on the actual Pixi canvas');
    const point = { x: Math.round(sumX/count), y: Math.round(sumY/count) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await key('Right'); assert.equal(await step(), 0);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 20, y: point.y + 10 }); await delay(50);
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 20, y: point.y + 10 }); await delay(120);
    const mutations = await js("fetch('/fixture/mutations').then(r=>r.json())");
    assert.equal(mutations.length, 1, 'Dragging should write exactly one frame transform');
    assert.equal(mutations[0].path, '/api/frames/frame-0'); assert.equal(mutations[0].method, 'PATCH');
    assert.ok(JSON.parse(mutations[0].body).offset_x > 0, 'The test must exercise actual sprite dragging');
    await key('Right'); assert.equal(await step(), 1);
  });
  fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'editor.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(timeout); finish();
}).catch(e => { clearTimeout(timeout); report.failures.push({ name: 'Fixture initialization', error: e.stack }); finish(); });
