/** 与Pillow灰度遮罩相乘一致：使用实际RGBA判断空图，不要求不透明核心。 */
export function hasVisibleForeground(raw:ArrayLike<number>,mask:ArrayLike<number>):boolean {
 for(let i=0;i<raw.length&&i<mask.length;i+=4)if(Math.floor(raw[i+3]!*mask[i]!/255)>0)return true;
 return false;
}
