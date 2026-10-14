/** 画布独占的冻结图像缓存；播放前解码，播放中只读取，卸载时释放。 */
export class ReviewPlaybackBuffer<T>{
 private values=new Map<string,T>();
 private pending=new Map<string,Promise<T>>();
 private abort=new AbortController();
 private bytesPerImage=0;
 constructor(private load:(key:string,signal:AbortSignal)=>Promise<T>,private release:(value:T)=>void,private maxBytes=256*1024*1024){}
 get(key:string){return this.values.get(key);}
 async prepare(keys:readonly string[],bytesPerImage:number){
  if(this.abort.signal.aborted)throw Error('PLAYBACK_BUFFER_CLOSED');
  const unique=[...new Set(keys)],all=new Set([...this.values.keys(),...this.pending.keys(),...unique]);
  this.bytesPerImage=Math.max(this.bytesPerImage,bytesPerImage);
  if(!Number.isSafeInteger(bytesPerImage)||bytesPerImage<=0||all.size*this.bytesPerImage>this.maxBytes)throw Error('PLAYBACK_BUFFER_LIMIT');
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,unique.length)},async()=>{
   while(next<unique.length){const key=unique[next++]!;await this.read(key);}
  }));
 }
 private read(key:string):Promise<T>{
  if(this.abort.signal.aborted)return Promise.reject(Error('PLAYBACK_BUFFER_CLOSED'));
  if(this.values.has(key))return Promise.resolve(this.values.get(key)!);
  const previous=this.pending.get(key);if(previous)return previous;
  const request=this.load(key,this.abort.signal).then(value=>{
   if(this.abort.signal.aborted){this.release(value);throw Error('PLAYBACK_BUFFER_CLOSED');}
   this.values.set(key,value);return value;
  }).finally(()=>this.pending.delete(key));
  this.pending.set(key,request);return request;
 }
 dispose(){this.abort.abort();for(const value of this.values.values())this.release(value);this.values.clear();}
}
