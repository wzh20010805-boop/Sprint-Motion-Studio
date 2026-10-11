/** 活跃精灵暂时超过上限时保留它们；非活跃纹理按最近使用淘汰。 */
export function textureEvictions(retained:ReadonlyMap<string,number>,active:ReadonlySet<string>,limit=8):string[] {
 const candidates=[...retained].filter(([url])=>!active.has(url)).sort((a,b)=>a[1]-b[1]);
 return candidates.slice(0,Math.max(0,retained.size-limit)).map(([url])=>url);
}
