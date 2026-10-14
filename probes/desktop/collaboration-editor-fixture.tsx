import {createRoot} from '../../apps/web/node_modules/react-dom/client';
import {createElement,Fragment} from '../../apps/web/node_modules/react';
import * as PIXI from '../../apps/web/node_modules/pixi.js';
import AppModals from '../../apps/web/src/components/AppModals';
import JobPanel from '../../apps/web/src/components/JobPanel';
import {setLang} from '../../apps/web/src/i18n';
(window as any).PIXI=PIXI;
const {default:Editor}=await import('../../apps/web/src/components/Editor');
const identity=await(await fetch('/fixture/identity')).json(),root=createRoot(document.getElementById('root')!);
const mount=(projectId=identity.context.project_id)=>root.render(createElement(Fragment,null,createElement(Editor,{projectId,key:projectId,onBack:()=>{}}),createElement(JobPanel),createElement(AppModals)));
(window as any).editorFixture={identity,mount,unmount:()=>root.render(createElement(AppModals)),language:setLang};
// 队列提示的合成数据仅覆盖前端隐藏/恢复；不创建或取消后端任务。
const nativeFetch=window.fetch.bind(window);
let notices=Array.from({length:35},(_,i)=>({id:`notice-${i}`,project_id:'fixture',type:'matting',status:'waiting_user',progress:'Synthetic pending inspection',error:null,created_at:i}));
(window as any).editorFixture.mountJobs=()=>{
 window.fetch=(async(input,init)=>{const path=typeof input==='string'?input:input instanceof URL?input.toString():input.url;if(path==='/api/jobs')return Response.json({jobs:notices});return nativeFetch(input,init);}) as typeof fetch;
 root.render(createElement(Fragment,null,createElement(JobPanel),createElement(AppModals)));
};
(window as any).editorFixture.resumeNotice=()=>{notices=notices.map((job,i)=>i===0?{...job,status:'running'}:job);};
mount();
