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
  window.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('503')) report.consoleErrors.push(event.message); });
  const js = source => window.webContents.executeJavaScript(source);
  const check = async (name, work) => { try { await work(); report.checks.push(name); } catch (e) { report.failures.push({ name, error: e.stack }); } };
  const data = () => js("fetch('/fixture/data').then(r=>r.json())");
  const command = kind => js(`window.fixtureCommands.execute('${kind}')`);
  const key = async (keyCode, modifiers = []) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(250); };
  const input = async (selector, value, index = 0) => { await js(`(()=>{const el=document.querySelectorAll(${JSON.stringify(selector)})[${index}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await delay(40); };
  const reset = async (mode, selector) => {
    await js("fetch('/fixture/reset',{method:'POST'})"); await window.loadURL(process.env.EDITOR_CHECK_URL + '?mode=' + mode);
    for (let n = 0; n < 100; n++) { if (await js(`!!document.querySelector(${JSON.stringify(selector)}) && !!window.fixtureCommands.state().label`)) { await delay(80); return; } await delay(40); }
    throw new Error('Fixture did not mount: ' + mode);
  };
  await window.loadURL(process.env.EDITOR_CHECK_URL);
  await check('Skeleton edits have local undo and explicit save persists the current draft', async () => {
    await reset('skeleton', '.skeleton-editor');
    await js("document.querySelector('.skeleton-editor-inspector header button').click()"); await delay(60);
    assert.equal(await js("document.querySelectorAll('.skeleton-bone-tree button').length"), 3);
    assert.equal((await command('undo')).ok, true);
    assert.equal(await js("document.querySelectorAll('.skeleton-bone-tree button').length"), 2);
    await js("document.querySelector('.skeleton-editor-inspector header button').click()"); await delay(40);
    assert.equal((await command('save')).ok, true); assert.equal((await data()).skeleton.bones.length, 3);
    assert.equal((await command('undo')).ok, true); assert.equal((await command('save')).ok, true);
    assert.equal((await data()).skeleton.bones.length, 2);
  });
  await check('Binding commands use draft history and save normalized attachment slots', async () => {
    await reset('binding', '.binding-editor');
    await js("document.querySelector('.binding-editor-actions button').click()"); await delay(50);
    assert.equal((await command('undo')).ok, true); assert.equal(await js("document.querySelectorAll('.binding-part-group button').length"), 1);
    await js("document.querySelector('.binding-editor-actions button').click()"); await delay(50);
    assert.equal((await command('save')).ok, true);
    const saved = (await data()).document.character.binding;
    assert.equal(saved.attachments.length, 2); assert.deepEqual(saved.slots.map(slot => slot.drawOrder), [0, 1]);
  });
  await check('Skeleton asset save merges pending bone and rename edits without stale metadata overwrite', async () => {
    await reset('workspace-skeleton', '.skeleton-editor');
    await input('.skeleton-editor-fields input', 19);
    await js("document.querySelector('.animation-preview > header button').click()"); await delay(40);
    await input('.animation-preview > header input', '骨骼合并保存');
    assert.equal((await command('save')).ok, true);
    const saved = await data(); assert.equal(saved.mutations.length, 1); assert.equal(saved.skeleton.name, '骨骼合并保存');
    assert.equal(saved.skeleton.bones[0].rest.translation[0], 19);
  });
  await check('Clip save merges pose, name and duration into one write; undo persists the exact previous clip', async () => {
    await reset('clip', '.animation-key-editor'); const before = (await data()).clip;
    await input('.animation-key-editor .animation-root-fields input', 17);
    await input('.animation-duration-setting input', 3);
    await js("document.querySelector('.animation-preview > header button').click()"); await delay(40);
    await input('.animation-preview > header input', '动作合并保存');
    assert.equal((await command('save')).ok, true);
    const saved = await data(); assert.equal(saved.mutations.length, 1); assert.equal(saved.clip.name, '动作合并保存'); assert.equal(saved.clip.duration, 3);
    assert.equal(saved.clip.tracks.find(track => track.targetId === 'root' && track.property === 'translation').keyframes[0].value[0], 17);
    assert.equal((await command('undo')).ok, true); assert.deepEqual((await data()).clip, before);
  });
  await check('Clip save failure reports failure and preserves unsaved pose for retry', async () => {
    await reset('clip', '.animation-key-editor'); const before = (await data()).clip;
    await input('.animation-key-editor .animation-root-fields input', 23);
    await js("fetch('/fixture/fail-next',{method:'POST'})"); assert.equal((await command('save')).ok, false);
    assert.deepEqual((await data()).clip, before);
    assert.equal(await js("document.querySelector('.animation-key-editor .animation-root-fields input').value"), '23');
    assert.equal(await js("window.fixtureCommands.state().dirty"), true);
    assert.equal((await command('save')).ok, true);
    assert.equal((await data()).clip.tracks.find(track => track.targetId === 'root' && track.property === 'translation').keyframes[0].value[0], 23);
  });
  await check('Clip save combines staged bone and attachment edits at the same time', async () => {
    await reset('clip-parts', '.animation-key-editor');
    await input('.animation-key-editor .animation-root-fields input', 11);
    await js("document.querySelector('.animation-motion-stage svg image').dispatchEvent(new MouseEvent('click',{bubbles:true}))"); await delay(60);
    await input('.animation-key-editor .animation-root-fields input', 29);
    await input('.animation-duration-setting input', 4);
    assert.equal((await command('save')).ok, true);
    const saved = await data(); assert.equal(saved.mutations.length, 1); assert.equal(saved.clip.duration, 4);
    assert.equal(saved.clip.tracks.find(track => track.targetId === 'root' && track.property === 'translation').keyframes[0].value[0], 11);
    assert.equal(saved.clip.tracks.find(track => track.targetId === 'att:region' && track.property === 'translation').keyframes[0].value[0], 29);
  });
  await check('Skeletal project saves focused fields and document undo waits for pending autosave', async () => {
    await reset('project', '.skeletal-action-settings'); const before = (await data()).document;
    await input('.skeletal-action-settings input[type=number]', 2.5);
    await js("document.querySelector('.skeletal-action-settings input[type=number]').focus()"); await key('S', ['control']);
    assert.equal((await data()).document.animations[0].speed, 2.5);
    assert.equal((await command('undo')).ok, true); assert.deepEqual((await data()).document, before);
    await js("document.querySelector('.skeletal-action-settings input[type=checkbox]').click()"); await delay(25);
    assert.equal((await command('undo')).ok, true); assert.deepEqual((await data()).document, before);
    assert.ok((await data()).mutations.every(mutation => mutation.path === '/api/projects/fixture/skeletal-document'));
  });
  await check('Failed project undo preserves its saved state and history for a successful retry', async () => {
    await reset('project', '.skeletal-action-settings'); const before = (await data()).document;
    await input('.skeletal-action-settings input[type=number]', 3);
    assert.equal((await command('save')).ok, true);
    await js("fetch('/fixture/fail-next',{method:'POST'})"); assert.equal((await command('undo')).ok, false);
    assert.equal((await data()).document.animations[0].speed, 3);
    assert.equal(await js("document.querySelector('.skeletal-action-settings input[type=number]').value"), '3');
    assert.equal((await command('undo')).ok, true); assert.deepEqual((await data()).document, before);
  });
  await check('An older project save response cannot overwrite a newer unsaved field draft', async () => {
    await reset('project', '.skeletal-action-settings');
    await input('.skeletal-action-settings input[type=number]', 2);
    await js("void window.fixtureCommands.execute('save').then(result=>window.fixtureLastResult=result)"); await delay(25);
    await input('.skeletal-action-settings input[type=text], .skeletal-action-settings input:not([type])', '保存期间的新名称');
    await delay(180);
    assert.equal(await js("window.fixtureLastResult.ok"), true);
    assert.equal(await js("document.querySelector('.skeletal-action-settings input').value"), '保存期间的新名称');
    assert.notEqual((await data()).document.animations[0].name, '保存期间的新名称');
    assert.equal((await command('save')).ok, true);
    assert.equal((await data()).document.animations[0].name, '保存期间的新名称');
  });
  await check('Binding modal receives commands without undoing the project behind it', async () => {
    await reset('project', '.skeletal-action-settings');
    await js("document.querySelector('.skeletal-project-tabs button').click()"); await delay(50);
    await js("document.querySelector('.skeletal-binding-overview header button').click()"); await delay(80);
    assert.equal(await js("window.fixtureCommands.state().priority"), 30);
    await js("document.querySelector('.binding-editor-actions button').click()"); await delay(50);
    assert.equal((await command('undo')).ok, true); assert.deepEqual((await data()).mutations, []);
  });
  await check('Failed binding save preserves its draft and undo history without changing the parent document', async () => {
    await reset('project', '.skeletal-action-settings'); const before = (await data()).document;
    await js("document.querySelector('.skeletal-project-tabs button').click()"); await delay(40);
    await js("document.querySelector('.skeletal-binding-overview header button').click()"); await delay(70);
    await js("document.querySelector('.binding-editor-actions button').click()"); await delay(40);
    await js("fetch('/fixture/fail-next',{method:'POST'})"); assert.equal((await command('save')).ok, false);
    assert.deepEqual((await data()).document, before);
    assert.equal(await js("document.querySelectorAll('.binding-part-group button').length"), 2);
    assert.equal((await command('undo')).ok, true);
    assert.equal(await js("document.querySelectorAll('.binding-part-group button').length"), 1);
    assert.equal((await js("window.fixtureCommands.flush()")).ok, true);
    assert.equal((await data()).mutations.length, 1);
  });
  await check('Crop modal has local selection undo and Ctrl+S confirms real cropped PNG pixels', async () => {
    await reset('crop', '.crop-modal');
    for (let n = 0; n < 80 && !await js("window.fixtureCommands.state().canSave"); n++) await delay(30);
    assert.equal(await js("window.fixtureCommands.state().priority"), 100);
    await input('.crop-nums input', 16, 2); assert.equal((await command('undo')).ok, true);
    assert.equal(await js("document.querySelectorAll('.crop-nums input')[2].value"), '32');
    await input('.crop-nums input', 12, 2); await key('S', ['control']);
    assert.deepEqual(await js("({width:window.fixtureImageOutput.width,height:window.fixtureImageOutput.height})"), { width: 12, height: 32 });
    const saved = await data(); assert.equal(saved.mutations.length, 1); assert.equal(saved.mutations[0].body.slot, 'processed'); assert.equal(saved.mutations[0].succeeded, true);
  });
  await check('Crop save detects a failed image POST even when its parent swallows the error', async () => {
    await reset('crop-swallow', '.crop-modal');
    for (let n = 0; n < 80 && !await js("window.fixtureCommands.state().canSave"); n++) await delay(30);
    await input('.crop-nums input', 16, 2); await js("fetch('/fixture/fail-next',{method:'POST'})");
    assert.equal((await command('save')).ok, false); assert.equal((await data()).mutations[0].succeeded, false);
    assert.equal(await js("document.querySelectorAll('.crop-nums input')[2].value"), '16');
    assert.equal((await command('save')).ok, true);
  });
  await check('Color-key targets and options undo locally; save confirms real transparent output', async () => {
    await reset('color', '.color-key-modal');
    for (let n = 0; n < 80 && !await js("!!document.querySelector('.color-key-swatches:not(.selected) button')"); n++) await delay(30);
    await js("document.querySelector('.color-key-swatches:not(.selected) button').click()"); await delay(40);
    await input('.color-key-range input', 20); await input('.color-key-range input', 6, 1);
    assert.equal((await command('undo')).ok, true); assert.equal(await js("document.querySelectorAll('.color-key-range input')[1].value"), '0');
    assert.equal((await command('undo')).ok, true); assert.equal(await js("document.querySelector('.color-key-range input').value"), '0');
    assert.equal((await command('undo')).ok, true); assert.equal(await js("document.querySelectorAll('.color-key-swatches.selected button').length"), 0);
    assert.deepEqual((await data()).mutations, []);
    await js("document.querySelector('.color-key-swatches:not(.selected) button').click()"); await delay(40);
    assert.equal((await command('save')).ok, true); assert.equal(await js("window.fixtureImageOutput.alphaSum"), 0);
    assert.equal((await data()).mutations[0].body.slot, 'processed');
  });
  await check('Color-key save detects swallowed image-write failures and retains options for retry', async () => {
    await reset('color-swallow', '.color-key-modal');
    for (let n = 0; n < 80 && !await js("!!document.querySelector('.color-key-swatches:not(.selected) button')"); n++) await delay(30);
    await js("document.querySelector('.color-key-swatches:not(.selected) button').click()"); await delay(40);
    await js("fetch('/fixture/fail-next',{method:'POST'})"); assert.equal((await command('save')).ok, false);
    assert.equal(await js("document.querySelectorAll('.color-key-swatches.selected button').length"), 1);
    assert.equal((await command('save')).ok, true); assert.equal(await js("window.fixtureImageOutput.alphaSum"), 0);
  });
  await check('Cancelling failed crop or color-key editing clears abandoned image writes without replaying them', async () => {
    for (const mode of ['crop-swallow', 'color-swallow']) {
      await reset(mode, mode.startsWith('crop') ? '.crop-modal' : '.color-key-modal');
      if (mode.startsWith('crop')) {
        for (let n = 0; n < 80 && !await js("window.fixtureCommands.state().canSave"); n++) await delay(30);
      } else {
        for (let n = 0; n < 80 && !await js("!!document.querySelector('.color-key-swatches:not(.selected) button')"); n++) await delay(30);
        await js("document.querySelector('.color-key-swatches:not(.selected) button').click()"); await delay(40);
      }
      await js("fetch('/fixture/fail-next',{method:'POST'})"); assert.equal((await command('save')).ok, false);
      await js("document.querySelector('.modal-actions button').click()"); await delay(40);
      assert.equal((await js("window.fixtureCommands.flush()")).ok, true);
      assert.equal((await data()).mutations.length, 1);
    }
  });
  await reset('project', '.skeletal-action-settings');
  fs.writeFileSync(join(process.env.EDITOR_CHECK_OUTPUT, 'editor.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(timeout); finish();
}).catch(e => { clearTimeout(timeout); report.failures.push({ name: 'Fixture initialization', error: e.stack }); finish(); });
