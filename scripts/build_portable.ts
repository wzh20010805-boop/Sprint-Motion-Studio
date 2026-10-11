import { cpSync,existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,statSync } from 'node:fs';
import { join,resolve,basename } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dir,'..'),destination=resolve(process.argv[2]??join(root,'dist','SpriteMotionStudio-win-x64-'+new Date().toISOString().replace(/[:.]/g,'-')));
if(existsSync(destination))throw new Error('目标发行目录已存在，不覆盖');
mkdirSync(destination,{recursive:true});
async function command(argv:string[]){const p=Bun.spawn(argv,{cwd:root,windowsHide:true,stdout:'pipe',stderr:'pipe'});const[c,o,e]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(c)throw new Error(o+e);return o+e;}
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const copy=(from:string,to:string)=>cpSync(from,to,{recursive:true,dereference:true,filter:p=>!p.includes('__pycache__')&&!p.endsWith('.pyc')});
const runtime=join(destination,'runtime');mkdirSync(runtime,{recursive:true});
copy(join(root,'probes/desktop/node_modules/electron/dist'),destination);
renameSync(join(destination,'electron.exe'),join(destination,'SpriteMotionStudio.exe'));
copy(join(root,'apps/desktop'),join(destination,'resources/app'));
 copy(join(root,'skills/soldier-frame-studio'),join(destination,'skills/soldier-frame-studio'));
 copy(join(root,'docs/p3-p5-guide.md'),join(destination,'CLI与Codex接入.md'));
 copy(join(root,'README.md'),join(destination,'项目说明.md'));
 copy(join(root,'docs/media/sfs'),join(destination,'docs/media/sfs'));
 writeFileSync(join(destination,'GitHub仓库.url'),'[InternetShortcut]\r\nURL=https://github.com/wzh20010805-boop/Sprint-Motion-Studio\r\n');
 writeFileSync(join(destination,'下载更新.url'),'[InternetShortcut]\r\nURL=https://github.com/wzh20010805-boop/Sprint-Motion-Studio/releases/latest\r\n');
await command([process.execPath,'build','--compile','--target=bun-windows-x64','apps/cli/src/index.ts','--outfile',join(destination,'sfs.exe')]);
await command([process.execPath,'build','--compile','--target=bun-windows-x64','apps/server/src/runtimeBootstrap.ts','--outfile',join(runtime,'sfs-service.exe')]);
const assets=join(runtime,'assets');mkdirSync(assets,{recursive:true});
copy(join(root,'apps/web/node_modules/pixi.js/dist/pixi.min.js'),join(assets,'pixi.min.js'));copy(join(root,'apps/web/node_modules/pixi.js/dist/packages/unsafe-eval.min.js'),join(assets,'unsafe-eval.min.js'));copy(join(root,'apps/web/public/fonts'),join(assets,'fonts'));
const worker=await Bun.build({entrypoints:[join(root,'apps/web/src/imageops/imageOps.worker.ts')],target:'browser',format:'esm'});if(!worker.success)throw new Error(worker.logs.join('\n'));await Bun.write(join(assets,'imageOps.worker.js'),worker.outputs[0]);
copy(join(root,'workers/image'),join(destination,'workers/image'));
// 只复制标准库和本工具独立环境，绝不复制宿主的全局site-packages。
const python=join(root,'.venv-image/Scripts/python.exe');
const base=(await command([python,'-c','import sys; print(sys.base_prefix)'])).trim();
const packedPython=join(runtime,'python');mkdirSync(packedPython,{recursive:true});
for(const item of readdirSync(base,{withFileTypes:true})){if(item.isFile()&&/\.(exe|dll|txt)$/i.test(item.name))copy(join(base,item.name),join(packedPython,item.name));}
copy(join(base,'DLLs'),join(packedPython,'DLLs'));
cpSync(join(base,'Lib'),join(packedPython,'Lib'),{recursive:true,filter:p=>!p.includes('site-packages')&&!p.includes('__pycache__')&&!p.endsWith('.pyc')});
copy(join(root,'.venv-image/Lib/site-packages'),join(packedPython,'Lib/site-packages'));
const bin=join(runtime,'bin');mkdirSync(bin,{recursive:true});for(const name of ['ffmpeg','ffprobe']){const file=Bun.which(name);if(!file)throw new Error('缺少'+name);copy(file,join(bin,name+'.exe'));}
const licenses=join(destination,'licenses');mkdirSync(licenses,{recursive:true});copy(join(root,'LICENSE'),join(licenses,'FrameBaker-MIT.txt'));copy(join(root,'THIRD_PARTY_NOTICES.md'),join(licenses,'THIRD_PARTY_NOTICES.md'));copy(join(base,'LICENSE.txt'),join(licenses,'Python-LICENSE.txt'));
 copy(join(root,'apps/web/public/fonts/OFL.txt'),join(licenses,'Fusion-Pixel-OFL.txt'));
 copy(join(root,'apps/web/node_modules/pixi.js/LICENSE'),join(licenses,'Pixi-MIT.txt'));
 copy(join(root,'docs/licenses/U2Net-Apache-2.0.txt'),join(licenses,'U2Net-Apache-2.0.txt'));
 copy(join(root,'docs/licenses/Bun-1.4.2-notices.md'),join(licenses,'Bun-1.4.2-notices.md'));
 copy(join(root,'docs/licenses/distribution-sources.md'),join(licenses,'distribution-sources.md'));
