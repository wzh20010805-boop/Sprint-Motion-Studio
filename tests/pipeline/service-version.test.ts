import {test,expect} from 'bun:test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureService} from '../../apps/cli/src/client';

test('a healthy legacy service is rejected without taking its lock or killing its jobs',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'sfs-version-')),instance_id=crypto.randomUUID(),token='a'.repeat(64);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>Response.json(new URL(r.url).pathname==='/api/health'?{ok:true,pid:process.pid,instance_id}:{sfs:{phase:'P2'}})});
 mkdirSync(join(workspace,'.sfs'));writeFileSync(join(workspace,'.sfs/service.json'),JSON.stringify({url:`http://127.0.0.1:${server.port}`,workspace,instance_id,pid:process.pid,token}));
 try{await expect(ensureService(workspace)).rejects.toMatchObject({code:'BACKEND_VERSION_CONFLICT',exitCode:6});expect((await fetch(`http://127.0.0.1:${server.port}/api/health`)).status).toBe(200);}
 finally{server.stop(true);}
});
