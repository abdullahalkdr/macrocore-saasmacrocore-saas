import { useEffect, useState } from 'react';
import { get, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import PageHeader from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import Tag from '../components/Tag';
import ProjectModal, { Project } from '../components/ProjectModal';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

type TagColor = 'green' | 'red' | 'amber' | 'gray';

// Projects module (MIGRATION_052) — Settings > Setup > Projects. Same
// Table + Modal + ConfirmDialog shape as CostCentersPage.tsx.
const STATUS_COLORS: Record<string, TagColor> = {
  active: 'green',
  completed: 'gray',
  on_hold: 'amber',
  cancelled: 'red',
};

export default function ProjectsPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);

  const STATUS_LABELS: Record<string, string> = {
    active: t.projects.statusActive,
    completed: t.projects.statusCompleted,
    on_hold: t.projects.statusOnHold,
    cancelled: t.projects.statusCancelled,
  };

  const [items, setItems] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    get<{ projects: Project[] }>('/projects')
      .then((r) => setItems(r.projects))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.projects.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  function formatDate(d: string | null) {
    return d ? new Date(d).toLocaleDateString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '—';
  }

  async function handleDelete() {
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!id) return;
    setError(null);
    try {
      await del(`/projects/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.projects.deleteFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.projects.title} subtitle={t.projects.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.projects.count(items.length)}</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <IconPlus /> {t.projects.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.projects.code}</th>
                <th>{t.projects.name}</th>
                <th>{t.projects.costCenter}</th>
                <th>{t.projects.manager}</th>
                <th>{t.projects.startDate}</th>
                <th>{t.projects.endDate}</th>
                <th className="num">{t.projects.budget}</th>
                <th>{t.projects.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 700 }}>{p.code}</td>
                  <td>{p.name}</td>
                  <td>{p.cost_center_code ? `${p.cost_center_code} — ${p.cost_center_name}` : '—'}</td>
                  <td>{p.manager_name || '—'}</td>
                  <td>{formatDate(p.start_date)}</td>
                  <td>{formatDate(p.end_date)}</td>
                  <td className="num">{Number(p.budget).toFixed(3)} KD</td>
                  <td>
                    <Tag color={STATUS_COLORS[p.status] || 'gray'}>{STATUS_LABELS[p.status] || p.status}</Tag>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="icon-btn"
                      title={t.projects.edit}
                      onClick={() => {
                        setEditing(p);
                        setOpen(true);
                      }}
                    >
                      <IconEdit />
                    </button>
                    <button className="icon-btn" title={t.common.delete} onClick={() => setConfirmDeleteId(p.id)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div className="empty-state">{t.projects.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && <ProjectModal project={editing} onClose={() => setOpen(false)} onSaved={load} />}

      {confirmDeleteId && (
        <ConfirmDialog message={t.projects.deleteConfirm} onConfirm={handleDelete} onCancel={() => setConfirmDeleteId(null)} />
      )}
    </div>
  );
}
