const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(process.env.ALIGNMENT_ZOOM_OUTPUT,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1920,height:1080,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await win.loadURL(process.env.ALIGNMENT_ZOOM_URL);
 await new Promise(r=>setTimeout(r,250));
 const report=await win.webContents.executeJavaScript('window.measureAlignmentZoom()');
 report.passed=report.initial.fullyVisible&&report.initial.characterHeight===240&&report.options.includes('0.5')&&report.restored?.characterHeight===240&&report.playback.visited.length>1&&report.playback.decoded.length>=3&&Object.values(report.layout.ranges).every(range=>range.delta<.1);
 fs.writeFileSync(path.join(process.env.ALIGNMENT_ZOOM_OUTPUT,'layout.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(process.env.ALIGNMENT_ZOOM_OUTPUT,'layout.png'),(await win.webContents.capturePage()).toPNG());
 win.destroy();app.exit(report.passed?0:1);
}).catch(e=>{console.error(e);app.exit(2)});
