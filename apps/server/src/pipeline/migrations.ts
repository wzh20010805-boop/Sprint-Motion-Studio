import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PIPELINE_SCHEMA_VERSION = 3;

/** VACUUM INTO 读取当前连接的完整快照，包括尚在 WAL 中的已提交数据。 */
export function backupBeforeMigrations(db: Database, root: string): string | null {
  const hasMigrations = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (hasMigrations && db.query("SELECT 1 FROM schema_migrations WHERE version=?").get(PIPELINE_SCHEMA_VERSION)) return null;
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) return null;
  const directory = join(root, "backups");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `before-schema-3-${Date.now()}-${crypto.randomUUID()}.db`);
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
      db.exec(`CREATE TRIGGER sfs_${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE projects SET revision=revision+1 WHERE id=${newProject}; END;
        CREATE TRIGGER sfs_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE projects SET revision=revision+1 WHERE id=${oldProject}; END;
        CREATE TRIGGER sfs_${table}_update AFTER UPDATE ON ${table} WHEN ${changed} BEGIN UPDATE projects SET revision=revision+1 WHERE id IN (${newProject},${oldProject}); END;`);
    }
    const projectCols = db.query("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const projectChanged = projectCols.filter((entry) => !["id", "revision"].includes(entry.name)).map((entry) => `OLD.${entry.name} IS NOT NEW.${entry.name}`).join(" OR ") || "0";
    db.exec(`CREATE TRIGGER sfs_projects_update AFTER UPDATE ON projects WHEN ${projectChanged} BEGIN UPDATE projects SET revision=revision+1 WHERE id=NEW.id; END;`);
    db.query("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(PIPELINE_SCHEMA_VERSION, Date.now());
  })();
  const metadataPath = join(root, "workspace.json");
  const previous = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : {};
  writeFileSync(metadataPath, JSON.stringify({ ...previous, schema_version: "1.0", database_schema: PIPELINE_SCHEMA_VERSION, workspace_id: previous.workspace_id ?? crypto.randomUUID() }, null, 2));
  return { backupPath, schemaVersion: PIPELINE_SCHEMA_VERSION };
}
