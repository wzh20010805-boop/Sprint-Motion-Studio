const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),{join}=require('node:path'),{createHash}=require('node:crypto');
const output=process.env.SFS_REVIEW_OUTPUT,url=process.env.SFS_REVIEW_URL;
app.setPath('userData',join(output,'profile'));
const report={scope:'Actual legacy Editor/Alignment routing plus fixed-candidate callback; synthetic core setup acceptance, no GUI acceptance',checks:[],failures:[],consoleErrors:[],expectedNetworkErrors:[],downloads:[]};
let window,finished=false;const delay=ms=>new Promise(r=>setTimeout(r,ms));
function finish(){if(finished)return;finished=true;report.passed=!report.failures.length&&!report.consoleErrors.length;fs.writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));if(window&&!window.isDestroyed())window.destroy();app.exit(report.passed?0:1);}
const timeout=setTimeout(()=>{report.failures.push({name:'timeout'});finish();},90000);
app.whenReady().then(async()=>{
 const sess=session.fromPartition('compat-'+Date.now());
 // Never allow an accidental download into a user's default Downloads directory.
 sess.on('will-download',(event,item)=>{event.preventDefault();report.failures.push({name:'unexpected native download',filename:item.getFilename()});});
 window=new BrowserWindow({width:1440,height:1100,show:false,webPreferences:{session:sess,sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 window.webContents.on('console-message',e=>{if(e.level==='error')(e.message.includes('Failed to load resource')?report.expectedNetworkErrors:report.consoleErrors).push(e.message);});
 const js=code=>window.webContents.executeJavaScript(code),until=async(code,ms=15000)=>{const start=Date.now();while(Date.now()-start<ms){if(await js(code))return;await delay(40);}throw Error('Timeout: '+code);};
 const clickText=(selector,text)=>js(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.includes(${JSON.stringify(text)})).click()`);
 const check=async(name,fn)=>{try{await fn();report.checks.push(name);}catch(e){report.failures.push({name,error:e.stack,dom:await js('document.body.innerText')});fs.writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());throw e;}};
 await window.loadURL(url);await until(`!!window.editorFixture&&!!document.querySelector('.pixi-wrap canvas')`);
 // Explicit Blob interception validates actual UI callback bytes without creating a user download.
 await js(`window.compatDownloads=[];HTMLAnchorElement.prototype.click=function(){const href=this.href,name=this.download;window.compatDownloads.push(fetch(href).then(async r=>{const bytes=await r.arrayBuffer();return {name,href,status:r.status,size:bytes.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('')};}));};void 0;`);
 await check('token-free Editor discovery reports 401 honestly; old Alignment formal export still succeeds',async()=>{
  await until(`!!document.querySelector('[data-collaboration="panel"] [role="alert"]')`);
  assert.deepEqual(await js(`({cookie:document.cookie,require:typeof require,process:typeof process})`),{cookie:'',require:'undefined',process:'undefined'});
  await clickText('header button','导出动画');await until(`!!document.querySelector('[data-testid="alignment-workshop"]')`);await clickText('.alignment-workshop footer button','正式导出');
  await until(`!!document.querySelector('.alignment-workshop a[download="assets.zip"]')`,30000);
  await js(`document.querySelector('.alignment-workshop a[download="assets.zip"]').click()`);const downloads=await js('Promise.all(window.compatDownloads)');assert.equal(downloads.length,1);assert.equal(downloads[0].status,200);assert.ok(downloads[0].size>100);report.downloads.push({...downloads[0],evidence:'intercepted actual legacy link Blob; service file remains in owned workspace'});
  const requests=await js(`fetch('/fixture/requests').then(r=>r.json())`);assert.ok(requests.some(r=>r.path.endsWith('/action')&&r.status===401&&!r.cookie));assert.equal(requests.filter(r=>r.path==='/api/v1/export'&&r.method==='POST').length,1);report.legacy_requests=requests;
  fs.writeFileSync(join(output,'legacy-editor-export.png'),(await window.webContents.capturePage()).toPNG());await clickText('.alignment-workshop header button','关闭');
 });
 await check('resolver rejection is shown without legacy fallback or a second export',async()=>{
  await js(`fetch('/fixture/reject?value=true').then(r=>r.json())`);await clickText('header button','导出动画');await until(`!!document.querySelector('.alignment-workshop')`);await clickText('.alignment-workshop footer button','正式导出');await until(`document.querySelector('.toast-stack').textContent.includes('compatibility resolver rejection')`);
  const requests=await js(`fetch('/fixture/requests').then(r=>r.json())`);assert.equal(requests.filter(r=>r.path==='/api/v1/export'&&r.method==='POST').length,1);assert.ok(requests.some(r=>r.path.endsWith('/export/resolve')&&r.status===409));await js(`fetch('/fixture/reject?value=false').then(r=>r.json())`);await clickText('.alignment-workshop header button','关闭');
 });
 await check('authenticated known Task has readable controls in zh/light and en/dark',async()=>{
  await sess.cookies.set({url,name:'sfs_reviewer',value:process.env.SFS_REVIEW_COOKIE,httpOnly:true,sameSite:'strict',path:'/'});
  await js(`window.editorFixture.mount(window.editorFixture.identity.collaborationContext.project_id)`);await until(`!!document.querySelector('[data-collaboration="open-review"]')&&!document.querySelector('[data-collaboration="open-review"]').disabled`);
  report.styles=[];for(const lang of ['zh','en']){await js(`window.editorFixture.language('${lang}');document.documentElement.dataset.theme='${lang==='zh'?'light':'dark'}'`);await delay(100);const styles=await js(`['[data-collaboration="open-review"]','[data-collaboration="task"]'].map(s=>{const e=document.querySelector(s),c=getComputedStyle(e);return {selector:s,color:c.color,background:c.backgroundColor,text:e.textContent}})`);assert.ok(styles.every(s=>s.color!==s.background));report.styles.push({lang,styles});fs.writeFileSync(join(output,'panel-'+lang+'.png'),(await window.webContents.capturePage()).toPNG());}
 });
 await check('actual Alignment fixed callback downloads exact fixed bytes without legacy renderer',async()=>{
  await clickText('header button','Export animation');await until(`!!document.querySelector('.alignment-workshop')`);await js(`document.querySelector('.alignment-workshop footer button.accent:last-of-type').click()`);
  await until('window.compatDownloads.length===2');const downloads=await js('Promise.all(window.compatDownloads)'),identity=await js('window.editorFixture.identity');
  const fixedResponse=await fetch(new URL(identity.fixed.files[0].url,url)),fixedBytes=Buffer.from(await fixedResponse.arrayBuffer());assert.equal(fixedResponse.status,200);assert.equal(downloads[1].sha256,createHash('sha256').update(fixedBytes).digest('hex'));report.downloads.push({...downloads[1],evidence:'actual exportAnimation anchor Blob interception; exact existing delivery bytes',fixed_sha256:createHash('sha256').update(fixedBytes).digest('hex')});
  const requests=await js(`fetch('/fixture/requests').then(r=>r.json())`);assert.equal(requests.filter(r=>r.path==='/api/v1/export'&&r.method==='POST').length,1);assert.ok(requests.filter(r=>r.path==='/api/v1/export/resolve'&&r.query.includes(identity.taskId)&&r.cookie&&r.status===200).length>=2);report.final_requests=requests;
 });
 await js('window.editorFixture.unmount()');await delay(100);clearTimeout(timeout);finish();
}).catch(e=>{clearTimeout(timeout);if(!report.failures.length)report.failures.push({name:'initialization',error:e.stack});finish();});
