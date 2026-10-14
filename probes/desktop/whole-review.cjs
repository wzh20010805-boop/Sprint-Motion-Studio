const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(process.env.WHOLE_REVIEW_OUTPUT,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1600,height:1080,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const consoleErrors=[];win.webContents.on('console-message',event=>{if(event.level==='error')consoleErrors.push(event.message);});
 await win.loadURL(process.env.WHOLE_REVIEW_URL);
 let report;
 for(let n=0;n<100;n++){
  report=await win.webContents.executeJavaScript(`(()=>{const button=document.querySelector('[data-review="whole-approve"]');return {buttonPresent:!!button,enabled:!!button&&!button.disabled,label:button?.textContent,frame:document.querySelector('.candidate-images canvas')?.dataset.frameId,text:document.body.innerText.slice(0,600)};})()`);
  if(report.enabled&&report.frame)break;
  await new Promise(r=>setTimeout(r,200));
 }
 if(report.buttonPresent)await win.webContents.executeJavaScript(`document.querySelector('[data-review="whole-approve"]').scrollIntoView({block:'center'})`);
 report.consoleErrors=consoleErrors;fs.writeFileSync(path.join(process.env.WHOLE_REVIEW_OUTPUT,'ui.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(process.env.WHOLE_REVIEW_OUTPUT,'ui.png'),(await win.webContents.capturePage()).toPNG());
 win.destroy();app.exit(report.enabled&&report.frame?0:1);
}).catch(error=>{console.error(error);app.exit(2)});
