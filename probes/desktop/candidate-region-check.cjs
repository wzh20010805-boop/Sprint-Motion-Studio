const {app,BrowserWindow,session}=require('electron');
const {strict:assert}=require('node:assert');const fs=require('node:fs');const {join}=require('node:path');
const output=process.env.SFS_REVIEW_OUTPUT,url=process.env.SFS_REVIEW_URL;
app.setPath('userData',join(output,'profile'));
const report={scope:'Task11 I1 exact region only; no all300 rerun',synthetic_reviewer:true,artistic_acceptance:false,cases:[],failures:[],consoleErrors:[]};
let window,finished=false;const delay=ms=>new Promise(r=>setTimeout(r,ms));
function finish(){if(finished)return;finished=true;report.passed=!report.failures.length&&!report.consoleErrors.length;fs.writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));if(window&&!window.isDestroyed())window.destroy();app.exit(report.passed?0:1);}
const timeout=setTimeout(()=>{report.failures.push({error:'Exceeded 90 seconds'});finish();},90000);
app.whenReady().then(async()=>{
 const sess=session.fromPartition('region-'+Date.now());await sess.cookies.set({url,name:'sfs_reviewer',value:process.env.SFS_REVIEW_COOKIE,httpOnly:true,sameSite:'strict',path:'/'});
 window=new BrowserWindow({width:1400,height:1100,show:false,webPreferences:{session:sess,contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 report.preferences={sandbox:true,contextIsolation:true,nodeIntegration:false,visible:false};window.webContents.on('console-message',e=>{if(e.level==='error')report.consoleErrors.push(e.message);});
 const js=s=>window.webContents.executeJavaScript(s),until=async s=>{for(let i=0;i<600;i++){if(await js(s))return;await delay(15);}throw Error('Timed out: '+s);};
 const input=async(selector,value)=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(20);};
 await window.loadURL(url);await until(`!!window.reviewFixture&&!!document.querySelector('[data-review="approve"]')&&!document.querySelector('[data-review="approve"]').disabled`);
 for(const dpr of [1,1.25]){
  window.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width:1400,height:1100},viewPosition:{x:0,y:0},deviceScaleFactor:dpr,viewSize:{width:1400,height:1100},scale:1});await until(`devicePixelRatio===${dpr}`);
  await js(`Object.assign(document.querySelector('.candidate-viewport').style,{width:'500px',height:'388px'})`);await delay(50);
  for(const scenario of [{zoom:1,pan:[0,0],edges:true},{zoom:.5,pan:[13,-9],edges:true},{zoom:1.5,pan:[-17,11],edges:false}]){
   const item={dpr,...scenario};try{
    await input('.candidate-toolbar input[type=range]',scenario.zoom);await input('.candidate-toolbar label:has(input[type=range]) + label input',scenario.pan[0]);await input('.candidate-toolbar label:has(input[type=range]) + label + label input',scenario.pan[1]);await delay(30);
    const bounds=await js(`(()=>{const c=document.querySelector('.candidate-images canvas'),v=c.parentElement,r=c.getBoundingClientRect(),o=v.getBoundingClientRect();return {canvas:{left:r.left,top:r.top,width:r.width,height:r.height},outer:{left:o.left,top:o.top,width:o.width,height:o.height},client:{width:v.clientWidth,height:v.clientHeight,left:v.clientLeft,top:v.clientTop},native:{width:c.width,height:c.height},dpr:devicePixelRatio}})()`);item.bounds=bounds;assert.equal(bounds.client.left,2);assert.equal(bounds.client.top,2);assert.equal(bounds.outer.height-bounds.client.height,4);
    const r=bounds.canvas,w=bounds.native.width,h=bounds.native.height,lo=scenario.edges?[0,0]:[30.25,30.5],hi=scenario.edges?[w,h]:[40.75,42.25];
    // Preserve existing out-of-bounds rejection: native integer edge events stay inside the image.
    const a={x:scenario.edges?Math.ceil(r.left):Math.round(r.left+lo[0]*r.width/w),y:scenario.edges?Math.ceil(r.top):Math.round(r.top+lo[1]*r.height/h)},b={x:scenario.edges?Math.floor(r.left+r.width):Math.round(r.left+hi[0]*r.width/w),y:scenario.edges?Math.floor(r.top+r.height):Math.round(r.top+hi[1]*r.height/h)};
    await js('window.reviewFixture.pointerEvents.length=0');window.webContents.sendInputEvent({type:'mouseMove',...a});window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...a});
    try{await until('window.reviewFixture.pointerHeld()');window.webContents.sendInputEvent({type:'mouseMove',...b});}finally{window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...b});}
    await until(`window.reviewFixture.pointerEvents.some(e=>e.type==='pointerup')&&!window.reviewFixture.pointerHeld()`);
    const events=await js('window.reviewFixture.pointerEvents');item.events=events;const start=events.find(e=>e.type==='pointerdown'),end=events.find(e=>e.type==='pointerup');assert.ok(start&&end);
    // Oracle uses actual rendered canvas bounds and actual delivered CSS pointer coordinates.
    const x=(start.x-r.left)*w/r.width,y=(start.y-r.top)*h/r.height,xx=(end.x-r.left)*w/r.width,yy=(end.y-r.top)*h/r.height;const expected=[Math.min(x,xx),Math.min(y,yy),Math.abs(xx-x),Math.abs(yy-y)];item.expected=expected;
    await until(`document.querySelector('.candidate-review fieldset p').textContent.includes('[')`);
    const mapping=await js(`({frame:window.reviewFixture.identity.manifest.frames[0],text:document.querySelectorAll('.candidate-review fieldset p')[1]?.textContent})`),m=mapping.frame.source_to_canvas.inverse_matrix;
    const [rx,ry,rw,rh]=expected,quad=[[rx,ry],[rx+rw,ry],[rx+rw,ry+rh],[rx,ry+rh]].map(([px,py])=>[m[0]*px+m[2]*py+m[4],m[1]*px+m[3]*py+m[5]]);item.expected_source_quad=quad;
    if(quad.some(([px,py])=>px<0||py<0||px>mapping.frame.source_size.width||py>mapping.frame.source_size.height)){assert.ok(mapping.text.includes('SOURCE_CLIPPED'));item.source_mapping='SOURCE_CLIPPED';}else{const actual=JSON.parse(mapping.text.slice(mapping.text.indexOf('[[')));assert.equal(actual.length,4);for(let i=0;i<4;i++)for(let j=0;j<2;j++)assert.ok(Math.abs(actual[i][j]-quad[i][j])<1e-9);item.source_mapping=actual;}
    const label=`DPR ${dpr} zoom ${scenario.zoom} edges ${scenario.edges}`;await input('[data-review="issue-text"]',label);await js(`document.querySelector('[data-review="issue-submit"]').click()`);await until(`!document.querySelector('[data-review="approve"]').disabled&&fetch('/fixture/evidence').then(r=>r.json()).then(e=>e.state.issues.some(i=>i.text===${JSON.stringify(label)}))`);
    const issue=await js(`fetch('/fixture/evidence').then(r=>r.json()).then(e=>e.state.issues.find(i=>i.text===${JSON.stringify(label)}))`);item.stored=issue.rect;assert.equal(issue.coordinate_system,'final_canvas_pixels');assert.ok(issue.rect);for(let i=0;i<4;i++)assert.ok(Math.abs(issue.rect[i]-expected[i])<1e-9,`${label} coordinate ${i}: ${issue.rect[i]} != ${expected[i]}`);
    if(scenario.edges){item.exact_integer_edges=[r.left,r.top,r.left+r.width,r.top+r.height].every(Number.isInteger);if(item.exact_integer_edges)for(let i=0;i<4;i++)assert.ok(Math.abs(issue.rect[i]-[0,0,w,h][i])<1e-9,`visible exact edge ${i}`);else{assert.ok(expected[0]>=0&&expected[1]>=0&&expected[0]+expected[2]<=w&&expected[1]+expected[3]<=h);assert.ok(expected[0]<w/r.width&&expected[1]<h/r.height);}}
    item.passed=true;
   }catch(e){item.passed=false;item.error=e.stack;report.failures.push(item);}
   report.cases.push(item);
  }
 }
 fs.writeFileSync(join(output,'region-exact.png'),(await window.webContents.capturePage()).toPNG());await js('window.reviewFixture.unmount()');await until('window.reviewFixture.live()===0');report.owned_bitmaps_after_unmount=await js('window.reviewFixture.live()');clearTimeout(timeout);finish();
}).catch(e=>{report.failures.push({error:e.stack});clearTimeout(timeout);finish();});
