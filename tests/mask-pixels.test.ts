import {test,expect} from 'bun:test';
import {hasVisibleForeground} from '../apps/web/src/maskPixels';

test('manual review uses actual raw alpha times mask, including a single soft pixel',()=>{
 const mask=new Uint8ClampedArray([255,255,255,255]);
 expect(hasVisibleForeground(new Uint8ClampedArray([30,60,90,128]),mask)).toBe(true);
 expect(hasVisibleForeground(new Uint8ClampedArray([30,60,90,1]),mask)).toBe(true);
 expect(hasVisibleForeground(new Uint8ClampedArray([30,60,90,0]),mask)).toBe(false);
 expect(hasVisibleForeground(new Uint8ClampedArray([30,60,90,128]),new Uint8ClampedArray([0,0,0,255]))).toBe(false);
 expect(hasVisibleForeground(new Uint8ClampedArray([30,60,90,1]),new Uint8ClampedArray([128,128,128,255]))).toBe(false);
});