const ffmpeg=Bun.which('ffmpeg')!;writeFileSync(join(licenses,'FFmpeg-build.txt'),await command([ffmpeg,'-version'])+'\n'+await command([ffmpeg,'-buildconf']));
const ffmpegHome=resolve(ffmpeg,'../..');for(const name of ['LICENSE','LICENSE.txt','LICENSE.md','LICENSES','README.txt','README.md'])if(existsSync(join(ffmpegHome,name)))copy(join(ffmpegHome,name),join(licenses,'FFmpeg-'+name));
writeFileSync(join(licenses,'model-u2net.md'),'# 可选 u2netp 模型\n\n模型不随发行包附带。显式导入或下载来源：https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx\nU-2-Net 来源：https://github.com/NathanUA/U-2-Net，模型项目 Apache-2.0；rembg 代码 MIT。SHA256：309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8。不同权重不得使用此登记。\n');
writeFileSync(join(destination,'START.cmd'),'@echo off\r\nstart "" "%~dp0SpriteMotionStudio.exe"\r\n');
writeFileSync(join(destination,'使用说明.md'),'# 小兵动画素材工坊\n\n双击 SpriteMotionStudio.exe 或 START.cmd。工作区默认位于当前用户 LocalAppData\\SpriteMotionStudio\\workspaces\\default；菜单可选择工作区。CLI：sfs.exe --help；sfs.exe doctor --json。无需安装 Node、Bun、Python，非抠图功能可断网运行。模型未附带，菜单支持明确下载或离线导入；缺模型时旧遮罩仍可修正。导出入口：项目→导出→地面基准、统一比例与导出。\n\n关闭窗口有任务时可保留后台、取消或返回。后台无客户无任务后自动退出。源素材不被删除。卸载仅删除解压目录；个人工作区和模型默认保留，删除它们须用户自行明确决定。\n\n本包未经签名；干净Windows与真实美术验收另见项目报告。FFmpeg为GPL构建，具体版本/配置和随包许可见licenses，正式对外分发须保留并提供对应源码。\n');
const inventory={schema_version:'1.0',name:'SpriteMotionStudio',version:'1.0.0',repository:'https://github.com/wzh20010805-boop/Sprint-Motion-Studio',production_api_version:'1.0',validation:{clean_vm:false,relocated_restricted_path:true,real_artistic_approval:false,gui_cli_identical:true,local_windows:true},created_at:new Date().toISOString(),bun:Bun.version,electron:readFileSync(join(destination,'version'),'utf8').trim(),python:await command([python,'--version']),python_packages:(await command([python,'-m','pip','freeze'])).trim().split(/\r?\n/),models_bundled:false,source_root_embedded:false};
writeFileSync(join(destination,'sfs-package.json'),JSON.stringify(inventory,null,2));
const sums:Record<string,string>={};function walk(dir:string){for(const f of readdirSync(dir,{withFileTypes:true})){const file=join(dir,f.name);if(f.isDirectory())walk(file);else sums[file.slice(destination.length+1).replaceAll('\\','/')]=hash(file);}}walk(destination);writeFileSync(join(destination,'SHA256SUMS.json'),JSON.stringify(sums,null,2));
console.log(JSON.stringify({destination,files:Object.keys(sums).length,size_mb:Object.keys(sums).reduce((total,file)=>total+statSync(join(destination,file)).size,0)/1024/1024}));
