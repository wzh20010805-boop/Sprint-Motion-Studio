import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {distributionRoot,configureDistribution} from '../../apps/cli/src/distribution';

test('portable runtime finds sibling package, uses writable user data and avoids developer paths',()=>{
 const root=mkdtempSync(join(tmpdir(),'sfs-relocated-'));writeFileSync(join(root,'sfs-package.json'),'{}');mkdirSync(join(root,'runtime/python'),{recursive:true});
 expect(distributionRoot(join(root,'sfs.exe'))).toBe(root);
 const env:Record<string,string|undefined>={LOCALAPPDATA:join(root,'user-data'),PATH:'C:\\Windows\\System32'};
 configureDistribution(root,env);
 expect(env.SFS_REPO_ROOT).toBe(root);
 expect(env.SFS_IMAGE_PYTHON).toBe(join(root,'runtime/python/python.exe'));
 expect(env.PATH.startsWith(join(root,'runtime/bin'))).toBeTrue();
});
