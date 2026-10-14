import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PIPELINE_SCHEMA_VERSION = 5;

/** VACUUM INTO 读取当前连接的完整快照，包括尚在 WAL 中的已提交数据。 */
export function backupBeforeMigrations(db: Database, root: string): string | null {
  const hasMigrations = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (hasMigrations && db.query("SELECT 1 FROM schema_migrations WHERE version=?").get(PIPELINE_SCHEMA_VERSION)) return null;
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) return null;
  const directory = join(root, "backups");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `before-schema-${PIPELINE_SCHEMA_VERSION}-${Date.now()}-${crypto.randomUUID()}.db`);
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  return path;
}

function addColumn(db: Database, table: string, column: string, declaration: string) {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

/** 增量扩展唯一上游数据库；来源记录补充 projects / axes / 主轨，而不复制业务实体。 */
export function migratePipeline(db: Database, root: string, existingBackup?: string | null): { backupPath: string | null; schemaVersion: number } {
  if (db.query("SELECT 1 FROM schema_migrations WHERE version=?").get(PIPELINE_SCHEMA_VERSION)) return { backupPath: null, schemaVersion: PIPELINE_SCHEMA_VERSION };
  const backupPath = existingBackup ?? backupBeforeMigrations(db, root);
  db.transaction(() => {
    addColumn(db, "projects", "revision", "INTEGER NOT NULL DEFAULT 0");
    const jobColumns: Record<string, string> = {
      payload: "TEXT NOT NULL DEFAULT '{}'", result: "TEXT", error_code: "TEXT", clip_id: "TEXT",
      base_revision: "INTEGER", input_fingerprint: "TEXT", backend: "TEXT", checkpoint: "TEXT",
      log_path: "TEXT", updated_at: "INTEGER", requires_user_action: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [name, declaration] of Object.entries(jobColumns)) addColumn(db, "jobs", name, declaration);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, original_name TEXT NOT NULL,
        original_path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
        probe_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'imported', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);
      CREATE TABLE IF NOT EXISTS source_frames (
        source_frame_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_index INTEGER NOT NULL,
        file TEXT NOT NULL, pts TEXT NOT NULL, time_base_num INTEGER NOT NULL, time_base_den INTEGER NOT NULL,
        presentation_num INTEGER NOT NULL, presentation_den INTEGER NOT NULL,
        duration_num INTEGER NOT NULL, duration_den INTEGER NOT NULL,
        duration_origin TEXT NOT NULL, decode_status TEXT NOT NULL, timing_json TEXT NOT NULL,
        UNIQUE(source_id, source_index)
      );
      CREATE TABLE IF NOT EXISTS clips (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
        axis_id TEXT NOT NULL UNIQUE, track_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'imported', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_clip_active ON jobs(clip_id,status);
      CREATE TABLE IF NOT EXISTS mask_versions (
        id TEXT PRIMARY KEY, frame_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
        mask_path TEXT NOT NULL, rgba_path TEXT NOT NULL, preview_path TEXT NOT NULL,
        raw_path TEXT NOT NULL, raw_sha256 TEXT NOT NULL, info TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mask_versions_frame ON mask_versions(frame_id,created_at);
      CREATE TABLE IF NOT EXISTS mask_heads (frame_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0);
    `);
    // GUI 的实际修改也推进同一修订；无变化的启动归一化 UPDATE 不制造虚假冲突。
    const targets: Array<[string, string, string]> = [
      ["frames", "NEW.project_id", "OLD.project_id"],
      ["animation_axes", "NEW.project_id", "OLD.project_id"],
      ["animation_tracks", "(SELECT project_id FROM animation_axes WHERE id=NEW.axis_id)", "(SELECT project_id FROM animation_axes WHERE id=OLD.axis_id)"],
      ["animation_steps", "(SELECT project_id FROM animation_axes WHERE id=NEW.axis_id)", "(SELECT project_id FROM animation_axes WHERE id=OLD.axis_id)"],
    ];
    for (const [table, newProject, oldProject] of targets) {
      const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const changed = cols.filter((col) => col.name !== "id").map((col) => `OLD.${col.name} IS NOT NEW.${col.name}`).join(" OR ") || "0";
      db.exec(`CREATE TRIGGER IF NOT EXISTS sfs_${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE projects SET revision=revision+1 WHERE id=${newProject}; END;
        CREATE TRIGGER IF NOT EXISTS sfs_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE projects SET revision=revision+1 WHERE id=${oldProject}; END;
        CREATE TRIGGER IF NOT EXISTS sfs_${table}_update AFTER UPDATE ON ${table} WHEN ${changed} BEGIN UPDATE projects SET revision=revision+1 WHERE id IN (${newProject},${oldProject}); END;`);
    }
    addColumn(db, 'projects', 'content_revision', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'jobs', 'operation_id', 'TEXT');
    addColumn(db, 'jobs', 'attempt_number', 'INTEGER NOT NULL DEFAULT 0');
    // 旧修订触发器排除两种计数器，递归触发器开启时也不会自增循环。
    const projectCols = db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const projectChanged = projectCols.filter((entry) => !["id", "revision", "content_revision"].includes(entry.name)).map((entry) => `OLD.${entry.name} IS NOT NEW.${entry.name}`).join(" OR ") || "0";
    db.exec(`DROP TRIGGER IF EXISTS sfs_projects_update;
      CREATE TRIGGER sfs_projects_update AFTER UPDATE ON projects WHEN ${projectChanged} BEGIN UPDATE projects SET revision=revision+1 WHERE id=NEW.id; END;`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS collab_tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, axis_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
        brief_version INTEGER NOT NULL DEFAULT 1 CHECK(brief_version>=1), content_revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'preparing'
          CHECK(state IN ('preparing','producing','checking','awaiting_review','reworking','accepted','packaging','delivered','needs_input','failed','cancelled')),
        selected_candidate_id TEXT, acceptance_epoch INTEGER NOT NULL DEFAULT 0 CHECK(acceptance_epoch>=0),
        operation_ids_json TEXT NOT NULL DEFAULT '[]', recovery_json TEXT, error_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collab_tasks_context ON collab_tasks(project_id,axis_id);
      CREATE TABLE IF NOT EXISTS task_briefs (
        task_id TEXT NOT NULL REFERENCES collab_tasks(id), version INTEGER NOT NULL CHECK(version>=1),
        brief_json TEXT NOT NULL, brief_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id,version)
      );
      CREATE TRIGGER IF NOT EXISTS immutable_task_brief_update BEFORE UPDATE ON task_briefs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TASK_BRIEF'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_task_brief_delete BEFORE DELETE ON task_briefs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TASK_BRIEF'); END;
      CREATE TABLE IF NOT EXISTS axis_workflow_modes (
        project_id TEXT NOT NULL, axis_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='collaboration'),
        created_at INTEGER NOT NULL, PRIMARY KEY(project_id,axis_id)
      );
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES collab_tasks(id), parent_candidate_id TEXT REFERENCES candidates(id),
        brief_version INTEGER NOT NULL, content_revision INTEGER NOT NULL, content_token_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL, playback_hash TEXT NOT NULL, compositor_hash TEXT NOT NULL,
        manifest_path TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','submitted')),
        technical_check_id TEXT, technical_check_json TEXT, self_check_id TEXT, self_check_json TEXT, sampling_plan_json TEXT,
        review_revision INTEGER NOT NULL DEFAULT 0 CHECK(review_revision>=0), created_at INTEGER NOT NULL, submitted_at INTEGER,
        FOREIGN KEY(task_id,brief_version) REFERENCES task_briefs(task_id,version)
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_task ON candidates(task_id,created_at);
      CREATE TABLE IF NOT EXISTS candidate_frames (
        candidate_id TEXT NOT NULL REFERENCES candidates(id), frame_id TEXT NOT NULL, source_frame_id TEXT NOT NULL,
        source_index INTEGER NOT NULL, sequence_index INTEGER NOT NULL CHECK(sequence_index>=0),
        duration_num INTEGER NOT NULL CHECK(duration_num>0), duration_den INTEGER NOT NULL CHECK(duration_den>0), duration_origin TEXT NOT NULL,
        raw_sha256 TEXT NOT NULL, mask_version_id TEXT NOT NULL, mask_sha256 TEXT NOT NULL, png_sha256 TEXT NOT NULL, content_hash TEXT NOT NULL,
        files_json TEXT NOT NULL, resolved_transform_json TEXT NOT NULL, resolved_root_json TEXT NOT NULL, source_to_canvas_json TEXT NOT NULL,
        PRIMARY KEY(candidate_id,frame_id), UNIQUE(candidate_id,sequence_index)
      );
      CREATE TRIGGER IF NOT EXISTS immutable_candidate_content BEFORE UPDATE ON candidates
        WHEN OLD.id IS NOT NEW.id OR OLD.task_id IS NOT NEW.task_id OR OLD.parent_candidate_id IS NOT NEW.parent_candidate_id
          OR OLD.brief_version IS NOT NEW.brief_version OR OLD.content_revision IS NOT NEW.content_revision OR OLD.content_token_hash IS NOT NEW.content_token_hash
          OR OLD.content_hash IS NOT NEW.content_hash OR OLD.playback_hash IS NOT NEW.playback_hash OR OLD.compositor_hash IS NOT NEW.compositor_hash
          OR OLD.manifest_path IS NOT NEW.manifest_path OR OLD.manifest_sha256 IS NOT NEW.manifest_sha256 OR OLD.manifest_json IS NOT NEW.manifest_json
        BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANDIDATE_CONTENT'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_candidate_frame_update BEFORE UPDATE ON candidate_frames BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANDIDATE_CONTENT'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_candidate_frame_delete BEFORE DELETE ON candidate_frames BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANDIDATE_CONTENT'); END;
      CREATE TABLE IF NOT EXISTS frame_reviews (
        candidate_id TEXT NOT NULL, frame_id TEXT NOT NULL, frame_content_hash TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('pending','approved','needs_repair')), review_revision INTEGER NOT NULL,
        actor_session_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK(actor_role='reviewer'), request_key TEXT NOT NULL,
        inherited_candidate_id TEXT, inherited_review_revision INTEGER, inheritance_basis_json TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(candidate_id,frame_id), FOREIGN KEY(candidate_id,frame_id) REFERENCES candidate_frames(candidate_id,frame_id)
      );
      CREATE TABLE IF NOT EXISTS review_issues (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), frame_ids_json TEXT NOT NULL,
        rect_json TEXT, coordinate_system TEXT NOT NULL CHECK(coordinate_system='final_canvas_pixels'),
        text TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('blocking','advisory')),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','repair_linked','resolved','accepted_exception')),
        repair_candidate_id TEXT REFERENCES candidates(id), repair_frame_ids_json TEXT, repair_note TEXT,
        review_revision INTEGER NOT NULL, actor_session_id TEXT NOT NULL, request_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_issues_candidate ON review_issues(candidate_id,status);
      CREATE TABLE IF NOT EXISTS playback_reviews (
        candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), playback_hash TEXT NOT NULL, confirmed INTEGER NOT NULL CHECK(confirmed IN (0,1)),
        review_revision INTEGER NOT NULL, actor_session_id TEXT NOT NULL, actor_role TEXT NOT NULL CHECK(actor_role='reviewer'), request_key TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collab_operations (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        base_content_json TEXT, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'claimed'
          CHECK(state IN ('claimed','queued','running','succeeded','failed','interrupted','cancelled','needs_input')),
        attempt_job_ids_json TEXT NOT NULL DEFAULT '[]', result_json TEXT, checkpoint_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collab_operations_state ON collab_operations(state,updated_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_operation_attempt ON jobs(operation_id,attempt_number);
    `);
    // 只监听实际制作字段，审核附加记录和名称、锁定状态等不进入内容修订。
    const contentTargets: Array<[string, string[], string, string]> = [
      ['frames', ['project_id','idx','track_id','step_id','raw_path','processed_path','duration','offset_x','offset_y','scale','rotation','opacity','metadata'], 'NEW.project_id', 'OLD.project_id'],
      ['animation_axes', ['project_id','fps'], 'NEW.project_id', 'OLD.project_id'],
      ['animation_tracks', ['axis_id','idx','visible','is_primary'], '(SELECT project_id FROM animation_axes WHERE id=NEW.axis_id)', '(SELECT project_id FROM animation_axes WHERE id=OLD.axis_id)'],
      ['animation_steps', ['axis_id','idx','duration'], '(SELECT project_id FROM animation_axes WHERE id=NEW.axis_id)', '(SELECT project_id FROM animation_axes WHERE id=OLD.axis_id)'],
      ['mask_heads', ['frame_id','version_id'], '(SELECT project_id FROM frames WHERE id=NEW.frame_id)', '(SELECT project_id FROM frames WHERE id=OLD.frame_id)'],
      ['sources', ['project_id','original_path','sha256','probe_json'], 'NEW.project_id', 'OLD.project_id'],
      ['source_frames', ['source_id','source_index','file','pts','time_base_num','time_base_den','presentation_num','presentation_den','duration_num','duration_den','duration_origin','timing_json'], '(SELECT project_id FROM sources WHERE id=NEW.source_id)', '(SELECT project_id FROM sources WHERE id=OLD.source_id)'],
    ];
    for (const [table, fields, newProject, oldProject] of contentTargets) {
      const available = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{name: string}>).map(column => column.name));
      const changed = fields.filter(field => available.has(field)).map(field => `OLD.${field} IS NOT NEW.${field}`).join(' OR ') || '0';
      db.exec(`CREATE TRIGGER IF NOT EXISTS collab_${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE projects SET content_revision=content_revision+1 WHERE id=${newProject}; END;
        CREATE TRIGGER IF NOT EXISTS collab_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE projects SET content_revision=content_revision+1 WHERE id=${oldProject}; END;
        CREATE TRIGGER IF NOT EXISTS collab_${table}_update AFTER UPDATE ON ${table} WHEN ${changed} BEGIN UPDATE projects SET content_revision=content_revision+1 WHERE id IN (${newProject},${oldProject}); END;`);
    }
    // 独立旧库可能没有 settings；实际服务先建立它。迁移器仍可单独运行。
    if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
      const settingsProject = (row: 'NEW' | 'OLD') => `CASE WHEN ${row}.key LIKE 'sfs.preset.%' THEN substr(${row}.key,12) WHEN ${row}.key LIKE 'sfs.alignment.%' THEN substr(${row}.key,15,instr(substr(${row}.key,15),'.')-1) END`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS collab_settings_insert AFTER INSERT ON settings BEGIN UPDATE projects SET content_revision=content_revision+1 WHERE id=${settingsProject('NEW')}; END;
        CREATE TRIGGER IF NOT EXISTS collab_settings_delete AFTER DELETE ON settings BEGIN UPDATE projects SET content_revision=content_revision+1 WHERE id=${settingsProject('OLD')}; END;
        CREATE TRIGGER IF NOT EXISTS collab_settings_update AFTER UPDATE ON settings WHEN OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value BEGIN UPDATE projects SET content_revision=content_revision+1 WHERE id IN (${settingsProject('NEW')},${settingsProject('OLD')}); END;`);
    }
    // 新库同时记录既有增量版本；旧库的版本及批准不改写或提升。
    db.query('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,?)').run(Date.now());
    db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(PIPELINE_SCHEMA_VERSION, Date.now());
  })();
  const metadataPath = join(root, "workspace.json");
  const previous = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : {};
  writeFileSync(metadataPath, JSON.stringify({ ...previous, schema_version: "1.0", database_schema: PIPELINE_SCHEMA_VERSION, workspace_id: previous.workspace_id ?? crypto.randomUUID() }, null, 2));
  return { backupPath, schemaVersion: PIPELINE_SCHEMA_VERSION };
}
