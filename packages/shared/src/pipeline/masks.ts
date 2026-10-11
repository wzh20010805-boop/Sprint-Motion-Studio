/** 坐标在完整源图中，区域为[x,y,width,height]，笔刷size为源像素直径。 */
export interface MaskStroke { mode: 'erase' | 'restore'; size: number; points: [number, number][] }
export interface MatteRequest { project_id: string; frame_ids: string[]; base_revision?: number; region?: [number, number, number, number] }
