import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runServiceManagement } from '../../apps/cli/src/serviceManagement';
import { ensureService } from '../../apps/cli/src/client';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function workspace() { const directory = mkdtempSync(join(tmpdir(), 'sfs-service-management-')); directories.push(directory); mkdirSync(join(directory, '.sfs')); return directory; }
function descriptor(directory: string, pid = process.pid) {
  const info = {schema_version:'1.0',instance_id:'test-instance',pid,started_at:new Date().toISOString(),workspace:directory,url:'http://127.0.0.1:1',token:'a'.repeat(64)};
  writeFileSync(join(directory,'.sfs/service.json'),JSON.stringify(info));
  writeFileSync(join(directory,'.sfs/service.lock'),JSON.stringify({instance_id:info.instance_id,pid}));
  return info;
}

describe('service management without starting another listener', () => {
  test('status of a missing descriptor does not create runtime files', async () => {
    const directory = workspace();
    const result = await runServiceManagement('service status',directory);
    expect(result.body.data.status).toBe('stopped');
    expect(existsSync(join(directory,'.sfs/service.json'))).toBe(false);
  });
  test('status never exposes connection credentials', async () => {
    const directory = workspace(), info = descriptor(directory);
    const result = await runServiceManagement('service status',directory);
    expect(result.body.data.status).toBe('unresponsive');
    expect(JSON.stringify(result)).not.toContain(info.token);
  });
  test('clean refuses a live owner and preserves all files', async () => {
    const directory = workspace(); descriptor(directory);
    writeFileSync(join(directory,'.sfs/desktop-bootstrap.json'),'private');
    const result = await runServiceManagement('service clean',directory);
    expect(result.exitCode).toBe(6);
    expect(existsSync(join(directory,'.sfs/service.lock'))).toBe(true);
    expect(readFileSync(join(directory,'.sfs/desktop-bootstrap.json'),'utf8')).toBe('private');
  });
  test('clean removes dead runtime descriptors while retaining data and logs', async () => {
    const directory = workspace(); descriptor(directory,2147483647);
    writeFileSync(join(directory,'.sfs/desktop-bootstrap.json'),'private');
    writeFileSync(join(directory,'.sfs/service.log'),'retained log');
    writeFileSync(join(directory,'framebaker.db'),'retained database');
    const result = await runServiceManagement('service clean',directory);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(directory,'.sfs/service.json'))).toBe(false);
    expect(existsSync(join(directory,'.sfs/service.lock'))).toBe(false);
    expect(existsSync(join(directory,'.sfs/desktop-bootstrap.json'))).toBe(false);
    expect(readFileSync(join(directory,'framebaker.db'),'utf8')).toBe('retained database');
    expect(readFileSync(join(directory,'.sfs/service.log'),'utf8')).toBe('retained log');
  });
  test('malformed and orphaned private descriptors need manual inspection', async () => {
    const directory = workspace();
    writeFileSync(join(directory,'.sfs/service.lock'),'not JSON');
    expect((await runServiceManagement('service clean',directory)).exitCode).toBe(6);
    expect(readFileSync(join(directory,'.sfs/service.lock'),'utf8')).toBe('not JSON');
    rmSync(join(directory,'.sfs/service.lock'));
    writeFileSync(join(directory,'.sfs/desktop-bootstrap.json'),'private');
    expect((await runServiceManagement('service clean',directory)).exitCode).toBe(6);
    expect(existsSync(join(directory,'.sfs/desktop-bootstrap.json'))).toBe(true);
  });
  test('an ongoing startup recovery lock blocks cleanup', async () => {
    const directory = workspace(); descriptor(directory,2147483647);
    writeFileSync(join(directory,'.sfs/service.recovery'),'retained startup');
    expect((await runServiceManagement('service clean',directory)).exitCode).toBe(6);
    expect(existsSync(join(directory,'.sfs/service.json'))).toBe(true);
    expect(readFileSync(join(directory,'.sfs/service.recovery'),'utf8')).toBe('retained startup');
  });
  test('clean retires only verified dead historical connection records', async () => {
    const directory = workspace();
    const old = descriptor(directory,2147483647), live = {...old,pid:process.pid,instance_id:'live-history'};
    writeFileSync(join(directory,'.sfs/service.json.before-human-desktop-1'),JSON.stringify(old));
    writeFileSync(join(directory,'.sfs/service.lock.before-human-desktop-1'),JSON.stringify({instance_id:old.instance_id,pid:old.pid}));
    writeFileSync(join(directory,'.sfs/desktop-bootstrap.json.before-human-desktop-1'),'old private');
    writeFileSync(join(directory,'.sfs/service.json.before-human-desktop-2'),JSON.stringify(live));
    writeFileSync(join(directory,'.sfs/unrelated.json'),'retained');
    const result = await runServiceManagement('service clean',directory);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(directory,'.sfs/service.json.before-human-desktop-1'))).toBe(false);
    expect(existsSync(join(directory,'.sfs/desktop-bootstrap.json.before-human-desktop-1'))).toBe(false);
    expect(existsSync(join(directory,'.sfs/service.json.before-human-desktop-2'))).toBe(true);
    expect(existsSync(join(directory,'.sfs/unrelated.json'))).toBe(true);
  });
  test('stop rechecks busy state cooperatively instead of killing a PID', async () => {
    const directory = workspace(), info = descriptor(directory);
    let stops=0;
    const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
      const path=new URL(request.url).pathname;
      if(path==='/api/health')return Response.json({ok:true,pid:info.pid,instance_id:info.instance_id});
      if(path==='/api/jobs')return Response.json({jobs:[]});
      stops++;
      return Response.json({ok:false,error:{code:'WORKSPACE_BUSY',message:'new work arrived'}},{status:409});
    }});
    info.url=`http://127.0.0.1:${server.port}`;writeFileSync(join(directory,'.sfs/service.json'),JSON.stringify(info));
    try {
      const result=await runServiceManagement('service stop',directory);
      expect(result.exitCode).toBe(6);expect(stops).toBe(1);
      expect(existsSync(join(directory,'.sfs/service.lock'))).toBe(true);
    } finally {server.stop(true);}
  });
  test('real bootstrapped service requires auth and exits through the idle-stop endpoint', async () => {
    const directory=workspace(), info=await ensureService(directory);
    try {
      const unauthorized=await fetch(info.url+'/api/v1/runtime/stop',{method:'POST'});
      expect(unauthorized.status).toBe(401);
      const before=await runServiceManagement('service status',directory);expect(before.body.data.status).toBe('running');
      const result=await runServiceManagement('service stop',directory);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(directory,'.sfs/service.lock'))).toBe(false);
      expect((await runServiceManagement('service status',directory)).body.data.status).toBe('stopped');
    } finally {try {process.kill(info.pid);}catch{}}
  },40000);
});
