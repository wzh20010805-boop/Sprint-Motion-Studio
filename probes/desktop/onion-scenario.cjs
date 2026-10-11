const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 同图不同偏移的邻帧；固定预览第1帧，对照洋葱皮开关的实际像素。
module.exports = async ({ window, saveScreenshot, delay }) => {
  const js = source => window.webContents.executeJavaScript(source);
  const clickPreview = async () => {
    assert.equal(await js("(()=>{const b=[...document.querySelectorAll('.topbar button')].find(b=>b.innerText.trim()==='播放预览');if(!b)return false;b.click();return true;})()"),true);
    await delay(500);
  };
  for(let i=0;i<100;i++){if(await js("document.querySelector('.pixi-wrap canvas')"))break;await delay(100);}
  await delay(700);
  assert.equal(await js("document.querySelector('.toolbar button')?.classList.contains('on')"),true);
  const rect=await js("(()=>{const r=document.querySelector('.pixi-wrap canvas').getBoundingClientRect();return{x:Math.round(r.x+r.width/2-90),y:Math.round(r.y+r.height/2-90),width:180,height:180}})()");
  const capture=async name=>{const image=await window.webContents.capturePage(rect);const bytes=image.toPNG();fs.writeFileSync(path.join(process.env.P0_EVIDENCE_DIR,name),bytes);return bytes;};
  const editOn=await capture('onion-edit-on.png');
  await clickPreview();
  await js("(()=>{const el=document.querySelector('.playback-range select');el.value='range';el.dispatchEvent(new Event('change',{bubbles:true}));})()");await delay(100);
  await js("(()=>{const el=document.querySelectorAll('.playback-range input')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'1');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));el.blur();})()");await delay(500);
  const previewOn=await capture('onion-preview-on.png');
  await clickPreview();
  await js("document.querySelector('.toolbar button').click()");await delay(400);
  assert.equal(await js("document.querySelector('.toolbar button')?.classList.contains('on')"),false);
  const editOff=await capture('onion-edit-off.png');
  assert.equal(editOn.equals(editOff),false,'Editor must actually show a visual onion-skin difference');
  await clickPreview();
  const previewOff=await capture('onion-preview-off.png');
  assert.equal(previewOn.equals(previewOff),true,'Playback must not contain onion skins after async image loading');
  return {passed:true,checks:['Editing onion toggle changes rendered pixels','Preview pixels identical with editing onion toggle on/off'],screenshot:await saveScreenshot('onion-preview-clean.png')};
};
