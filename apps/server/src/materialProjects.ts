import type { Database } from 'bun:sqlite';

type MaterialIdentity = { id: string; metadata: string };

function metadataOf(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** 一次读取谱系，按明确的 ID 关联分区；绝不通过文件名或目录猜测项目。 */
export function resolveMaterialProjects(database: Database, materials?: MaterialIdentity[]): Map<string, string[]> {
  const rows = materials ?? database.query('SELECT id,metadata FROM materials').all() as MaterialIdentity[];
  const projects = new Set((database.query('SELECT id FROM projects').all() as Array<{ id: string }>).map(row => row.id));
  const sourceProjects = new Map((database.query('SELECT id,project_id FROM sources').all() as Array<{ id: string; project_id: string }>).map(row => [row.id, row.project_id]));
  const frames = database.query('SELECT id,project_id,metadata FROM frames').all() as Array<{ id: string; project_id: string; metadata: string }>;
  const frameProjects = new Map(frames.map(row => [row.id, row.project_id]));
  const reused = new Map<string, Set<string>>();
  const addReuse = (material: unknown, projectId: string) => {
    if (typeof material !== 'string' || !projects.has(projectId)) return;
    if (!reused.has(material)) reused.set(material, new Set());
    reused.get(material)!.add(projectId);
  };
  for (const frame of frames) {
    addReuse(metadataOf(frame.metadata).fromMaterial, frame.project_id);
  }
  const skeletal = database.query('SELECT project_id,document FROM skeletal_projects').all() as Array<{ project_id: string; document: string }>;
  for (const project of skeletal) {
    const document = metadataOf(project.document) as { character?: { binding?: { attachments?: unknown } } };
    const attachments = document.character?.binding?.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) addReuse(attachment?.materialId, project.project_id);
  }
  return new Map(rows.map(row => {
    const metadata = metadataOf(row.metadata);
    const ids = new Set(reused.get(row.id));
    const add = (id: unknown) => { if (typeof id === 'string' && projects.has(id)) ids.add(id); };
    if (Array.isArray(metadata.project_ids)) metadata.project_ids.forEach(add);
    if (typeof metadata.source_id === 'string') add(sourceProjects.get(metadata.source_id));
    if (typeof metadata.fromFrame === 'string') add(frameProjects.get(metadata.fromFrame));
    return [row.id, [...ids].sort()];
  }));
}

/** 显式归属独立于帧寿命；保留原 metadata 字段，不移动或修改任何素材文件。 */
export function rememberMaterialProjects(database: Database, materialId: string, projectIds: string[]) {
  const row = database.query('SELECT id,metadata FROM materials WHERE id=?').get(materialId) as MaterialIdentity | null;
  if (!row) return;
  const metadata = metadataOf(row.metadata);
  const ids = new Set(Array.isArray(metadata.project_ids) ? metadata.project_ids.filter((id): id is string => typeof id === 'string') : []);
  for (const id of projectIds) if (database.query('SELECT 1 FROM projects WHERE id=?').get(id)) ids.add(id);
  if (!ids.size) return;
  const sorted = [...ids].sort();
  if (JSON.stringify(metadata.project_ids) === JSON.stringify(sorted)) return;
  database.query('UPDATE materials SET metadata=? WHERE id=?').run(JSON.stringify({ ...metadata, project_ids: sorted }), materialId);
}

/** 升级只补登记可证实的归属；同名项目、孤立素材和文件内容均保持不变。 */
export function backfillMaterialProjects(database: Database) {
  if (database.query("SELECT 1 FROM settings WHERE key='materialProjectPartitionsV1'").get()) return;
  database.transaction(() => {
    for (const [id, projects] of resolveMaterialProjects(database)) rememberMaterialProjects(database, id, projects);
    database.query("INSERT INTO settings(key,value,updated_at) VALUES('materialProjectPartitionsV1','true',?)").run(Date.now());
  })();
}
