const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),cp=require('node:child_process');
const repo=process.env.SFS_REPO_ROOT,workspace=process.env.SFS_WORKSPACE;
const evidence=path.join(workspace,'desktop-evidence');fs.mkdirSync(evidence,{recursive:true});
process.env.LOCALAPPDATA=fs.mkdtempSync(path.join(repo,'fixtures/generated/human-ai/gui-p-')); process.env.SFS_SMOKE_EVIDENCE=path.join(evidence,'portable');
process.env.P0_PROFILE_DIR=fs.mkdtempSync(path.join(repo,'fixtures/generated/human-ai/gui-q-')); process.env.P0_EVIDENCE_DIR=path.join(evidence,'probe');
const supplemental={hosts:[],portableProfile:process.env.LOCALAPPDATA,probeProfile:process.env.P0_PROFILE_DIR};let stage='portable';const originalLoad=Module._load,originalExit=app.exit.bind(app);
const check=async window=>{
 const info=JSON.parse(fs.readFileSync(path.join(workspace,'.sfs/service.json'),'utf8'));
 const cookies=await window.webContents.session.cookies.get({url:info.url});
 const preferences=window.webContents.getLastWebPreferences();
 const result=await window.webContents.executeJavaScript(`(async()=>{
 const read=await fetch('/api/v1/projects');const edit=await fetch('/api/v1/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'desktop-capability-fixture'})});
 const review=await fetch('/__fixture/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:'machine'})});
 const ws=await new Promise(resolve=>{const socket=new WebSocket(location.origin.replace('http:','ws:')+'/ws');const timer=setTimeout(()=>{socket.close();resolve(false)},2000);socket.onopen=()=>{clearTimeout(timer);socket.close();resolve(true)};socket.onerror=()=>{clearTimeout(timer);resolve(false)};});
 return {read:read.status,edit:edit.status,review:review.status,cookieVisible:document.cookie,require:typeof require,process:typeof process,ws};})()`);
 supplemental.hosts.push({host:stage,visible:window.isVisible(),preferences:{sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration},cookies:cookies.map(({name,httpOnly,sameSite,path,hostOnly})=>({name,httpOnly,sameSite,path,hostOnly})),result,usesDefaultSession:window.webContents.session===session.defaultSession});
 fs.writeFileSync(path.join(evidence,'capabilities.json'),JSON.stringify(supplemental,null,2));
 if(result.read!==200||result.edit!==200||result.review!==200||!result.ws||result.cookieVisible||result.require!=='undefined'||result.process!=='undefined')throw Error('DESKTOP_CAPABILITY_ASSERTION');
};
class CheckedWindow extends BrowserWindow {async loadURL(...args){await super.loadURL(...args);await check(this);}}
Module._load=function(request,parent,isMain){
 if(request==='electron')return {...originalLoad.call(this,request,parent,isMain),BrowserWindow:CheckedWindow};
 if(request==='node:child_process')return {...cp,spawn(executable,args,options){if(String(executable).endsWith('sfs.exe'))return cp.spawn(process.env.SFS_FIXTURE_BUN,[path.join(repo,'apps/cli/src/index.ts'),...args],{...options,cwd:repo});return cp.spawn(executable,args,options);}};
 return originalLoad.call(this,request,parent,isMain);
};
app.quit=()=>{};
app.exit=code=>{
 if(code!==0||stage==='probe')return originalExit(code);
 stage='probe';app.removeAllListeners('window-all-closed');app.removeAllListeners('before-quit');app.removeAllListeners('second-instance');
 for(const window of BrowserWindow.getAllWindows())window.destroy();
 require(path.join(repo,'probes/desktop/main.cjs'));
};
setTimeout(()=>originalExit(9),45000).unref();
require(path.join(repo,'apps/desktop/main.cjs'));
