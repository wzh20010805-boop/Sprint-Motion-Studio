import {join,resolve} from 'node:path';
import {mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const root=resolve(process.argv[2]),evidence=resolve(process.argv[3]),model=resolve(process.argv[4]);
const workspace=join(evidence,'workspace'),user=join(evidence,'user'),models=join(user,'SpriteMotionStudio/models');mkdirSync(models,{recursive:true});
const sha=createHash('sha256').update(readFileSync(model)).digest('hex');if(sha!=='309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8')throw new Error('test model SHA mismatch');copyFileSync(model,join(models,'u2netp.onnx'));
const env={...process.env,PATH:'C:\\Windows\\System32;C:\\Windows',LOCALAPPDATA:user,SFS_WORKSPACE:workspace,NUMBA_CACHE_DIR:join(evidence,'numba-cache'),PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1'};delete env.SFS_REPO_ROOT;delete env.SFS_IMAGE_PYTHON;delete env.SFS_MODEL_DIR;
async function run(name:string,exe:string,args:string[],expected=0,stdin?:string){const p=Bun.spawn([exe,...args],{env,cwd:'C:/Windows/Temp',windowsHide:true,stdout:'pipe',stderr:'pipe',stdin:stdin?'pipe':'ignore'});if(stdin){(p.stdin as any).write(stdin);(p.stdin as any).end();}const[c,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);writeFileSync(join(evidence,name+'.json'),JSON.stringify({code:c,out,err},null,2));if(c!==expected)throw new Error(name+' '+out+err);return out;}
const cli=join(root,'sfs.exe'),flags=['--workspace',workspace,'--json'];
try{
 const doctor=JSON.parse(await run('offline-model-doctor',cli,['doctor',...flags]));if(!doctor.data.capabilities.matting)throw new Error('optional model not found');
 const project=JSON.parse(await run('model-create',cli,['project','create','--name','包内CPU推理合成验收',...flags])).data.project.id;
 const png=join(evidence,'complex-scene');mkdirSync(png,{recursive:true});
 await run('model-fixture',join(root,'runtime/python/python.exe'),['-c',"from PIL import Image,ImageDraw; import sys,pathlib; p=pathlib.Path(sys.argv[1]);\nfor n in range(3):\n i=Image.new('RGB',(128,128),(140,190,160)); d=ImageDraw.Draw(i); d.rectangle((0,100,127,127),fill=(90,110,130)); d.ellipse((44,20,84,62),fill=(245,80,160)); d.rectangle((43,59,86,95),fill=(60,200,245)); d.line((106,12,106,105),fill=(240,230,80),width=2); i.save(p/('frame_%03d.png'%n))",png]);
 const imported=JSON.parse(await run('model-import',cli,['import','images','--project',project,'--directory',png,...flags]));
 const recipe=join(evidence,'model-recipe.json');writeFileSync(recipe,JSON.stringify({schema_version:'1.0',matting:{backend:'rembg',model:'u2netp'},output:{draft:true}}));
 const matte=JSON.parse(await run('model-matte',cli,['pipeline','run','--project',project,'--axis',imported.data.axis_id,'--recipe',recipe,'--wait',...flags],4));
 if(matte.status!=='waiting_user'||matte.data.job.result.frame_count!==3||matte.data.job.result.session_count!==1)throw new Error('CPU job must produce only an unreviewed draft');
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'packaged-sfs-test',version:'1.0'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'inspect_project',arguments:{project_id:project}}}];
 const out=await run('packaged-mcp',cli,['mcp','--stdio','--workspace',workspace],0,messages.map(m=>JSON.stringify(m)).join('\n')+'\n');const replies=out.trim().split('\n').map(l=>JSON.parse(l));
 if(replies.find(r=>r.id===2)?.result.tools.length!==9)throw new Error('MCP whitelist mismatch');const inspected=JSON.parse(replies.find(r=>r.id===3).result.content[0].text);if(inspected.editor_frames.count!==3)throw new Error('MCP did not query the shared project');
 writeFileSync(join(evidence,'packaged-access-summary.json'),JSON.stringify({ok:true,model_import:'explicit local fixture copy, not bundled/downloaded',sha256:sha,matting_status:matte.status,session_count:1,frame_count:3,mcp_tools:9,mcp_project:project},null,2));console.log('Packaged offline CPU and MCP checks passed');
}finally{try{const info=JSON.parse(readFileSync(join(workspace,'.sfs/service.json'),'utf8'));process.kill(info.pid);}catch{}}
