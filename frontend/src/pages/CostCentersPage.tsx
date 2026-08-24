import { useEffect, useState } from 'react';
import { get, del, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import ConfirmDialog from '../components/ConfirmDialog';
import Tag from '../components/Tag';
import CostCenterModal, { CostCenter } from '../components/CostCenterModal';
import { IconPlus, IconEdit, IconTrash } from '../components/Icon';

// Cost Centers module (MIGRATION_051) — Settings > Setup > Cost centers.
// Table + Modal + ConfirmDialog shape follows LocationsPage.tsx/LocationModal.tsx
// and DepartmentsPage.tsx exactly: custom <Modal> for create/edit, custom
// <ConfirmDialog> for delete (not the native window.confirm() LocationsPage.tsx
// still uses — this module is built after the "replace native browser alerts"
// UI/UX polish pass, so it goes straight to the ConfirmDialog pattern).
export default function CostCentersPage() {
  const t = useT();

  const [items, setItems] = useState<CostCenter[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CostCenter | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    get<{ costCenters: CostCenter[] }>('/cost-centers')
      .then((r) => setItems(r.costCenters))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.costCenters.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete() {
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!id) return;
    setError(null);
    try {
      await del(`/cost-centers/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.costCenters.deleteFailed);
    }
  }

  return (
    <div>
      <PageHeader title={t.costCenters.title} subtitle={t.costCenters.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="section-title-row">
        <span className="muted">{t.costCenters.count(items.length)}</span>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <IconPlus /> {t.costCenters.newItem}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.costCenters.code}</th>
                <th>{t.costCenters.name}</th>
                <th>{t.costCenters.manager}</th>
                <th>{t.costCenters.status}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((cc) => (
                <tr key={cc.id}>
                  <td style={{ fontWeight: 700 }}>{cc.code}</td>
                  <td>{cc.name}</td>
                  <td>{cc.manager_name || '—'}</td>
                  <td>
                    <Tag color={cc.status === 'active' ? 'green' : 'gray'}>
                      {cc.status === 'active' ? t.common.active : t.common.inactive}
                    </Tag>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="icon-btn"
                      title={t.costCenters.edit}
                      onClick={() => {
                        setEditing(cc);
                        setOpen(true);
                      }}
                    >
                      <IconEdit />
                    </button>
                    <button className="icon-btn" title={t.common.delete} onClick={() => setConfirmDeleteId(cc.id)}>
                      <IconTrash />
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.costCenters.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {open && <CostCenterModal costCenter={editing} onClose={() => setOpen(false)} onSaved={load} />}

      {confirmDeleteId && (
        <ConfirmDialog message={t.costCenters.deleteConfirm} onConfirm={handleDelete} onCancel={() => setConfirmDeleteId(null)} />
      )}
    </div>
  );
}
