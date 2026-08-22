import { FormEvent, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useAuthStore } from '../store/authStore';
import { ApiError } from '../api/client';
import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import PolicyDetailsModal from '../components/PolicyDetailsModal';
import { IconPlus } from '../components/Icon';
import {
  usePolicyStore,
  Policy,
  PolicyStatus,
  SystemModule,
  SYSTEM_MODULES,
} from '../store/usePolicyStore';

// Only the 3 tabs the spec asked for (Drafts / In Review / Approved) — 'archived'
// policies stay reachable by direct id (PolicyDetailsModal) without a 4th tab nobody
// asked for. Easy to add later if it turns out people want to browse the archive.
type Tab = 'draft' | 'in_review' | 'approved';
const TABS: Tab[] = ['draft', 'in_review', 'approved'];

const EMPTY_FORM = { name: '', name_en: '', content: '', content_en: '', module_linked: '' as SystemModule | '' };

export default function PoliciesPage() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const user = useAuthStore((s) => s.user);
  const isManager = user?.role === 'admin' || user?.role === 'manager';

  const policies = usePolicyStore((s) => s.policies);
  const loading = usePolicyStore((s) => s.loading);
  const storeError = usePolicyStore((s) => s.error);
  const fetchPolicies = usePolicyStore((s) => s.fetchPolicies);
  const createPolicy = usePolicyStore((s) => s.createPolicy);
  const updateStatus = usePolicyStore((s) => s.updateStatus);
  const approvePolicy = usePolicyStore((s) => s.approvePolicy);

  // Employees only ever see 'approved' rows anyway (enforced server-side in
  // policies.controller.ts's list()) — no point showing them Drafts/In Review tabs
  // that would always render empty.
  const [tab, setTab] = useState<Tab>(isManager ? 'draft' : 'approved');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  function displayName(p: Pick<Policy, 'name' | 'name_en'>) {
    return (lang === 'en' && p.name_en) || p.name;
  }

  const MODULE_LABELS: Record<SystemModule, string> = {
    pos_shifts: t.policies.modulePosShifts,
    expenses_waste: t.policies.moduleExpensesWaste,
    inventory_supply_chain: t.policies.moduleInventorySupplyChain,
    hr_payroll: t.policies.moduleHrPayroll,
    reports: t.policies.moduleReports,
    health_safety: t.policies.moduleHealthSafety,
    data_privacy: t.policies.moduleDataPrivacy,
    customer_service: t.policies.moduleCustomerService,
    code_of_conduct: t.policies.moduleCodeOfConduct,
    other: t.policies.moduleOther,
  };

  function statusBadge(status: PolicyStatus) {
    if (status === 'draft') return <span className="badge draft">{t.policies.statusDraft}</span>;
    if (status === 'in_review') return <span className="badge trial">{t.policies.statusInReview}</span>;
    if (status === 'approved') return <span className="badge open">{t.policies.statusApproved}</span>;
    return <span className="badge closed">{t.policies.statusArchived}</span>;
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreateOpen(true);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.content.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      await createPolicy({
        name: form.name.trim(),
        name_en: form.name_en.trim() || undefined,
        content: form.content.trim(),
        content_en: form.content_en.trim() || undefined,
        module_linked: form.module_linked || null,
      });
      setCreateOpen(false);
      setTab('draft');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t.policies.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleTransition(id: string, status: PolicyStatus) {
    setActingId(id);
    setActionError(null);
    try {
      if (status === 'approved') await approvePolicy(id);
      else await updateStatus(id, status);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t.policies.statusUpdateFailed);
    } finally {
      setActingId(null);
    }
  }

  const rows = policies.filter((p) => p.status === tab);

  return (
    <div>
      <PageHeader title={t.policies.title} subtitle={t.policies.subtitle} />
      {(storeError || actionError) && <div className="error-banner">{actionError || storeError}</div>}

      {isManager && (
        <div className="section-title-row">
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <IconPlus /> {t.policies.newPolicy}
          </button>
        </div>
      )}

      {isManager && (
        <div className="tabs">
          {TABS.map((tb) => (
            <button key={tb} className={`tab-btn${tab === tb ? ' active' : ''}`} onClick={() => setTab(tb)}>
              {tb === 'draft' ? t.policies.tabDrafts : tb === 'in_review' ? t.policies.tabInReview : t.policies.tabApproved}
            </button>
          ))}
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.policies.nameLabel}</th>
                <th>{t.policies.moduleLabel}</th>
                <th>{t.policies.status}</th>
                <th>{t.policies.version}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 700, cursor: 'pointer' }} onClick={() => setDetailsId(p.id)}>
                    {displayName(p)}
                  </td>
                  <td>{p.module_linked ? MODULE_LABELS[p.module_linked] : '—'}</td>
                  <td>{statusBadge(p.status)}</td>
                  <td>v{p.version}</td>
                  <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setDetailsId(p.id)}>
                      {t.policies.viewDetails}
                    </button>
                    {isManager && p.status === 'draft' && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={actingId === p.id}
                        onClick={() => handleTransition(p.id, 'in_review')}
                      >
                        {t.policies.submitForReview}
                      </button>
                    )}
                    {isManager && p.status === 'in_review' && (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={actingId === p.id}
                          onClick={() => handleTransition(p.id, 'approved')}
                        >
                          {t.policies.approve}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={actingId === p.id}
                          onClick={() => handleTransition(p.id, 'draft')}
                        >
                          {t.policies.sendBackToDraft}
                        </button>
                      </>
                    )}
                    {isManager && p.status === 'approved' && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={actingId === p.id}
                        onClick={() => handleTransition(p.id, 'archived')}
                      >
                        {t.policies.archive}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">{t.policies.empty}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {createOpen && (
        <Modal
          title={t.policies.createTitle}
          onClose={() => setCreateOpen(false)}
          actions={(requestClose) => (
            <>
              <button className="btn btn-primary" type="submit" form="policy-create-form" disabled={saving}>
                {saving ? t.common.loading : t.common.save}
              </button>
              <button className="btn btn-secondary" type="button" onClick={requestClose}>
                {t.common.cancel}
              </button>
            </>
          )}
        >
          <form id="policy-create-form" onSubmit={handleCreate} className="field-grid">
            {formError && (
              <div className="error-banner" style={{ gridColumn: '1 / -1' }}>
                {formError}
              </div>
            )}
            <div className="field">
              <label>{t.policies.nameLabel}</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="field">
              <label>{t.policies.nameEnLabel}</label>
              <input value={form.name_en} onChange={(e) => setForm((f) => ({ ...f, name_en: e.target.value }))} />
            </div>
            <div className="field">
              <label>{t.policies.moduleLabel}</label>
              <select
                value={form.module_linked}
                onChange={(e) => setForm((f) => ({ ...f, module_linked: e.target.value as SystemModule | '' }))}
              >
                <option value="">{t.policies.moduleNone}</option>
                {SYSTEM_MODULES.map((m) => (
                  <option key={m} value={m}>
                    {MODULE_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.policies.contentLabel}</label>
              <textarea rows={8} value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} required />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t.policies.contentEnLabel}</label>
              <textarea rows={8} value={form.content_en} onChange={(e) => setForm((f) => ({ ...f, content_en: e.target.value }))} />
            </div>
          </form>
        </Modal>
      )}

      {detailsId && <PolicyDetailsModal policyId={detailsId} onClose={() => setDetailsId(null)} />}
    </div>
  );
}
