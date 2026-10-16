const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const { join } = require('node:path');
app.setPath('userData', join(process.env.EDITOR_CHECK_OUTPUT, 'profile'));
const report = { checks: [], failures: [], consoleErrors: [], samples: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const saveReport = () => fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'report.json'), JSON.stringify(report, null, 2));
const timeout = setTimeout(() => { report.failures.push({ name: 'timeout' }); saveReport(); app.exit(1); }, 35000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1920, height: 1080, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') report.consoleErrors.push(event.message); });
  const js = code => window.webContents.executeJavaScript(code);
  const until = async predicate => {
    for (let n = 0; n < 150; n++) { if (await js(predicate)) return; await delay(20); }
    throw new Error('Timed out: ' + predicate);
  };
  const sample = async name => {
    const state = await js('window.fixtureState()');
    const capture = await window.webContents.capturePage();
    const size = capture.getSize(), bytes = capture.toBitmap(), rect = state.canvas?.rect;
    fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, `${name}.png`), capture.toPNG());
    let pink = 0, grid = 0;
    // These colors are unique to the synthetic pink image and real light-theme grid.
    if (rect) for (let y = Math.max(0, Math.ceil(rect.y + 36)); y < Math.min(size.height, Math.floor(rect.y + rect.height - 4)); y++) {
      for (let x = Math.max(0, Math.ceil(rect.x + 4)); x < Math.min(size.width, Math.floor(rect.x + rect.width - 4)); x++) {
        const i = (y * size.width + x) * 4, b = bytes[i], g = bytes[i + 1], r = bytes[i + 2];
        if (r > 245 && g >= 45 && g <= 80 && b >= 145 && b <= 190) pink++;
        if (r === 178 && g === 163 && b === 195) grid++;
      }
    }
    report.samples.push({ name, state, pixels: { pink, grid } });
  };
  await window.loadURL(process.env.EDITOR_CHECK_URL);
  await until("typeof window.fixtureState==='function' && document.querySelectorAll('.tl-cell').length===40 && !!document.querySelector('.pixi-wrap canvas')");
  await delay(450);
  await js("document.querySelector('.tl-cell[data-track-id=\"track-0\"][data-step-id=\"step-9\"]').click(); document.activeElement?.blur()");
  await delay(300);
  await sample('baseline-step10');
  await js("fetch('/fixture/image-delay')");
  for (let n = 1; n <= 8; n++) {
    // Native keyboard input must reach the existing global Undo command handler.
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await until(`fetch('/fixture/state').then(r=>r.json()).then(data=>data.undoCount===${n})`);
    await delay(n === 8 ? 55 : 360);
    await sample(`undo-${n}${n === 8 ? '-neighbors-restored-loading' : '-neighbors-empty'}`);
  }
  await delay(500);
  await sample('final-after-textures-load');
  const final = report.samples.at(-1).state;
  assert.equal(final.events.filter(event => event.type === 'undo-key' && event.trusted).length, 8, 'Eight trusted Ctrl+Z events');
  report.checks.push('Eight real Ctrl+Z operations restore isolated fixture history');
  assert.ok(final.events.some(event => event.type === 'unload-complete' && /frame-(8|10)\/image/.test(event.key)), 'Onion neighbor texture was evicted before restoration');
  assert.ok(final.events.filter(event => event.type === 'load-complete').length > 8, 'Texture loads exceeded the eight-entry budget');
  report.checks.push('Real Pixi texture eviction occurs before both onion neighbors return');
  for (const entry of report.samples) {
    assert.ok(entry.state.canvas?.connected && entry.state.canvas.width > 0 && entry.state.canvas.height > 0, `${entry.name}: live canvas size`);
    assert.ok(entry.pixels.pink > 100, `${entry.name}: sprite remains rendered`);
    assert.ok(entry.pixels.grid > 1000, `${entry.name}: grid remains rendered`);
    assert.equal(entry.state.errors.length, 0, `${entry.name}: no renderer/window errors`);
    const visit = node => {
      if (node.type === 'Sprite' && node.visible && node.texture && !node.texture.empty) assert.ok(!node.texture.destroyed && node.texture.source && !node.texture.source.destroyed, `${entry.name}: visible sprite texture is live`);
      node.children.forEach(visit);
    };
    entry.state.applications.filter(instance => instance.canvasConnected).forEach(instance => { assert.equal(instance.contextLost, false); visit(instance.stage); });
  }
  report.checks.push('Ten native captures retain sprite and grid pixels, including slow neighbor restoration');
  report.checks.push('Every visible Sprite retains a live texture source; no renderer errors or context loss');
  assert.equal(report.consoleErrors.length, 0, 'No console errors');
  clearTimeout(timeout); saveReport(); app.exit(0);
}).catch(error => {
  clearTimeout(timeout); report.failures.push({ name: 'regression', error: error.stack }); saveReport(); app.exit(1);
});
