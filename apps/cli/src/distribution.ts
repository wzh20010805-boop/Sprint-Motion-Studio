import { existsSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';

export function distributionRoot(executable=process.execPath):string|null {
 const root=dirname(resolve(executable));return existsSync(join(root,'sfs-package.json'))?root:null;
}
export function configureDistribution(root:string,env:Record<string,string|undefined>=process.env) {
 env.SFS_REPO_ROOT=root;
 env.SFS_IMAGE_PYTHON=join(root,'runtime/python/python.exe');
 env.SFS_MODEL_DIR??=join(env.LOCALAPPDATA??env.HOME??root,'SpriteMotionStudio','models');
 env.SFS_ASSET_DIR=join(root,'runtime/assets');
 env.PYTHONDONTWRITEBYTECODE='1';
 env.NUMBA_CACHE_DIR=join(env.LOCALAPPDATA??env.HOME??root,'SpriteMotionStudio','cache','numba');
 env.PATH=join(root,'runtime/bin')+';'+(env.PATH??'');
 return env;
}
