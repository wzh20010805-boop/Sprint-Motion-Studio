import { test, expect } from 'bun:test';
import { getMattingInfo, matteFrame } from '../../apps/server/src/jobs/matting';
import { db, uid, STORAGE_ROOT } from '../../apps/server/src/db';
import { join } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

test('缺少引擎必须失败，不能复制原图并改成ready', async () => {
  const oldPath = process.env.PATH;
  const oldPython = process.env.SFS_IMAGE_PYTHON;
  process.env.SFS_IMAGE_PYTHON = join(STORAGE_ROOT, 'missing-python.exe');
  process.env.PATH = '';
  const projectId = uid(), frameId = uid();
  mkdirSync(join(STORAGE_ROOT, 'projects', projectId), { recursive: true });
  const raw = join(STORAGE_ROOT, 'projects', projectId, 'raw.png');
  writeFileSync(raw, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  db.query('INSERT INTO projects(id,name,created_at) VALUES(?,?,?)').run(projectId, 'P2 test', Date.now());
  db.query('INSERT INTO frames(id,project_id,idx,raw_path,status) VALUES(?,?,?,?,?)').run(frameId, projectId, 0, raw, 'raw');
  const original = readFileSync(raw);
  try {
    expect(getMattingInfo().hint).not.toContain('已原样复制');
    await expect(matteFrame(frameId)).rejects.toThrow();
    expect(db.query('SELECT status,processed_path FROM frames WHERE id=?').get(frameId)).toEqual({status:'raw', processed_path:null});
    expect(readFileSync(raw)).toEqual(original);
    expect(existsSync(join(STORAGE_ROOT,'projects',projectId,'processed',frameId+'.png'))).toBe(false);
  } finally {
    process.env.PATH = oldPath;
    if (oldPython === undefined) delete process.env.SFS_IMAGE_PYTHON; else process.env.SFS_IMAGE_PYTHON = oldPython;
    db.query('DELETE FROM frames WHERE id=?').run(frameId);
    db.query('DELETE FROM projects WHERE id=?').run(projectId);
  }
});
