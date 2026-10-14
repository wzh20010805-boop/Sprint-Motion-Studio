import {createRoot} from '../../apps/web/node_modules/react-dom/client';
import {createElement,Fragment} from '../../apps/web/node_modules/react';
import {CandidateReviewWorkspace} from '../../apps/web/src/components/CandidateReviewWorkspace';
import {CandidateReviewCanvas} from '../../apps/web/src/components/CandidateReviewCanvas';
import AppModals from '../../apps/web/src/components/AppModals';
import {setLang} from '../../apps/web/src/i18n';
import {askConfirm} from '../../apps/web/src/notice';
// 仅探针：强制模拟已取消后仍完成的解码/网络结果，验证真实组件代次保护。
const nativeFetch=window.fetch.bind(window),delays=new Map<string,{ms:number;fail:boolean}>();
window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;const rule=[...delays].find(([path])=>url.includes(encodeURIComponent(path))||url.includes(path));if(!rule)return nativeFetch(input,init);delays.delete(rule[0]);const result=await nativeFetch(input,{...init,signal:undefined});await new Promise(r=>setTimeout(r,rule[1].ms));if(rule[1].fail)throw Error('Synthetic delayed failure');return result;};
const live=new Set<ImageBitmap>(),decode=window.createImageBitmap.bind(window),close=ImageBitmap.prototype.close;
window.createImageBitmap=(async(...args:Parameters<typeof createImageBitmap>)=>{const bitmap=await (decode as Function)(...args);live.add(bitmap);return bitmap;}) as typeof createImageBitmap;
ImageBitmap.prototype.close=function(){live.delete(this);return close.call(this);};
const identity=await(await nativeFetch('/fixture/identity')).json(),root=createRoot(document.getElementById('root')!);
const render=()=>root.render(createElement(Fragment,null,createElement(CandidateReviewWorkspace,{taskId:identity.taskId,onClose:()=>root.render(createElement(AppModals)),onEditDraft:()=>{}}),createElement(AppModals)));
const pointerEvents:Array<{type:string;x:number;y:number}>=[];for(const type of ['pointerdown','pointerup'])window.addEventListener(type,event=>{const e=event as PointerEvent;pointerEvents.push({type,x:e.clientX,y:e.clientY});});
let pointerHeld=false;window.addEventListener('pointerdown',event=>{const viewport=(event.target as Element).closest('.candidate-viewport');pointerHeld=!!viewport?.hasPointerCapture(event.pointerId);});for(const event of ['pointerup','pointercancel'])window.addEventListener(event,()=>{pointerHeld=false;});
render();
(window as any).reviewFixture={identity,pointerEvents,pointerHeld:()=>pointerHeld,delay:(path:string,ms:number,fail=false)=>delays.set(path,{ms,fail}),live:()=>live.size,language:setLang,confirm:()=>askConfirm('Synthetic confirmation'),unmount:()=>root.render(createElement(AppModals)),remount:render,
 twins:()=>root.render(createElement(Fragment,null,createElement(CandidateReviewCanvas,{key:'a',manifest:identity.manifest,frame:identity.manifest.frames[0]}),createElement(CandidateReviewCanvas,{key:'b',manifest:identity.manifest,frame:identity.manifest.frames[0]}))),
 oneTwin:()=>root.render(createElement(Fragment,null,createElement(CandidateReviewCanvas,{key:'b',manifest:identity.manifest,frame:identity.manifest.frames[0]}))),
};
