const fs = require('node:fs');

module.exports = async ({window, origin, pagePath, serviceFetch, saveScreenshot, delay}) => {
  const scenario = {steps: []};
  const read = async path => { const r = await serviceFetch(origin + path); if(!r.ok) throw Error('API '+r.status); return r.json(); };
  const click = async (selector, text) => {
    const ok = await window.webContents.executeJavaScript(`(() => { const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.innerText.trim()===${JSON.stringify(text)}); if(!b || b.disabled)return false;b.click();return true;})()`);
    if(!ok)throw Error('找不到按钮: '+text); await delay(300);scenario.steps.push(text);
  };
  const until = async fn => { for(let i=0;i<150;i++){const r=await fn();if(r)return r;await delay(100);}throw Error('桌面导入等待超时'); };
  const files = [process.env.SFS_PROBE_IMAGE_FILE, process.env.SFS_PROBE_VIDEO_FILE];
  if(files.some(f=>!f || !fs.existsSync(f)))throw Error('缺少测试图片或视频');
  const setFiles = async () => {
    window.webContents.debugger.attach('1.3');
    try {
      const {root}=await window.webContents.debugger.sendCommand('DOM.getDocument');
      const {nodeId}=await window.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'.import-modal input[type=file]'});
      await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files});
    }finally{window.webContents.debugger.detach();}
    await delay(250);
  };
  const checkDefaults = async key => {
    const state = await until(async()=>window.webContents.executeJavaScript(`(() => {const m=document.querySelector('.import-modal'); if(!m?.querySelector('[data-testid="${key}"]'))return null; return {checked:[...m.querySelectorAll('input[type=checkbox]')].some(i=>i.checked),ranges:m.querySelectorAll('input[type=range]').length,generateDisabled:[...m.querySelectorAll('.import-tabs button')].find(b=>b.innerText.trim()==='生成')?.disabled};})()`));
    if(state.checked || state.ranges || !state.generateDisabled)throw Error('桌面上传界面暴露了不可用的抠图/采样/生成');
    return state;
  };
  await click('.topbar button','导入素材');
  await click('.import-modal .import-tabs button','上传文件');
  await setFiles();
  scenario.projectDefaults = await checkDefaults('sfs-project-retention');
  scenario.projectUpload = await saveScreenshot('desktop-project-import.png');
  await click('.import-modal .modal-actions button','导入 2 个文件');
  await until(async()=>{const list=await read('/api/materials');return list.materials.length===8 && list;});
  await until(()=>window.webContents.executeJavaScript("document.querySelector('.up-summary')?.innerText.includes('失败 0')"));
  await click('.import-modal .modal-actions button','完成，关闭面板');
  await window.loadURL(origin+'/materials');await delay(700);
  await click('.home-header-actions button','上传素材');
  await setFiles();
  scenario.libraryDefaults = await checkDefaults('sfs-library-retention');
  scenario.libraryUpload = await saveScreenshot('desktop-library-import.png');
  await click('.import-modal .modal-actions button','上传 2 个文件');
  const list=await until(async()=>{const r=await read('/api/materials');return r.materials.length===16 && r;});
  await until(()=>window.webContents.executeJavaScript("document.querySelector('.up-summary')?.innerText.includes('失败 0')"));
  await click('.import-modal .modal-actions button','完成，关闭面板');
  scenario.materials=list.materials.length;
  scenario.images=list.materials.filter(m=>m.kind==='image').length;
  scenario.videos=list.materials.filter(m=>m.kind==='video').length;
  const visible=await until(()=>window.webContents.executeJavaScript("document.querySelectorAll('.mat-card').length>=16"));
  scenario.libraryResult = await saveScreenshot('desktop-library-result.png');
  scenario.passed=Boolean(visible && scenario.images===14 && scenario.videos===2);
  if(!scenario.passed)throw Error('素材库真实界面结果与后端不一致');
  return scenario;
};
