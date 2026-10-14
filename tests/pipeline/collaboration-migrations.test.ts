import { test, expect } from 'bun:test';
import { runCollaborationScript, seedScript } from './collaborationFixtures';

test('schema 5 backs up committed WAL legacy data, retains approval history and migrates once', async () => {
  const result = await runCollaborationScript(String.raw`
    import assert from 'node:assert/strict'; import {Database} from 'bun:sqlite'; import {join} from 'node:path'; import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
    const root=process.env.SFS_WORKSPACE; const db=new Database(join(root,'framebaker.db'));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,created_at INTEGER,revision INTEGER DEFAULT 0); CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,type TEXT,status TEXT,created_at INTEGER); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER); INSERT INTO schema_migrations VALUES(4,1); CREATE TABLE frames(id TEXT PRIMARY KEY,project_id TEXT,offset_x REAL,status TEXT); CREATE TABLE animation_axes(id TEXT PRIMARY KEY,project_id TEXT); CREATE TABLE animation_tracks(id TEXT PRIMARY KEY,axis_id TEXT); CREATE TABLE animation_steps(id TEXT PRIMARY KEY,axis_id TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER); CREATE TABLE mask_heads(frame_id TEXT PRIMARY KEY,version_id TEXT,reviewed INTEGER); INSERT INTO projects VALUES('legacy','WAL retained',42,9); INSERT INTO settings VALUES('sfs.review.legacy.axis','{\"revision\":9,\"fingerprint\":\"old-approved\"}',1); INSERT INTO mask_heads VALUES('f','m',1)");
    mkdirSync(join(root,'exports/old'),{recursive:true});writeFileSync(join(root,'exports/old/assets.zip'),'history');
    const {migratePipeline}=await import('./apps/server/src/pipeline/migrations.ts');const first=migratePipeline(db,root);
    assert.equal(first.schemaVersion,5);assert.ok(first.backupPath);const backup=new Database(first.backupPath,{readonly:true});
    assert.equal(backup.query('SELECT name FROM projects').get().name,'WAL retained');assert.equal(backup.query("SELECT name FROM pragma_table_info('projects') WHERE name='content_revision'").get(),null);
    assert.equal(db.query('SELECT revision FROM projects').get().revision,9);assert.equal(db.query('SELECT content_revision FROM projects').get().content_revision,0);
    assert.equal(db.query('SELECT count(*) AS n FROM frame_reviews').get().n,0);assert.equal(db.query('SELECT count(*) AS n FROM playback_reviews').get().n,0);
    assert.equal(db.query('SELECT reviewed FROM mask_heads').get().reviewed,1);assert.equal(JSON.parse(db.query('SELECT value FROM settings').get().value).fingerprint,'old-approved');assert.equal(readFileSync(join(root,'exports/old/assets.zip'),'utf8'),'history');
    for(const name of ['collab_tasks','task_briefs','axis_workflow_modes','candidates','candidate_frames','frame_reviews','review_issues','playback_reviews','collab_operations'])assert.ok(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),name);
    for(const name of ['operation_id','attempt_number'])assert.ok(db.query("SELECT name FROM pragma_table_info('jobs') WHERE name=?").get(name));
    assert.equal(migratePipeline(db,root).backupPath,null);assert.equal(readdirSync(join(root,'backups')).length,1);assert.equal(JSON.parse(readFileSync(join(root,'workspace.json'),'utf8')).database_schema,5);
    backup.close();db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});

test('content revision follows production changes and excludes reviews, cosmetics and revision counters', async () => {
  const result = await runCollaborationScript(seedScript + String.raw`
    db.exec('PRAGMA recursive_triggers=ON');
    db.exec("INSERT INTO animation_tracks(id,axis_id,name,idx,is_primary) VALUES('track','a','Main',0,1); INSERT INTO animation_steps(id,axis_id,idx,duration) VALUES('step','a',0,1); INSERT INTO frames(id,project_id,idx,track_id,step_id,raw_path,status) VALUES('f','p',0,'track','step','raw.png','ready'); INSERT INTO mask_heads VALUES('f','m0',0)");
    const revision=()=>db.query("SELECT content_revision AS n FROM projects WHERE id='p'").get().n;
    let n=revision(); db.exec("UPDATE mask_heads SET reviewed=1; UPDATE frames SET tags='[\"reviewed\"]',status='ready'; UPDATE projects SET name='renamed',revision=revision+1; UPDATE animation_axes SET name='cosmetic'; UPDATE animation_tracks SET locked=1");assert.equal(revision(),n);
    db.exec("UPDATE frames SET offset_x=1 WHERE id='f'");assert.equal(revision(),++n);
    db.exec("UPDATE frames SET offset_x=1 WHERE id='f'");assert.equal(revision(),n);
    db.exec("UPDATE animation_steps SET duration=2 WHERE id='step'");assert.equal(revision(),++n);
    db.exec("UPDATE animation_axes SET fps=24 WHERE id='a'");assert.equal(revision(),++n);
    db.exec("UPDATE mask_heads SET version_id='m1' WHERE frame_id='f'");assert.equal(revision(),++n);
    db.exec("INSERT INTO settings VALUES('sfs.review.p.a','{}',1)");assert.equal(revision(),n);
    db.exec("INSERT INTO settings VALUES('sfs.alignment.p.a','{\"config\":1}',1)");assert.equal(revision(),++n);
    db.exec("UPDATE settings SET updated_at=2 WHERE key='sfs.alignment.p.a'");assert.equal(revision(),n);
    db.exec("INSERT INTO settings VALUES('sfs.preset.p','{\"scale\":2}',1)");assert.equal(revision(),++n);
    db.exec("UPDATE projects SET content_revision=content_revision+1 WHERE id='p'");assert.equal(revision(),++n);db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});

test('task brief versions are immutable and review appendices do not change content', async () => {
  const result = await runCollaborationScript(seedScript + `
    const {createTaskRecord}=await import('./apps/server/src/pipeline/collaboration/store.ts');const task=createTaskRecord(brief,{request_key:'new-task'});
    assert.throws(()=>db.query('UPDATE task_briefs SET brief_json=? WHERE task_id=?').run('{}',task.id),/IMMUTABLE_TASK_BRIEF/);
    assert.throws(()=>db.query('DELETE FROM task_briefs WHERE task_id=?').run(task.id),/IMMUTABLE_TASK_BRIEF/);
    const n=db.query("SELECT content_revision FROM projects WHERE id='p'").get().content_revision;
    db.query('UPDATE collab_tasks SET state=? WHERE id=?').run('cancelled',task.id);assert.equal(db.query("SELECT content_revision FROM projects WHERE id='p'").get().content_revision,n);
    db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});

test('candidate content stays immutable while independent checks and reviewer records remain writable', async () => {
  const result = await runCollaborationScript(seedScript + `
    const {createTaskRecord}=await import('./apps/server/src/pipeline/collaboration/store.ts');const task=createTaskRecord(brief,{request_key:'new-task'});
    db.query("INSERT INTO candidates(id,task_id,brief_version,content_revision,content_token_hash,content_hash,playback_hash,compositor_hash,manifest_path,manifest_sha256,manifest_json,created_at) VALUES('c',?,1,0,?,?,?,?,?,?,?,1)").run(task.id,'h','h','h','h','manifest.json','h','{}');
    db.exec("INSERT INTO candidate_frames(candidate_id,frame_id,source_frame_id,source_index,sequence_index,duration_num,duration_den,duration_origin,raw_sha256,mask_version_id,mask_sha256,png_sha256,content_hash,files_json,resolved_transform_json,resolved_root_json,source_to_canvas_json) VALUES('c','f','sf',0,0,1,24,'next_pts','raw','m','mask','png','content','{}','{}','{}','{}')");
    assert.throws(()=>db.exec("UPDATE candidates SET manifest_json='{changed}' WHERE id='c'"),/IMMUTABLE_CANDIDATE_CONTENT/);
    assert.throws(()=>db.exec("UPDATE candidate_frames SET png_sha256='different' WHERE candidate_id='c'"),/IMMUTABLE_CANDIDATE_CONTENT/);
    assert.throws(()=>db.exec("DELETE FROM candidate_frames WHERE candidate_id='c'"),/IMMUTABLE_CANDIDATE_CONTENT/);
    const n=db.query("SELECT content_revision FROM projects WHERE id='p'").get().content_revision;
    db.exec("UPDATE candidates SET technical_check_id='check',technical_check_json='{}',visibility='submitted',review_revision=1 WHERE id='c'; INSERT INTO frame_reviews(candidate_id,frame_id,frame_content_hash,verdict,review_revision,actor_session_id,actor_role,request_key,updated_at) VALUES('c','f','content','approved',1,'reviewer','reviewer','approve',1)");
    assert.equal(db.query("SELECT content_revision FROM projects WHERE id='p'").get().content_revision,n);db.close();console.log('PASS');
  `);
  expect(result.exit_code, result.stdout + result.stderr).toBe(0);
});
