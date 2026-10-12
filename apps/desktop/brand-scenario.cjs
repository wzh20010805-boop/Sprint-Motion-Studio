// 仅显式 smoke 使用，检查实际首页的品牌文案、配色与布局。
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
module.exports=async({window})=>{
 const js=script=>window.webContents.executeJavaScript(script);
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 for(let i=0;i<100;i++){
  if(await js("!!document.querySelector('.candy-hero')"))break;
  await pause(100);
 }
 const checks=[];
 for(let i=0;i<100;i++){if(await js("document.querySelector('.candy-doodle')?.complete&&document.querySelector('.candy-doodle')?.naturalWidth>0"))break;await pause(100);}
 for(const [name,width,theme] of [['home-light',1360,'light'],['home-dark',1360,'dark'],['home-narrow',760,'light']]){
  window.setSize(width,900);await pause(200);
  await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
  await js("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  const state=await js(`(()=>{
   const hero=document.querySelector('.candy-hero'),art=hero.querySelector('.candy-doodle'),title=hero.querySelector('h2');
   const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
   return {brand:document.querySelector('.home-header h1').textContent.trim(),title:title.textContent,documentTitle:document.title,theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),imageWidth:art.naturalWidth,imageHeight:art.naturalHeight,imageSrc:art.getAttribute('src'),hero:rect(hero),art:rect(art),text:rect(title),viewport:innerWidth,remoteImages:[...document.images].filter(i=>/^https?:/.test(i.src)&&new URL(i.src).origin!==location.origin).length};
  })()`);
  assert.equal(state.brand,'素材创意工坊');assert.equal(state.title,'让创意，动起来！');assert.equal(state.documentTitle,'素材创意工坊 · Sprite Motion Studio');
  assert.equal(state.theme,theme);assert.ok(state.imageWidth>0&&state.imageHeight>0);assert.equal(state.remoteImages,0);
  assert.ok(state.hero.right<=state.viewport+1&&state.hero.left>=0,'hero must fit viewport');
  assert.ok(state.art.left>=state.hero.left&&state.art.right<=state.hero.right,'art must fit hero');
  assert.ok(state.text.right<=state.art.left+1,'text and art must not overlap');
  assert.ok(state.text.width>=160,'slogan needs readable line width');
  fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,name+'.png'),(await window.webContents.capturePage()).toPNG());checks.push({name,...state});
  const rect={x:Math.floor(state.hero.left),y:Math.floor(state.hero.top),width:Math.ceil(state.hero.width),height:Math.ceil(state.hero.height+8)};
  fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,name.replace('home','hero')+'.png'),(await window.webContents.capturePage(rect)).toPNG());
 }
 return {ok:true,checks};
};
