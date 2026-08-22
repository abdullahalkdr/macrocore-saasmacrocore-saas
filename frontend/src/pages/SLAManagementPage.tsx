import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { ApiError } from '../api/client';
import PageHeader from '../components/PageHeader';
import Tag from '../components/Tag';
import { useSLAStore, SLA_PRIORITIES, SLAPriority } from '../store/useSLAStore';

interface RowDraft {
  response_minutes: string;
  resolution_minutes: string;
  escalate_after_minutes: string;
  escalate_to_role: 'admin' | 'manager';
}

const EMPTY_ROW: RowDraft = { response_minutes: '', resolution_minutes: '', escalate_after_minutes: '', escalate_to_role: 'admin' };

export default function SLAManagementPage() {
  const t = useT();
  const policies = useSLAStore((s) => s.policies);
  const fetchPolicies = useSLAStore((s) => s.fetchPolicies);
  const upsertPolicy = useSLAStore((s) => s.upsertPolicy);

  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<SLAPriority, RowDraft>>({
    low: EMPTY_ROW,
    medium: EMPTY_ROW,
    high: EMPTY_ROW,
    urgent: EMPTY_ROW,
  });
  const [savingPriority, setSavingPriority] = useState<SLAPriority | null>(null);
  const [savedPriority, setSavedPriority] = useState<SLAPriority | null>(null);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  useEffect(() => {
    setDrafts((d) => {
      const next = { ...d };
      for (const p of policies) {
        next[p.priority] = {
          response_minutes: String(p.response_minutes),
          resolution_minutes: String(p.resolution_minutes),
          escalate_after_minutes: p.escalate_after_minutes !== null ? String(p.escalate_after_minutes) : '',
          escalate_to_role: p.escalate_to_role === 'manager' ? 'manager' : 'admin',
        };
      }
      return next;
    });
  }, [policies]);

  function priorityLabel(p: SLAPriority) {
    return p === 'low' ? t.sla.priorityLow : p === 'medium' ? t.sla.priorityMedium : p === 'high' ? t.sla.priorityHigh : t.sla.priorityUrgent;
  }

  function patchDraft(p: SLAPriority, patch: Partial<RowDraft>) {
    setDrafts((d) => ({ ...d, [p]: { ...d[p], ...patch } }));
  }

  async function handleSave(p: SLAPriority) {
    const draft = drafts[p];
    if (!draft.response_minutes || !draft.resolution_minutes) return;
    setSavingPriority(p);
    setError(null);
    setSavedPriority(null);
    try {
      await upsertPolicy(p, {
        response_minutes: Number(draft.response_minutes),
        resolution_minutes: Number(draft.resolution_minutes),
        escalate_after_minutes: draft.escalate_after_minutes ? Number(draft.escalate_after_minutes) : null,
        escalate_to_role: draft.escalate_to_role,
      });
      setSavedPriority(p);
      setTimeout(() => setSavedPriority((cur) => (cur === p ? null : cur)), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.sla.saveFailed);
    } finally {
      setSavingPriority(null);
    }
  }

  const configured = new Set(policies.map((p) => p.priority));

  return (
    <div>
      <PageHeader title={t.sla.title} subtitle={t.sla.subtitle} />
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>{t.sla.responseMinutes}</th>
                <th>{t.sla.resolutionMinutes}</th>
                <th>{t.sla.escalateAfterMinutes}</th>
                <th>{t.sla.escalateToRole}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {SLA_PRIORITIES.map((p) => (
                <tr key={p}>
                  <td style={{ fontWeight: 700 }}>
                    {priorityLabel(p)}
                    {!configured.has(p) && (
                      <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                        {t.sla.notConfigured}
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      className="num"
                      style={{ width: 100 }}
                      value={drafts[p].response_minutes}
                      onChange={(e) => patchDraft(p, { response_minutes: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      className="num"
                      style={{ width: 100 }}
                      value={drafts[p].resolution_minutes}
                      onChange={(e) => patchDraft(p, { resolution_minutes: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      className="num"
                      style={{ width: 100 }}
                      value={drafts[p].escalate_after_minutes}
                      onChange={(e) => patchDraft(p, { escalate_after_minutes: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={drafts[p].escalate_to_role}
                      onChange={(e) => patchDraft(p, { escalate_to_role: e.target.value as 'admin' | 'manager' })}
                    >
                      <option value="admin">{t.sla.roleAdmin}</option>
                      <option value="manager">{t.sla.roleManager}</option>
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={() => handleSave(p)}
                      disabled={savingPriority === p}
                    >
                      {savingPriority === p ? t.common.loading : t.common.save}
                    </button>{' '}
                    {savedPriority === p && <Tag color="green">{t.sla.saved}</Tag>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
