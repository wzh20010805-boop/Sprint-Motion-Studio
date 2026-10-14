const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(process.env.PLAYBACK_LAYOUT_OUTPUT,'profile'));
let win;
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:1150,height:420,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await win.loadURL(process.env.PLAYBACK_LAYOUT_URL);
 await new Promise(r=>setTimeout(r,250));
 const samples=await win.webContents.executeJavaScript('window.measurePlaybackBar()');
 const stable=Math.max(...samples.map(s=>s.width))-Math.min(...samples.map(s=>s.width))<.1&&Math.max(...samples.map(s=>s.left))-Math.min(...samples.map(s=>s.left))<.1;
 fs.writeFileSync(path.join(process.env.PLAYBACK_LAYOUT_OUTPUT,'layout.json'),JSON.stringify({stable,samples},null,2));
 fs.writeFileSync(path.join(process.env.PLAYBACK_LAYOUT_OUTPUT,'layout.png'),(await win.webContents.capturePage()).toPNG());
 win.destroy();app.exit(stable?0:1);
}).catch(e=>{console.error(e);app.exit(1)});
