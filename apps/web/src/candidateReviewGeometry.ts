import type {CandidateFrame,PixelRect,AffineMatrix} from '@framebaker/shared';
export function validRegion(r:PixelRect,w:number,h:number){return r.every(Number.isFinite)&&r[0]>=0&&r[1]>=0&&r[2]>0&&r[3]>0&&r[0]+r[2]<=w&&r[1]+r[3]<=h;}
export function viewportLayout(width:number,height:number,w:number,h:number,zoom:number,pan:[number,number]){
 const scale=Math.min(width/w,height/h)*zoom;return {scale,x:(width-w*scale)/2+pan[0],y:(height-h*scale)/2+pan[1]};
}
/** 实际显示 canvas 的 CSS 边界已包含边框原点、留白、平移和缩放；两轴分别反算像素边界。 */
export function viewportPoint(x:number,y:number,rect:{left:number;top:number;width:number;height:number},w:number,h:number):[number,number]{
 return [(x-rect.left)*w/rect.width,(y-rect.top)*h/rect.height];
}

type Point=[number,number];
const map=(m:AffineMatrix,[x,y]:Point):Point=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
export function sourceQuadrilateral(frame:CandidateFrame,rect:PixelRect):{quad:Point[]|null;reason:string|null}{
 const {matrix:m,inverse_matrix:inv,noninvertible_reason:reason}=frame.source_to_canvas;
 if(!m||!inv)return {quad:null,reason:reason||'MAPPING_UNAVAILABLE'};
 if(![...m,...inv].every(Number.isFinite)||!Number.isFinite(frame.source_size.width)||!Number.isFinite(frame.source_size.height)||frame.source_size.width<=0||frame.source_size.height<=0)return {quad:null,reason:'MAPPING_MISMATCH'};
 if(m[0]*m[3]-m[1]*m[2]===0)return {quad:null,reason:'ZERO_DETERMINANT'};
 const [x,y,w,h]=rect,corners:Point[]=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],quad=corners.map(p=>map(inv,p));
 if(quad.some((p,i)=>map(m,p).some((v,j)=>Math.abs(v-corners[i]![j]!)>1e-6)))return {quad:null,reason:'MAPPING_MISMATCH'};
 if(quad.some(p=>p[0]<0||p[1]<0||p[0]>frame.source_size.width||p[1]>frame.source_size.height))return {quad:null,reason:'SOURCE_CLIPPED'};
 return {quad,reason:null};
}
