const assert = require("node:assert/strict");

// 在真实 Electron/React/Pixi 页面上验证，所有数据由隔离探针创建。
module.exports = async ({ window, origin, pagePath, serviceFetch, saveScreenshot, delay }) => {
  const projectId = pagePath.slice("/project/".length);
  const readTimeline = async () => (await serviceFetch(`${origin}/api/projects/${projectId}/timeline`)).json();
  const before = await readTimeline();
  const report = { projectId, frameCount: before.steps.length, checks: [] };
  const js = source => window.webContents.executeJavaScript(source);
  const read = () => js(`(() => {
    const bar = document.querySelector('.playback-bar');
    return { frame: Number(bar?.querySelector('.frame-indicator')?.textContent.split('/')[0]),
      mode: bar?.querySelector('.playback-range select')?.value,
      inputs: [...(bar?.querySelectorAll('.playback-range input') || [])].map(input => input.value) };
  })()`);
  const clickTitle = title => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.title === ${JSON.stringify(title)} || b.innerText.trim() === ${JSON.stringify(title)}); if (!b) throw new Error('缺少按钮: ' + ${JSON.stringify(title)}); b.click(); })()`);
  const mode = async value => {
    await js(`(() => { const el = document.querySelector('.playback-range select'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await delay(120);
  };
  const input = async (index, value) => {
    await js(`(() => { const el = document.querySelectorAll('.playback-range input')[${index}]; el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await delay(60);
    await js(`(() => { const el = document.querySelectorAll('.playback-range input')[${index}]; el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); el.blur(); })()`);
    await delay(100);
  };
  for (let i = 0; i < 100; i++) {
    if (await js("[...document.querySelectorAll('.topbar button')].some(button => button.innerText.trim() === '播放预览')")) break;
    await delay(100);
  }
  await clickTitle("播放预览");
  await delay(150);
  await clickTitle("暂停");
  assert.equal((await read()).mode, "all");
  report.checks.push("默认全部帧");
  await mode("range");
  await input(0, "10");
  await input(1, "30");
  assert.deepEqual(await read(), { frame: 10, mode: "range", inputs: ["10", "30"] });
  report.checks.push("多位起止帧输入及暂停时定位");
  report.screenshot = await saveScreenshot("playback-range.png");

  await input(1, "10");
  await clickTitle("继续");
  await delay(850);
  assert.equal((await read()).frame, 10);
  await clickTitle("暂停");
  report.checks.push("单帧循环");

  // 第2帧 duration=3，第3帧 duration=1，4 FPS；两个端点都必须出现。
  await input(0, "2");
  await input(1, "3");
  await clickTitle("继续");
  report.samples = [];
  for (let i = 0; i < 48; i++) {
    report.samples.push((await read()).frame);
    await delay(50);
  }
  await clickTitle("暂停");
  assert.ok(report.samples.every(frame => frame === 2 || frame === 3), "播放不得离开2–3帧");
  const twos = report.samples.filter(frame => frame === 2).length;
  const threes = report.samples.filter(frame => frame === 3).length;
  assert.ok(twos > threes * 1.8 && threes > 0, "duration=3的帧必须明显停留更久");
  report.checks.push("范围端点循环和每帧时长");

  await input(0, "");
  assert.deepEqual((await read()).inputs, ["2", "3"]);
  await input(1, "999");
  assert.deepEqual((await read()).inputs, ["2", "48"]);
  report.checks.push("空输入取消，越界输入限于时间轴");
  await mode("all");
  assert.equal((await read()).frame, 1);
  await clickTitle("继续");
  await delay(1300);
  assert.ok((await read()).frame > 3);
  await clickTitle("暂停");
  report.checks.push("恢复全部帧并播放范围外帧");

  const after = await readTimeline();
  assert.deepEqual(after, before, "预览操作不得修改时间轴、素材或FPS");
  report.checks.push("预览范围未写入项目数据");

  await mode("range");
  await input(0, "46");
  await input(1, "48");
  for (const step of before.steps.slice(-3)) {
    const status = await js(`fetch('/api/steps/' + ${JSON.stringify(step.id)}, { method: 'DELETE' }).then(response => response.status)`);
    assert.equal(status, 200);
  }
  for (let i = 0; i < 30 && (await read()).inputs[0] !== "45"; i++) await delay(100);
  assert.deepEqual(await read(), { frame: 45, mode: "range", inputs: ["45", "45"] });
  report.checks.push("删帧后范围和游标自动收缩");
  await clickTitle("添加动画轴");
  for (let i = 0; i < 30 && (await read()).mode !== "all"; i++) await delay(100);
  assert.equal((await read()).mode, "all");
  assert.deepEqual((await read()).inputs, []);
  report.checks.push("切换新动作重置为全部帧");
  report.passed = true;
  return report;
};
