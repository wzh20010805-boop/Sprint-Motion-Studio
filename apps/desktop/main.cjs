const {app,BrowserWindow,session,dialog,Menu}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {initializeDesktopSession}=require('./review-bootstrap.cjs');

const root=path.resolve(process.resourcesPath,'..');
const smoke=process.argv.includes('--smoke');
const userRoot=path.join(process.env.LOCALAPPDATA||app.getPath('userData'),'SpriteMotionStudio');
app.setPath('userData',path.join(userRoot,'desktop'));
const configPath=path.join(app.getPath('userData'),'preferences.json');
let preferences={};try{preferences=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{}
let workspace=path.resolve(process.env.SFS_WORKSPACE||preferences.workspace||path.join(userRoot,'workspaces/default'));
let window,info,origin,closing=false;
const report={phase:'P5',events:[],console:[],networkBlocked:[],preferences:null};
const writeReport=()=>{if(process.env.SFS_SMOKE_EVIDENCE){fs.mkdirSync(process.env.SFS_SMOKE_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,'desktop.json'),JSON.stringify(report,null,2));}};
const service=(pathname,init={})=>fetch(origin+pathname,{...init,headers:{...init.headers,Authorization:`Bearer ${info.token}`}});
async function startService(){
 const cli=path.join(root,'sfs.exe');
 const child=spawn(cli,['project','list','--workspace',workspace,'--json'],{windowsHide:true,cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,SFS_REPO_ROOT:root}});
 let output='',error='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>error+=v);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw new Error(`本地服务启动失败 (${code})。${error}\n${JSON.parse(output||'{}').error?.message||''}`);
 info=JSON.parse(fs.readFileSync(path.join(workspace,'.sfs/service.json'),'utf8'));
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url)||!/^[a-f0-9]{64}$/.test(info.token)||path.resolve(info.workspace)!==workspace)throw new Error('服务连接描述无效');
 origin=info.url;const health=await(await service('/api/health')).json();if(health.pid!==info.pid||health.instance_id!==info.instance_id)throw new Error('服务启动标识不匹配');
 report.events.push('shared-service-ready');
}
async function closeWindow(event){
 if(closing||smoke)return;
 event.preventDefault();
 const jobs=await(await service('/api/jobs')).json();const active=jobs.jobs.filter(j=>['queued','running'].includes(j.status));
 if(active.length){const choice=await dialog.showMessageBox(window,{type:'question',title:'后台任务',message:`仍有 ${active.length} 个处理任务`,buttons:['保留后台并关闭','取消任务并关闭','返回软件'],defaultId:0,cancelId:2});if(choice.response===2)return;if(choice.response===1)for(const job of active)await service(`/api/v1/jobs/${job.id}/cancel`,{method:'POST'});}
 closing=true;window.close();
}
const modelName='u2netp.onnx',modelSha='309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8';
async function installModel(download){
 const text='本地 CPU 模型 u2netp，约 4.6 MiB。来源：github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx；U-2-Net 模型来源和 Apache-2.0 许可见随包 licenses/model-u2net.md。视频不会上传。';
 if(download){const choice=await dialog.showMessageBox(window,{type:'question',message:text,buttons:['下载模型','取消'],defaultId:1,cancelId:1});if(choice.response!==0)return;}
 let bytes;
 if(download){const response=await fetch('https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`模型下载失败 HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
 else{const choice=await dialog.showOpenDialog(window,{title:'离线导入 u2netp 模型',properties:['openFile'],filters:[{name:'ONNX',extensions:['onnx']}]});if(choice.canceled)return;bytes=fs.readFileSync(choice.filePaths[0]);}
 if(createHash('sha256').update(bytes).digest('hex')!==modelSha)throw new Error('模型 SHA256 不匹配，未安装');
 const directory=path.join(userRoot,'models');fs.mkdirSync(directory,{recursive:true});const temp=path.join(directory,'model-'+Date.now()+'.tmp');fs.writeFileSync(temp,bytes);fs.renameSync(temp,path.join(directory,modelName));
 await dialog.showMessageBox(window,{type:'info',message:'本地模型已准备，可继续生成抠图初稿。'});
}
async function selectWorkspace(){
 const jobs=await(await service('/api/jobs')).json();if(jobs.jobs.some(j=>['queued','running'].includes(j.status))){await dialog.showMessageBox(window,{message:'当前工作区有任务，请完成或取消后再切换。'});return;}
 const selected=await dialog.showOpenDialog(window,{title:'选择素材工作区',properties:['openDirectory','createDirectory']});if(selected.canceled)return;
 preferences.workspace=selected.filePaths[0];fs.mkdirSync(path.dirname(configPath),{recursive:true});fs.writeFileSync(configPath,JSON.stringify(preferences));
 process.env.SFS_WORKSPACE=selected.filePaths[0];
 app.relaunch({args:process.argv.slice(1),execPath:process.execPath});closing=true;app.exit(0);
}
async function launch(){
 await startService();
 const {session:desktopSession}=await initializeDesktopSession(session,workspace,info);
 report.events.push('review-session-ready');
 const html=await(await service('/')).text();const hashes=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1].replace(/\r\n?/g,'\n')).filter(Boolean).map(s=>`'sha256-${createHash('sha256').update(s).digest('base64')}'`);
 const csp=`default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' data: blob: ${origin.replace('http:','ws:')}; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'self'`;
 desktopSession.webRequest.onBeforeRequest((details,callback)=>{const allowed=details.url.startsWith(origin+'/')||details.url.startsWith(origin.replace('http:','ws:')+'/')||/^(data:|blob:)/.test(details.url);if(!allowed)report.networkBlocked.push(details.url);callback({cancel:!allowed});});
 desktopSession.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[csp]}}));
 desktopSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
 desktopSession.setPermissionCheckHandler(()=>false);
 window=new BrowserWindow({width:1360,height:900,show:!smoke||process.env.SFS_SMOKE_VISIBLE==='1',title:'素材创意工坊 · Sprite Motion Studio',autoHideMenuBar:true,webPreferences:{session:desktopSession,contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInWorker:false,webSecurity:true}});
 report.windowVisible=window.isVisible();
 report.preferences=window.webContents.getLastWebPreferences();
 if(smoke)window.webContents.setBackgroundThrottling(false);
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==origin)e.preventDefault();});
 window.webContents.on('console-message',event=>report.console.push({level:event.level,message:event.message}));
 window.webContents.on('render-process-gone',(_e,details)=>{report.rendererGone=details;writeReport();});
 window.on('close',e=>void closeWindow(e).catch(error=>{dialog.showErrorBox('关闭失败',error.message);}));
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'素材工坊',submenu:[{label:'切换工作区',click:()=>void selectWorkspace().catch(e=>dialog.showErrorBox('工作区切换失败',e.message))},{label:'离线导入模型',click:()=>void installModel(false).catch(e=>dialog.showErrorBox('模型未准备',e.message))},{label:'下载 CPU 模型（需联网）',click:()=>void installModel(true).catch(e=>dialog.showErrorBox('模型未准备',e.message))},{role:'quit'}]},{label:'视图',submenu:[{role:'reload'},{role:'togglefullscreen'}]}]));
 const page=process.env.SFS_SMOKE_PAGE||'/';if(!/^\/(?:materials|settings|motions|project\/[\w-]+)?$/.test(page))throw new Error('无效页面路径');
 await window.loadURL(origin+page);report.events.push('page-loaded');
 if(smoke&&process.env.SFS_SMOKE_VISIBLE==='1')window.showInactive();
 report.windowVisible=window.isVisible();
 if(smoke){await new Promise(r=>setTimeout(r,1800));
  report.renderer=await window.webContents.executeJavaScript(`(async()=>{await document.fonts.ready; const resources=[];for(const p of ['/api/v1/projects','/pixi.min.js','/imageops/imageOps.worker.js','/fonts/fusion-pixel-12px-proportional-zh_hans.otf.woff2']){const r=await fetch(p);resources.push({p,status:r.status,bytes:(await r.arrayBuffer()).byteLength});}return {text:document.querySelector('#root')?.innerText,require:typeof require,process:typeof process,resources};})()`);
  if(process.env.SFS_SMOKE_SCENARIO){const file=process.env.SFS_SMOKE_SCENARIO==='brand'?'brand-scenario.cjs':process.env.SFS_SMOKE_SCENARIO==='playback'?'playback-scenario.cjs':'production-scenario.cjs';const scenario=require(path.join(__dirname,file));report.scenario=await scenario({window,origin,service});}
  if(process.env.SFS_SMOKE_EVIDENCE){fs.mkdirSync(process.env.SFS_SMOKE_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.SFS_SMOKE_EVIDENCE,'desktop.png'),(await window.webContents.capturePage()).toPNG());}
  report.ok=report.renderer.text?.length>20&&report.renderer.require==='undefined'&&report.renderer.process==='undefined'&&report.renderer.resources.every(r=>r.status===200&&r.bytes>0)&&report.networkBlocked.length===0&&!report.console.some(v=>v.level==='error'||v.level===3)&&(!process.env.SFS_SMOKE_SCENARIO||report.scenario?.ok===true);
  writeReport();closing=true;app.exit(report.ok?0:1);
 }
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.whenReady().then(launch).catch(error=>{report.error=error.message;writeReport();if(!smoke)dialog.showErrorBox('素材工坊启动失败',`${error.message}\n工作区日志：${path.join(workspace,'.sfs/service.log')}`);app.exit(1);});
 app.on('window-all-closed',()=>app.quit());
}
