// 显式 smoke：在隔离素材副本中记录实际 Pixi 播放状态。
const fs=require('node:fs');
const path=require('node:path');
module.exports=async({window})=>{
 fs.mkdirSync(process.env.SFS_SMOKE_EVIDENCE,{recursive:true});
 const js=script=>window.webContents.executeJavaScript(script);
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 await js(`(async()=>{for(const src of ['/pixi.min.js'])await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.appendChild(script)})})()`);
 await js(`(()=>{
  const probe=window.__playbackProbe={samples:[],loads:[],apps:[],textures:{},record:false},PIXI=window.PIXI;
  const load=PIXI.Assets.load.bind(PIXI.Assets);
  PIXI.Assets.load=async(...args)=>{try{const texture=await load(...args);probe.textures[texture.uid]=args[0];return texture}catch(e){probe.loads.push({url:args[0],error:String(e)});throw e}};
  const init=PIXI.Application.prototype.init;
  PIXI.Application.prototype.init=async function(...args){const result=await init.apply(this,args);probe.apps.push(this);this.ticker.add(()=>{
   if(!probe.record)return;
   const layer=this.stage.children[0]?.children[3];if(!layer)return;
   const sprites=layer.children.filter(s=>s instanceof PIXI.Sprite);
   probe.samples.push({time:performance.now(),count:sprites.length,visible:sprites.filter(s=>s.visible).length,valid:sprites.filter(s=>s.visible&&!s.texture.destroyed&&!s.texture.source?.destroyed&&s.texture.source?.width>0).length,urls:sprites.filter(s=>s.visible).map(s=>probe.textures[s.texture.uid]),positions:sprites.map(s=>[s.x,s.y,s.scale.x,s.scale.y])});
  });return result};
 })()`);
 for(let i=0;i<100;i++){if(await js("document.querySelector('.project-card')!==null"))break;await pause(100);}
 await js("document.querySelector('.project-card').click()");
 for(let i=0;i<100;i++){if(await js("document.querySelectorAll('.tl-cell img').length>=27&&window.__playbackProbe.apps.length>0"))break;await pause(100);}
 await pause(400);
 const button=await js(`(()=>{const b=[...document.querySelectorAll('.topbar button')].find(b=>b.innerText.includes('播放预览'));if(!b)return false;window.__playbackProbe.record=true;b.click();return true})()`);
 if(!button)throw new Error('预览按钮不存在');
 await pause(6000);
 await js("[...document.querySelectorAll('.topbar button')].find(b=>b.innerText.includes('播放预览')).click()");await pause(400);
 await js("[...document.querySelectorAll('.topbar button')].find(b=>b.innerText.includes('播放预览')).click()");await pause(600);
 const result=await js("({samples:window.__playbackProbe.samples,errors:window.__playbackProbe.loads,playing:!!document.querySelector('.stage-shell.playing')})");
 result.blank=result.samples.filter(s=>!s.valid).length;result.total=result.samples.length;
 result.displayedFrames=new Set(result.samples.flatMap(s=>s.urls).filter(Boolean)).size;
 const deleteButton=await js("(()=>{const b=document.querySelector('.attack-delete'),buttons=[...b.closest('.attack-toolbar').querySelectorAll('button')],n=buttons[buttons.indexOf(b)-1];return {height:b.getBoundingClientRect().height,neighborHeight:n.getBoundingClientRect().height,width:b.getBoundingClientRect().width}})()");
 result.deleteButton=deleteButton;
 fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,'playback.json'),JSON.stringify(result,null,2));
 fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,'editor.png'),(await window.webContents.capturePage()).toPNG());
 const rect=await js("(()=>{const b=document.querySelector('.attack-delete'),r=b.getBoundingClientRect();return {x:Math.max(0,Math.round(r.x-60)),y:Math.max(0,Math.round(r.y-8)),width:Math.min(160,innerWidth-Math.max(0,Math.round(r.x-60))),height:48}})()");
 fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,'delete-button.png'),(await window.webContents.capturePage(rect)).toPNG());
 return {ok:result.total>50&&result.blank===0&&result.displayedFrames===27&&Math.abs(deleteButton.height-deleteButton.neighborHeight)<1,total:result.total,blank:result.blank,displayedFrames:result.displayedFrames,errors:result.errors,deleteButton};
};
