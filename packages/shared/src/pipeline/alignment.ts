import type { Frame } from '../types';
export const PRODUCTION_API_VERSION='1.1';

/** 主编辑器的中心锚点变换；偏移使用源图像素，旋转为弧度。 */
export type FrameRenderTransform = Pick<Frame,'offset_x'|'offset_y'|'scale'|'rotation'|'opacity'>;

/** 源图像左上像素边界坐标。公共比例和画布按角色项目共享。 */
export interface AlignmentConfig {
 canvas: { width:number; height:number };
 anchor: [number,number];
 scale: number;
 resampling: 'pixel'|'cartoon';
 mode: 'fixed'|'ground_keyframes';
 roots: Array<{index:number;x:number;y:number}>;
 offsets: Record<string,[number,number]>;
}
export interface ExportRequest {
 project_id:string; axis_id:string; draft?:boolean; base_revision?:number;
 max_texture?:number; gap?:number; margin?:number; timing?:'source_pts'|'constant';
}

/** 与Pillow合成器相同的线性地面轨迹；固定模式与区间外均保持端点。 */
export function rootAt(config:AlignmentConfig,index:number):{x:number;y:number} {
 const roots=[...config.roots].sort((a,b)=>a.index-b.index);
 if(config.mode==='fixed'||index<=roots[0]!.index)return roots[0]!;
 for(let i=1;i<roots.length;i++)if(index<=roots[i]!.index){const a=roots[i-1]!,b=roots[i]!,t=(index-a.index)/(b.index-a.index);return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};}
 return roots.at(-1)!;
}
