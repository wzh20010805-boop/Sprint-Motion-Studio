import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskBrief } from '../../packages/shared/src/pipeline/collaboration';

const repo = join(import.meta.dir, '../..');

/** 在载入数据库前设置隔离工作区，保存子进程完整输出与输入。 */
export async function runCollaborationScript(script: string, prefix = 'task-01'): Promise<{ exit_code: number; stdout: string; stderr: string; workspace: string }> {
  if(process.env.SFS_WORKSPACE?.replaceAll('\\','/').includes('/controller-runs/task10-'))prefix='t10';
  const workspace = join(repo, 'fixtures/generated/human-ai', /^(?:t[3456789]|t8f|t10|t11|t12)$/.test(prefix)?`${prefix}-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`:`${prefix}-${crypto.randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
  await Bun.write(join(workspace, 'fixture-script.ts'), script);
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: repo, env: { ...process.env, SFS_WORKSPACE: workspace }, windowsHide: true,
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exit_code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  await Bun.write(join(workspace, 'test-output.json'), JSON.stringify({ exit_code, stdout, stderr }, null, 2));
  return { exit_code, stdout, stderr, workspace };
}

export const taskBrief: TaskBrief = {
  goal:{value:'保留完整测试动作',origin:'user'},source_identity:{kind:'video',original_sha256:'a'.repeat(64),frames:[]},
  context: { project_id: 'p', axis_id: 'a' }, source_id: 'source', ordered_source_frame_ids: ['sf0', 'sf1'],
  subject_region: { value: [0, 0, 32, 32], origin: 'user' },
  alignment: { value: { canvas: { width: 32, height: 32 }, anchor: [16, 30], scale: 1, resampling: 'pixel', mode: 'fixed', roots: [{ index: 0, x: 16, y: 30 }], offsets: {} }, origin: 'preset' },
  timing: { value: { mode: 'source_pts' }, origin: 'inferred' },
  loop: { value: true, origin: 'user' }, sampling_limit: 1,
  output: { value: { max_texture: 1024, gap: 0, margin: 0, formats: ['png_sequence', 'spritesheet', 'zip'] }, origin: 'preset' },
};

export const seedScript = `
  import assert from 'node:assert/strict';
  const {db} = await import('./apps/server/src/db.ts');
  db.exec("INSERT INTO projects(id,name,created_at) VALUES('p','fixture',1); INSERT INTO animation_axes(id,project_id,name,idx,created_at) VALUES('a','p','run',0,1); INSERT INTO sources(id,project_id,original_name,original_path,sha256,byte_size,probe_json,created_at) VALUES('source','p','source.mp4','retained-original','${'a'.repeat(64)}',1,'{}',1)");
  const brief = ${JSON.stringify(taskBrief)};
  const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
  const original=join(process.env.SFS_WORKSPACE,'source-original.bin');writeFileSync(original,'fixture original');const sourceHash=createHash('sha256').update('fixture original').digest('hex');
  db.query('UPDATE sources SET original_path=?,sha256=? WHERE id=?').run(original,sourceHash,'source');delete brief.source_identity;
`;

