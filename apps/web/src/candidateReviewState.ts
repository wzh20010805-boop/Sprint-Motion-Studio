export interface DisplayState<T>{desired:string|null;displayed:{key:string;value:T}|null;loading:boolean;error:string|null}
export interface ReviewTarget{key:string;candidateId:string;ready:boolean}
export function sameReviewTarget(captured:ReviewTarget,current:ReviewTarget,requirePixels:boolean){return captured.candidateId===current.candidateId&&(!requirePixels||(current.ready&&captured.key===current.key));}
/** 首次写入前冻结 CAS 与负载；未知响应重试不重新读取并替换原始参数。 */
export function preparedReviewMutation<T,R>(prepare:()=>Promise<T>,mutate:(request:T)=>Promise<R>):()=>Promise<R>{
 let prepared:Promise<T>|null=null;
 return ()=>{prepared??=prepare().catch(error=>{prepared=null;throw error;});return prepared.then(mutate);};
}
/** 每个画布独占解码资源；不触碰全局 URL 缓存或其他画布。 */
export class ReviewImageGate<T>{
 state:DisplayState<T>={desired:null,displayed:null,loading:false,error:null};
 private generation=0;private closed=false;private release:(()=>void)|null=null;
 begin(key:string){this.state={...this.state,desired:key,loading:true,error:null};return {key,generation:++this.generation};}
 succeed(ticket:{key:string;generation:number},value:T,dispose:(value:T)=>void){
  if(this.closed||ticket.generation!==this.generation){dispose(value);return false;}
  this.release?.();this.release=()=>dispose(value);this.state={desired:ticket.key,displayed:{key:ticket.key,value},loading:false,error:null};return true;
 }
 fail(ticket:{key:string;generation:number},error:string){if(this.closed||ticket.generation!==this.generation)return false;this.state={...this.state,loading:false,error};return true;}
 ready(key:string){return !this.closed&&!this.state.loading&&!this.state.error&&this.state.desired===key&&this.state.displayed?.key===key;}
 dispose(){this.closed=true;this.generation++;this.release?.();this.release=null;this.state={desired:null,displayed:null,loading:false,error:null};}
}
export function reviewShortcutBlocked(event:KeyboardEvent,dialog:boolean,busy:boolean){
 const target=event.target as HTMLElement|null;
 return event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||dialog||busy||!!target?.isContentEditable||!!target?.closest?.('input,textarea,select,[contenteditable],[role="slider"],[role="spinbutton"],[role="combobox"]');
}
