import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Film, FolderOpen, Image, Library, PackageOpen } from 'lucide-react';
import type { Material, Project } from '../api';
import { useT } from '../i18n';
import './materialLibrary.css';

export type MaterialPartition =
  | { scope: 'all' }
  | { scope: 'project'; projectId: string; kind?: 'video' | 'image' }
  | { scope: 'unassigned'; kind?: 'video' | 'image' }
  | { scope: 'folder'; folderId: string };

interface Props {
  projects: Project[];
  materials: Material[];
  selected: MaterialPartition;
  onSelect: (selection: MaterialPartition) => void;
}

/** 项目分区是素材关联的视图，保留独立素材和用户已有文件夹。 */
export default function MaterialProjectTree({ projects, materials, selected, onSelect }: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const counts = useMemo(() => {
    const grouped = new Map<string, { all: number; video: number; image: number }>();
    for (const p of projects) grouped.set(p.id, { all: 0, video: 0, image: 0 });
    const unassigned = { all: 0, video: 0, image: 0 };
    for (const material of materials) {
      const ids = (material.project_ids ?? []).filter(id => grouped.has(id));
      if (!ids.length) { unassigned.all++; unassigned[material.kind]++; }
      for (const id of ids) { const count = grouped.get(id)!; count.all++; count[material.kind]++; }
    }
    return { grouped, unassigned };
  }, [projects, materials]);
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const group = (project: Project | null) => {
    const id = project?.id ?? 'unassigned';
    const name = project?.name ?? t('library.unassigned');
    const count = project ? counts.grouped.get(project.id)! : counts.unassigned;
    const active = project ? selected.scope === 'project' && selected.projectId === project.id : selected.scope === 'unassigned';
    const open = !collapsed.has(id);
    const choose = (kind?: 'video' | 'image') => onSelect(project ? { scope: 'project', projectId: project.id, kind } : { scope: 'unassigned', kind });
    return <div className="material-project-group" key={id}>
      <div className="material-project-heading">
        <button type="button" className="material-project-toggle" aria-expanded={open} aria-label={t(open ? 'library.collapseProject' : 'library.expandProject', { name })} onClick={() => toggle(id)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button type="button" className={`material-partition-row ${active && !('kind' in selected && selected.kind) ? 'on' : ''}`} data-scope={project ? 'project' : 'unassigned'} data-project-id={project?.id} data-kind="all" aria-current={active && !('kind' in selected && selected.kind) ? 'true' : undefined} title={name} onClick={() => choose()}>
          {project ? <FolderOpen size={16} /> : <PackageOpen size={16} />}<span>{name}</span><small>{count.all}</small>
        </button>
      </div>
      {open && <div className="material-project-children">
        {(['video', 'image'] as const).map(kind => <button key={kind} type="button" className={`material-partition-row ${active && 'kind' in selected && selected.kind === kind ? 'on' : ''}`} data-scope={project ? 'project' : 'unassigned'} data-project-id={project?.id} data-kind={kind} aria-current={active && 'kind' in selected && selected.kind === kind ? 'true' : undefined} onClick={() => choose(kind)}>
          {kind === 'video' ? <Film size={15} /> : <Image size={15} />}<span>{t(kind === 'video' ? 'library.videos' : 'library.photos')}</span><small>{count[kind]}</small>
        </button>)}
      </div>}
    </div>;
  };
  return <nav className="material-project-tree" data-testid="material-project-tree" aria-label={t('library.byProject')}>
    <h2>{t('library.byProject')}</h2>
    <button type="button" className={`material-partition-row ${selected.scope === 'all' ? 'on' : ''}`} data-scope="all" aria-current={selected.scope === 'all' ? 'true' : undefined} onClick={() => onSelect({ scope: 'all' })}>
      <Library size={16} /><span>{t('library.all')}</span><small>{materials.length}</small>
    </button>
    {projects.map(project => group(project))}
    {group(null)}
  </nav>;
}
