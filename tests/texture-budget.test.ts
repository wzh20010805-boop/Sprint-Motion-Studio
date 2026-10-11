import { test,expect } from 'bun:test';
import { textureEvictions } from '../apps/web/src/textureBudget';

test('300 sequential high resolution textures retain only bounded recent and active textures',()=>{
 const retained=new Map<string,number>();let clock=0;
 for(let i=0;i<300;i++){retained.set('f'+i,++clock);const active=new Set(['f'+i,'f'+Math.max(0,i-1)]);for(const url of textureEvictions(retained,active,8))retained.delete(url);expect(retained.size).toBeLessThanOrEqual(8);expect(retained.has('f'+i)).toBeTrue();}
 expect(retained.has('f0')).toBeFalse();
});
