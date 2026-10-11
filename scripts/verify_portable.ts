import { join,resolve } from 'node:path';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';

const root=resolve(process.argv[2]),evidence=resolve(process.argv[3]??'fixtures/generated/p5-portable');mkdirSync(evidence,{recursive:true});
const workspace=join(evidence,'workspace'),user=join(evidence,'user');
const env={...process.env,PATH:'C:\\Windows\\System32;C:\\Windows',LOCALAPPDATA:user,SFS_WORKSPACE:workspace,SFS_IDLE_TIMEOUT_MS:'60000',SFS_SMOKE_EVIDENCE:evidence,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',NUMBA_CACHE_DIR:join(evidence,'numba-cache'),SFS_SMOKE_SCENARIO:'production',SFS_SMOKE_LARGE_PROJECT:'',SFS_SMOKE_VISIBLE:'1'};
mkdirSync(env.NUMBA_CACHE_DIR,{recursive:true});
delete env.SFS_REPO_ROOT;delete env.SFS_IMAGE_PYTHON;delete env.SFS_MODEL_DIR;
async function run(name:string,exe:string,args:string[]){const proc=Bun.spawn([exe,...args],{cwd:'C:/Windows/Temp',env,windowsHide:true,stdout:'pipe',stderr:'pipe'});const[code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);const result={exe,args,cwd:'C:/Windows/Temp',PATH:env.PATH,code,out,err};writeFileSync(join(evidence,name+'.json'),JSON.stringify(result,null,2));if(code)throw new Error(name+': '+JSON.stringify(result));return out;}
try{
 const doctor=JSON.parse(await run('doctor',join(root,'sfs.exe'),['doctor','--json']));if(!doctor.ok||doctor.data.capabilities.matting)throw new Error('无模型doctor预期不匹配');
 const python=await run('python',join(root,'runtime/python/python.exe'),['-c','import sys; import PIL,numpy,onnxruntime,rembg; print(sys.prefix); print(PIL.__version__); print(onnxruntime.__version__)']);
 const create=JSON.parse(await run('create',join(root,'sfs.exe'),['project','create','--name','P5 离线换目录','--workspace',workspace,'--json']));
 const project=create.data.project.id,images=join(evidence,'PNG 序列 (测试)'),large=join(evidence,'300 PNG');mkdirSync(images,{recursive:true});mkdirSync(large,{recursive:true});
 await run('synthetic-images',join(root,'runtime/python/python.exe'),['-c',"from PIL import Image,ImageDraw; import sys,pathlib; a=pathlib.Path(sys.argv[1]); b=pathlib.Path(sys.argv[2]);\nfor n in range(300):\n i=Image.new('RGBA',(128,128),(0,0,0,0)); d=ImageDraw.Draw(i); d.rectangle((45+n%3,26+n%5,78+n%3,100+n%5),fill=(210,55,100,255)); d.line((95+n%3,20,95+n%3,102),fill=(80,190,240,128),width=2); i.save(b/('frame_%03d.png'%n));\n if n<3: i.save(a/('frame_%03d.png'%n))",images,large]);
 const imported=JSON.parse(await run('import-images',join(root,'sfs.exe'),['import','images','--project',project,'--directory',images,'--workspace',workspace,'--json']));
 const axis=imported.data.axis_id,config=join(evidence,'alignment.json');writeFileSync(config,JSON.stringify({canvas:{width:128,height:128},anchor:[64,112],scale:1,resampling:'pixel',mode:'ground_keyframes',roots:[{index:0,x:64,y:112},{index:2,x:66,y:112}],offsets:{}}));
 await run('align',join(root,'sfs.exe'),['align','--project',project,'--axis',axis,'--config',config,'--workspace',workspace,'--json']);
 const largeProject=JSON.parse(await run('large-create',join(root,'sfs.exe'),['project','create','--name','300帧纹理预算','--workspace',workspace,'--json'])).data.project.id;
 await run('large-import',join(root,'sfs.exe'),['import','images','--project',largeProject,'--directory',large,'--workspace',workspace,'--json']);env.SFS_SMOKE_LARGE_PROJECT=largeProject;
 env.SFS_SMOKE_PAGE='/project/'+create.data.project.id;
 await run('desktop-launch',join(root,'SpriteMotionStudio.exe'),['--smoke']);
 const desktop=JSON.parse(readFileSync(join(evidence,'desktop.json'),'utf8'));if(!desktop.ok||!desktop.scenario?.ok||!desktop.windowVisible)throw new Error('真实GUI检查失败');
 const exported=JSON.parse(await run('cli-export',join(root,'sfs.exe'),['export','--project',project,'--axis',axis,'--wait','--workspace',workspace,'--json']));
 const manifest=JSON.parse(readFileSync(join(exported.data.job.result.directory,'manifest.json'),'utf8')),gui=JSON.parse(readFileSync(join(evidence,'gui-export.json'),'utf8')).manifest;
 delete manifest.export_id;delete gui.export_id;if(JSON.stringify(manifest)!==JSON.stringify(gui))throw new Error('GUI/CLI manifest或PNG摘要不同');
 const current=JSON.parse(await run('inspect',join(root,'sfs.exe'),['inspect','--project',project,'--axis',axis,'--workspace',workspace,'--json']));
 const recipe=join(evidence,'recipe.json');writeFileSync(recipe,JSON.stringify({schema_version:'1.0',alignment:current.data.config,output:{draft:false}}));
 await run('pipeline-output',join(root,'sfs.exe'),['pipeline','run','--project',project,'--axis',axis,'--recipe',recipe,'--output',join(evidence,'copied-assets'),'--wait','--workspace',workspace,'--json']);
 const info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));const response=await fetch(info.url+'/api/v1/projects');if(response.status!==401)throw new Error('包内鉴权失败');
 writeFileSync(join(evidence,'summary.json'),JSON.stringify({ok:true,scope:'relocated current Windows, restricted PATH; not clean VM',root,workspace,python,unauthorized_status:response.status,gui_cli_identical:true,gui_checks:desktop.scenario.checks},null,2));console.log('Portable checks passed');
}finally{try{const info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));process.kill(info.pid);}catch{}}
