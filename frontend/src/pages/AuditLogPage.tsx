import { useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { useT } from '../i18n';
import PageHeader from '../components/PageHeader';

interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

// Pure presentation — turns 'employee_deleted' into 'employee deleted', no translation
// table needed for the dozens of distinct action strings scattered across controllers.
function humanize(s: string): string {
  return s.replace(/_/g, ' ');
}

export default function AuditLogPage() {
  const t = useT();
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  function load() {
    const params = new URLSearchParams();
    if (actionFilter) params.set('action', actionFilter);
    if (entityFilter) params.set('entity_type', entityFilter);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    const qs = params.toString();
    get<{ audit_logs: AuditLogEntry[]; actions: string[]; entity_types: string[] }>(`/audit-log${qs ? `?${qs}` : ''}`)
      .then((r) => {
        setItems(r.audit_logs);
        setActions(r.actions);
        setEntityTypes(r.entity_types);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t.auditLog.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [actionFilter, entityFilter, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <PageHeader title={t.auditLog.title} subtitle={t.auditLog.subtitle} />
      {error && <div className="error-banner">{error}</div>}

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
      </div>

      <div className="section-title-row">
        <span className="muted">{t.auditLog.count(items.length)}</span>
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
                <tr key={entry.id}>
                  <td className="num">{new Date(entry.created_at).toLocaleString()}</td>
                  <td>{entry.user_name || entry.user_email || t.auditLog.systemUser}</td>
                  <td style={{ fontWeight: 700 }}>{humanize(entry.action)}</td>
                  <td>{humanize(entry.entity_type)}</td>
                  <td className="num muted">{entry.ip_address || '—'}</td>
                </tr>
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
      </div>
    </div>
  );
}
