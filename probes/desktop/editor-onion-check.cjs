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
  const check = async (name, work) => { try { await work(); report.checks.push(name); } catch (error) { report.failures.push({ name, error: error.message }); } };
  const cell = async (track, index) => {
    await js(`Array.from(document.querySelectorAll('.tl-row')).find(row => row.querySelector('.tl-track > span')?.textContent === ${JSON.stringify(track)}).querySelectorAll('.tl-cell')[${index}].click()`);
    await delay(60);
  };
  const asset = async index => { await js(`document.querySelectorAll('.fl-item')[${index}].click()`); await delay(60); };
  const snapshot = () => js('window.fixtureOnion');
  const ids = async () => { const state = await snapshot(); return [state.frame?.id ?? null, state.prev?.id ?? null, state.next?.id ?? null]; };
  await window.loadURL(process.env.EDITOR_CHECK_URL);
  for (let n = 0; n < 80; n++) { if (await js("document.querySelectorAll('.tl-cell').length === 12 && !!document.querySelector('#onion-props-ready')")) break; await delay(50); }
  assert.equal(await js("!!document.querySelector('#onion-props-ready')"), true, 'The real Editor must mount the recording renderer');
  const before = await js("fetch('/fixture/data').then(response => response.json())");
  await check('Timeline neighbors use exact adjacent steps instead of asset or frame-array order', async () => {
    await cell('Main', 0);
    assert.deepEqual(await ids(), ['frame-0', null, 'frame-1']);
    await cell('Main', 1);
    assert.deepEqual(await ids(), ['frame-1', 'frame-0', null], 'The empty next cell must not be skipped');
  });
  await check('An empty selected cell retains its exact previous and next same-track neighbors', async () => {
    await cell('Main', 2);
    assert.deepEqual(await ids(), [null, 'frame-1', 'frame-3']);
  });
  await check('The final step does not loop or skip an empty previous cell', async () => {
    await cell('Main', 3);
    assert.deepEqual(await ids(), ['frame-3', null, null]);
  });
  await check('Copied instances on another selected track resolve without leaking other tracks', async () => {
    await cell('Overlay', 2);
    assert.deepEqual(await ids(), ['overlay', null, null]);
  });
  await check('Onion neighbors retain the timeline instance transforms and image identity', async () => {
    await cell('Main', 1);
    const state = await snapshot();
    assert.deepEqual(state.frame, before.frames.find(frame => frame.id === 'frame-1'));
    assert.deepEqual(state.prev, before.frames.find(frame => frame.id === 'frame-0'));
    assert.equal(state.composite.some(frame => frame.id === 'frame-1'), true);
  });
  await check('Asset preview uses asset neighbors and never leaks appended timeline copies', async () => {
    await asset(0); assert.deepEqual(await ids(), ['asset-0', null, 'asset-1']);
    await asset(1); assert.deepEqual(await ids(), ['asset-1', 'asset-0', 'asset-2']);
    await asset(2); assert.deepEqual(await ids(), ['asset-2', 'asset-1', null]);
  });
  await check('A hidden selected track does not expose onion neighbors', async () => {
    await cell('Hidden', 1);
    const state = await snapshot();
    assert.equal(state.prev, null);
    assert.equal(state.next, null);
    assert.equal(state.composite.some(frame => frame.track_id === 'track-hidden'), false);
  });
  await check('Browsing onion skins makes no project mutations or data identity changes', async () => {
    assert.deepEqual(await js("fetch('/fixture/mutations').then(response => response.json())"), []);
    assert.deepEqual(await js("fetch('/fixture/data').then(response => response.json())"), before);
  });
  await check('Asset transform edits immediately update both the selected frame and its onion neighbors', async () => {
    await asset(1);
    assert.equal((await snapshot()).frame.scale, 1);
    assert.equal(await js("(()=>{const plus=document.querySelector('.toolbar .transform-stepper').querySelectorAll('button')[2];if(plus.disabled)return false;plus.click();return true})()"), true);
    await delay(60);
    const current = (await snapshot()).frame;
    await asset(2); const previous = (await snapshot()).prev;
    await asset(0); const next = (await snapshot()).next;
    report.assetTransform = { current, previous, next };
    const mutations = await js("fetch('/fixture/mutations').then(response => response.json())");
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].path, '/api/frames/asset-1');
    assert.equal(mutations[0].method, 'PATCH');
    assert.deepEqual(JSON.parse(mutations[0].body), { scale: 1.1 });
    assert.deepEqual([current.id, previous.id, next.id], ['asset-1', 'asset-1', 'asset-1']);
    assert.deepEqual([current.scale, previous.scale, next.scale], [1.1, 1.1, 1.1]);
    assert.deepEqual(await js("fetch('/fixture/data').then(response => response.json())"), before, 'The fixture must not persist PATCH into its source data');
  });
  fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'editor.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(timeout); finish();
}).catch(error => { clearTimeout(timeout); report.failures.push({ name: 'Fixture initialization', error: error.stack }); finish(); });
