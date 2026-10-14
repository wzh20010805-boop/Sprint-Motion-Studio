import {expect,test} from 'bun:test';
import {ReviewPlaybackBuffer} from '../apps/web/src/reviewPlaybackBuffer';

test('playback prepares each image once and reuses decoded frames without network or decoding',async()=>{
 const calls:string[]=[],released:string[]=[];
 const buffer=new ReviewPlaybackBuffer(async(key:string)=>{calls.push(key);return key;},value=>released.push(value),12);
 await buffer.prepare(['a','b','c'],4);
 await buffer.prepare(['a','b','c'],4);
 expect(calls.sort()).toEqual(['a','b','c']);
 expect(buffer.get('b')).toBe('b');expect(buffer.get('missing')).toBeUndefined();
 buffer.dispose();expect(released.sort()).toEqual(['a','b','c']);
});

test('closing during buffering cancels requests and releases even late decoded images',async()=>{
 let finish!:(value:string)=>void,signal!:AbortSignal;const released:string[]=[];
 const buffer=new ReviewPlaybackBuffer<string>(async(_key,s)=>{signal=s;return new Promise(resolve=>finish=resolve);},value=>released.push(value));
 const pending=buffer.prepare(['a'],4);buffer.dispose();expect(signal.aborted).toBe(true);
 finish('late');await expect(pending).rejects.toThrow();expect(released).toEqual(['late']);expect(buffer.get('a')).toBeUndefined();
});

test('buffer rejects excessive decoded memory before fetching and allows failed loads to retry',async()=>{
 let calls=0;const buffer=new ReviewPlaybackBuffer(async()=>{if(++calls===1)throw Error('network');return 'ok';},()=>{},8);
 await expect(buffer.prepare(['a','b','c'],4)).rejects.toThrow('PLAYBACK_BUFFER_LIMIT');expect(calls).toBe(0);
 await expect(buffer.prepare(['a'],4)).rejects.toThrow('network');
 await buffer.prepare(['a'],4);expect(buffer.get('a')).toBe('ok');buffer.dispose();
});
