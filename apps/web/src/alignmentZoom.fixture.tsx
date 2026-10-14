import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import type {Frame} from '@framebaker/shared';
import AlignmentWorkshop from './components/AlignmentWorkshop';
import './styles.css';
import './candy.css';

document.documentElement.dataset.theme='light';
const frames:Frame[]=Array.from({length:121},(_,n)=>({id:'preview-fixture-'+n,project_id:'preview-project',track_id:null,step_id:null,is_asset:0,idx:n,raw_path:null,processed_path:null,status:'ready',duration:1,is_keyframe:0,offset_x:0,offset_y:0,scale:1,rotation:0,opacity:1,tags:[],source:'upload',metadata:{timing:{display_duration:{num:1,den:24}}},attack_effect:null}));
function Fixture(){const [,setHeartbeat]=useState(0);useEffect(()=>{const timer=setInterval(()=>setHeartbeat(n=>n+1),16);return()=>clearInterval(timer);},[]);return <AlignmentWorkshop projectId="preview-project" axisId="preview-axis" frames={[...frames]} fps={24} onClose={()=>{}}/>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
(window as any).measureAlignmentZoom=async()=>{
 await document.fonts.ready;
 const loaded=()=>{const image=[...document.querySelectorAll<HTMLImageElement>('.alignment-canvas img')].at(-1);return image?.complete&&image.naturalHeight===640;};
 for(let n=0;n<80&&!loaded();n++)await new Promise(r=>setTimeout(r,100));
 if(!loaded())throw Error('Preview did not load');
 const measure=()=>{
  const canvas=document.querySelector<HTMLElement>('.alignment-canvas')!,view=document.querySelector<HTMLElement>('.alignment-views')!,c=canvas.getBoundingClientRect(),v=view.getBoundingClientRect();
  const zoom=c.height/640;
  return {width:c.width,height:c.height,zoom,characterHeight:480*zoom,fullyVisible:c.top>=v.top&&c.bottom<=v.bottom&&c.left>=v.left&&c.right<=v.right,viewHeight:v.height};
 };
 const initial=measure(),select=document.querySelector<HTMLSelectElement>('[data-testid="alignment-display-zoom"]');
 const options=select?[...select.options].map(o=>o.value):[];
 let enlarged=null,restored=null;
 if(select){select.value='2';select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));enlarged=measure();select.value='0.5';select.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));restored=measure();}
 const inputs=[...document.querySelectorAll<HTMLInputElement>('.alignment-controls input[type="number"]')].map(i=>i.value);
 const button=[...document.querySelectorAll<HTMLButtonElement>('.alignment-controls button')].find(b=>b.textContent==='播放')!;
 const counter=()=>document.querySelector('.alignment-controls span')!.textContent;
 const layouts:Array<{top:number;height:number;canvasTop:number;controlsTop:number;counterWidth:number;statusHeight:number}>=[];
 const layout=()=>{const panel=document.querySelector<HTMLElement>('.alignment-workshop')!.getBoundingClientRect(),canvas=document.querySelector<HTMLElement>('.alignment-canvas')!.getBoundingClientRect(),counter=document.querySelector<HTMLElement>('.alignment-controls span')!.getBoundingClientRect(),status=document.querySelector('footer')!.nextElementSibling!.getBoundingClientRect();layouts.push({top:panel.top,height:panel.height,canvasTop:canvas.top,controlsTop:counter.top,counterWidth:counter.width,statusHeight:status.height});};
 layout();button.click();const visited=new Set<string>(),decoded=new Set<string>();
 const canvas=document.querySelector<HTMLElement>('.alignment-canvas')!;
 const observe=(event:Event)=>decoded.add((event.target as HTMLImageElement).currentSrc);canvas.addEventListener('load',observe,true);
 for(let n=0;n<130;n++){visited.add(counter()!);layout();await new Promise(r=>setTimeout(r,20));}
 canvas.removeEventListener('load',observe,true);
 const pause=[...document.querySelectorAll<HTMLButtonElement>('.alignment-controls button')].find(b=>b.textContent==='暂停')!;pause.click();
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));layout();
 const ranges=Object.fromEntries(Object.keys(layouts[0]!).map(key=>{const values=layouts.map(sample=>sample[key as keyof typeof sample]);return [key,{min:Math.min(...values),max:Math.max(...values),delta:Math.max(...values)-Math.min(...values)}];}));
 return {initial,options,enlarged,restored,inputs,playback:{visited:[...visited],decoded:[...decoded]},layout:{samples:layouts.length,ranges}};
};
