// 只在显式--smoke+SFS_SMOKE_SCENARIO时运行；仅使用隔离的合成验收项目。
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
module.exports=async({window,origin,service})=>{
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[];
 const js=script=>window.webContents.executeJavaScript(script);
 const wait=async(script,label)=>{for(let i=0;i<300;i++){if(await js(script))return;await pause(100);}throw new Error(label);};
 const click=async(text,selector='button')=>{await wait(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true;})()`,'button '+text);await pause(120);};
 const screenshot=async name=>fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,name),(await window.webContents.capturePage()).toPNG());
 const read=async p=>{const r=await service(p);assert.equal(r.status,200,p);return r.json();};
 await wait("document.querySelectorAll('.tl-cell img').length===3",'3 PNG timeline');
 await js("document.documentElement.dataset.theme='light'");
 await click('场景抠图与修正','.topbar button');
 for(let i=0;i<3;i++){
  await wait("!document.querySelector('.mask-loading')&&document.querySelector('[data-testid=mask-canvas]')?.width===128",'mask ready');
  await click('确认这一帧');await wait("document.querySelector('.mask-status')?.classList.contains('reviewed')",'synthetic mask review');
  if(i<2){await js("document.querySelector('.mask-frame-navigation button[aria-label=下一帧]').click()");await pause(160);}
 }
 checks.push('GUI confirms only three isolated synthetic PNG masks');
 await js("document.querySelector('.mask-heading button').click()");await pause(150);
 // 通过实际主编辑器按钮修改属性，生产预览/导出必须采用这些已保存的属性。
 await js("document.querySelector('.tl-cell').click()");await pause(150);
 const project=process.env.SFS_SMOKE_PAGE.split('/').at(-1),timeline=await read(`/api/projects/${project}/timeline`),frameId=timeline.frames[0].id;
 const stepper=async(index,button,property,expected)=>{
  await js(`document.querySelectorAll('.transform-stepper')[${index}].querySelectorAll('button')[${button}].click()`);
  for(let i=0;i<100;i++){const current=await read(`/api/projects/${project}/timeline`),frame=current.frames.find(f=>f.id===frameId);if(frame&&Math.abs(frame[property]-expected)<.00001)return;await pause(50);}throw new Error('GUI transform not saved: '+property);
 };
 await stepper(0,0,'scale',.9);await stepper(1,2,'rotation',Math.PI/12);await stepper(2,0,'opacity',.9);
 checks.push('Actual GUI scale, rotation and opacity controls persisted before production export');
 await click('导出动画','.topbar button');await wait("document.querySelector('[data-testid=alignment-workshop]')",'alignment dialog');
 await wait("document.querySelector('.alignment-canvas img')?.naturalWidth===128",'shared canvas preview');
 await click('▶','.alignment-controls button');
 await wait("document.querySelector('.alignment-source p')?.textContent.includes('65.0, 112.0')",'interpolated root field');
 await screenshot('alignment-light.png');await js("document.documentElement.dataset.theme='dark'");await screenshot('alignment-dark.png');
 // 页面中的保存流程必须禁止原图点击修改，且微调经API持久化。
 await click('设置当前根位置');await click('保存参数');
 await wait("[...document.querySelectorAll('button')].some(b=>b.innerText==='全动作越界预检'&&!b.disabled)",'alignment saved');
 await click('全动作越界预检');await wait("document.querySelector('.alignment-workshop')?.innerText.includes('所有帧均在公共画布内')",'bounds check');
 await click('确认当前修订');await wait("document.querySelector('.confirm-modal')",'explicit confirmation dialog');await click('确定','.confirm-modal button');
 await wait("document.querySelector('.alignment-workshop')?.innerText.includes('当前修订已确认，可正式导出')",'alignment review');
 await click('正式导出 PNG 与图集');await wait("document.querySelector('a[download*=zip]')",'GUI production export');
 const href=await js("document.querySelector('a[download*=zip]').getAttribute('href')"),exportId=href.split('/')[4];
 const manifest=await read(`/api/v1/exports/${exportId}/file?path=manifest.json`);assert.equal(manifest.release_mode,'reviewed');assert.equal(manifest.frames.length,3);
 assert.equal(manifest.frames[0].transform.scale,.9);assert.equal(manifest.frames[0].transform.opacity,.9);assert.ok(Math.abs(manifest.frames[0].transform.rotation-Math.PI/12)<.00001);
 const contact=await service(`/api/v1/exports/${exportId}/file?path=previews/contact-sheet.png`);assert.equal(contact.status,200);
 const archive=await service(href);assert.equal(archive.status,200);assert.ok((await archive.arrayBuffer()).byteLength>1000);
 const shape=await js("(()=>{const r=document.querySelector('.alignment-workshop').getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}})()");assert.equal(shape.fits,true);
 checks.push('Interpolated root, save, overflow check and explicit revision confirmation in real Electron');
 checks.push('Reviewed PNG/grid package, contact sheet and ZIP served by shared backend');
 await screenshot('reviewed-export.png');
 fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,'gui-export.json'),JSON.stringify({id:exportId,manifest},null,2));
 // 同一窗口打开300帧项目：惰性缩略图与实际Pixi缓存都有界。
 if(process.env.SFS_SMOKE_LARGE_PROJECT){
  await window.loadURL(origin+'/project/'+process.env.SFS_SMOKE_LARGE_PROJECT);
  await wait("document.querySelectorAll('.tl-cell img').length===300",'300 timeline cells');
  let maxTextures=0;
  for(let i=0;i<300;i++){
   await js(`document.querySelectorAll('.tl-cell')[${i}].click()`);await pause(12);
   const n=await js("[...window.PIXI.Assets.cache._cache.keys()].filter(k=>typeof k==='string'&&k.includes('/frames/')).length");maxTextures=Math.max(maxTextures,n);
  }
  await pause(1000);
  const retained=await js("[...window.PIXI.Assets.cache._cache.keys()].filter(k=>typeof k==='string'&&k.includes('/frames/')).length");
  assert.ok(retained<=16,'Pixi frame aliases must remain bounded: '+retained);
  await screenshot('300-frame-timeline.png');checks.push({test:'300 actual timeline selections',maxTextureAliases:maxTextures,retainedTextureAliases:retained});
 }
 return{ok:true,checks};
};
