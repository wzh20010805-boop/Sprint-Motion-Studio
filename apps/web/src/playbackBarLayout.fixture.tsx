import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import PlaybackBar from './components/PlaybackBar';
import './styles.css';
const shell=document.querySelector<HTMLDivElement>('#root')!;
shell.style.cssText='position:relative;width:1050px;height:240px';
const root=createRoot(shell),noop=()=>{};
const render=(cursor:number,fps:number,total:number)=>flushSync(()=>root.render(<PlaybackBar dragConstraints={{current:shell}} fps={fps} paused={false} cursor={cursor} total={total} zoom={1} range={null} onRangeChange={noop} onTogglePause={noop} onFpsChange={noop}/>));
render(0,45,121);
(window as any).measurePlaybackBar=async()=>{
 await document.fonts.ready;
 const samples=[];
 for(const frame of [1,9,10,48,99,100,121]){
  render(frame-1,45,121);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const bar=document.querySelector('.playback-bar')!.getBoundingClientRect(),counter=document.querySelector('.frame-indicator')!.getBoundingClientRect();
  samples.push({frame,width:bar.width,left:bar.left,counterWidth:counter.width});
 }
 return samples;
};
