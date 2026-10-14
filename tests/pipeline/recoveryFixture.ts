import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export const repo=join(import.meta.dir,'../..');
export function recoveryWorkspace(){const p=join(repo,'fixtures/generated/human-ai','t9-'+crypto.randomUUID().replaceAll('-','').slice(0,12));mkdirSync(p,{recursive:true});return p;}
export async function child(workspace:string,label:string,script:string){
 writeFileSync(join(workspace,label+'.ts'),script);
 const p=Bun.spawn([process.execPath,'-e',script],{cwd:repo,env:{...process.env,SFS_WORKSPACE:workspace},windowsHide:true,stdout:'pipe',stderr:'pipe'});
 const [code,stdout,stderr]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
 writeFileSync(join(workspace,label+'.output.json'),JSON.stringify({code,stdout,stderr},null,2));return {code,stdout,stderr};
}
export const recoveryImports=String.raw`
import assert from 'node:assert/strict';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const {db,STORAGE_ROOT}=await import('./apps/server/src/db');
const ops=await import('./apps/server/src/pipeline/collaboration/operations');
const auth=await import('./apps/server/src/localSessions');auth.initializeLocalSessions('recovery-test','maker-token');
const actor=auth.authenticateLocalRequest(new Request('http://localhost:3000/test',{headers:{authorization:'Bearer maker-token'}}),'localhost:3000');
const saved=JSON.parse(readFileSync(join(STORAGE_ROOT,'crash.json'),'utf8'));
`;

