import { Fragment, useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';
import Pagination from '../components/Pagination';
import { exportRowsToCsv } from '../utils/csv';

interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
  is_sensitive: boolean;
}

interface FieldChange {
  field_name: string;
  old_value: string | null;
  new_value: string | null;
}

// Pure presentation — turns 'employee_deleted' into 'employee deleted', no translation
// table needed for the dozens of distinct action strings scattered across controllers.
function humanize(s: string): string {
  return s.replace(/_/g, ' ');
}

const LIMIT = 25;

export default function AuditLogPage() {
  const t = useT();
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [changes, setChanges] = useState<FieldChange[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);

  function currentFilterParams() {
    const params = new URLSearchParams();
    if (actionFilter) params.set('action', actionFilter);
    if (entityFilter) params.set('entity_type', entityFilter);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (sensitiveOnly) params.set('sensitive_only', 'true');
    return params;
  }

  function load(pageToLoad: number) {
    const params = currentFilterParams();
    params.set('page', String(pageToLoad));
    params.set('limit', String(LIMIT));
    get<{ audit_logs: AuditLogEntry[]; actions: string[]; entity_types: string[]; total: number }>(
      `/audit-log?${params.toString()}`
    )
      .then((r) => {
        setItems(r.audit_logs);
        setActions(r.actions);
        setEntityTypes(r.entity_types);
        setTotal(r.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.auditLog.loadFailed));
  }

  // ?format=csv pulls every row matching the current filters (up to the backend's
  // export cap), not just the visible page — a plain page-slice export would silently
  // under-report a filtered date range with more than one page of results.
  function exportCsv() {
    setError(null);
    setNotice(null);
    setExportBusy(true);
    const params = currentFilterParams();
    params.set('format', 'csv');
    get<{ audit_logs: AuditLogEntry[]; total: number }>(`/audit-log?${params.toString()}`)
      .then((r) => {
        exportRowsToCsv(
          `activity-log_${dateFrom || 'all'}_${dateTo || 'all'}.csv`,
          [t.auditLog.when, t.auditLog.who, t.auditLog.action, t.auditLog.sensitive, t.auditLog.entityType, t.auditLog.ip],
          r.audit_logs.map((entry) => [
            new Date(entry.created_at).toLocaleString(),
            entry.user_name || entry.user_email || t.auditLog.systemUser,
            humanize(entry.action),
            entry.is_sensitive ? t.common.yes : t.common.no,
            humanize(entry.entity_type),
            entry.ip_address || '',
          ])
        );
        if (r.total > r.audit_logs.length) {
          setNotice(t.auditLog.exportTruncated(r.audit_logs.length, r.total));
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.auditLog.exportFailed))
      .finally(() => setExportBusy(false));
  }

  // Field-level detail (audit_log_field_changes, MIGRATION_067) only exists for the ~9
  // sensitive actions whose controllers were updated to pass old/new values into
  // logAudit() — an empty result here just means "nothing recorded," not an error.
  function toggleDetails(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setChanges([]);
    setChangesLoading(true);
    get<{ changes: FieldChange[] }>(`/audit-log/${id}/changes`)
      .then((r) => setChanges(r.changes))
      .catch(() => setChanges([]))
      .finally(() => setChangesLoading(false));
  }

  // Filter change resets to page 1 (a stale page number past the new, smaller result
  // set would otherwise render an empty page with no way back).
  useEffect(() => {
    setPage(1);
    load(1);
  }, [actionFilter, entityFilter, dateFrom, dateTo, sensitiveOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (page !== 1) load(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader title={t.auditLog.title} subtitle={t.auditLog.subtitle} />
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}

      <div className="card">
        <div className="form-row">
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.auditLog.entityType}</label>
            <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
              <option value="">{t.auditLog.allEntityTypes}</option>
              {entityTypes.map((et) => (
                <option key={et} value={et}>
                  {humanize(et)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 200 }}>
            <label>{t.auditLog.action}</label>
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
              <option value="">{t.auditLog.allActions}</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {humanize(a)}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 170 }}>
            <label>{t.auditLog.dateFrom}</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="field" style={{ maxWidth: 170 }}>
            <label>{t.auditLog.dateTo}</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginTop: 10 }}>
          <input
            type="checkbox"
            checked={sensitiveOnly}
            onChange={(e) => setSensitiveOnly(e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span style={{ fontSize: 13 }}>{t.auditLog.sensitiveOnly}</span>
        </label>
      </div>

      <div className="section-title-row">
        <span className="muted">{t.auditLog.count(total)}</span>
        <button className="btn btn-secondary btn-sm" onClick={exportCsv} disabled={exportBusy}>
          {t.auditLog.exportCsv}
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.auditLog.when}</th>
                <th>{t.auditLog.who}</th>
                <th>{t.auditLog.action}</th>
                <th>{t.auditLog.entityType}</th>
                <th>{t.auditLog.ip}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <Fragment key={entry.id}>
                <tr>
                  <td className="num">{new Date(entry.created_at).toLocaleString()}</td>
                  <td>{entry.user_name || entry.user_email || t.auditLog.systemUser}</td>
                  <td style={{ fontWeight: 700 }}>
                    {humanize(entry.action)}
                    {entry.is_sensitive && (
                      <>
                        <span className="badge sensitive" style={{ marginInlineStart: 8 }}>
                          {t.auditLog.sensitive}
                        </span>
                        <button
                          onClick={() => toggleDetails(entry.id)}
                          style={{
                            marginInlineStart: 8,
                            fontSize: 12,
                            fontWeight: 400,
                            background: 'none',
                            border: 'none',
                            color: 'var(--blue-700)',
                            textDecoration: 'underline',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                        >
                          {expandedId === entry.id ? t.auditLog.hideChanges : t.auditLog.viewChanges}
                        </button>
                      </>
                    )}
                  </td>
                  <td>{humanize(entry.entity_type)}</td>
                  <td className="num muted">{entry.ip_address || '—'}</td>
                </tr>
                {entry.is_sensitive && expandedId === entry.id && (
                  <tr>
                    <td colSpan={5} style={{ background: 'var(--stone-50)' }}>
                      {changesLoading ? (
                        <span className="muted">{t.common.loading}</span>
                      ) : changes.length === 0 ? (
                        <span className="muted">{t.auditLog.noChanges}</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {changes.map((c, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                              <span style={{ fontWeight: 600, minWidth: 140 }}>{humanize(c.field_name)}</span>
                              <span className="muted">{c.old_value ?? '—'}</span>
                              <span>→</span>
                              <span>{c.new_value ?? '—'}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.auditLog.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={page} limit={LIMIT} total={total} onChange={setPage} />
      </div>
    </div>
  );
}
