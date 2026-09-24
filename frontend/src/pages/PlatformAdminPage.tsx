import { Fragment, FormEvent, useEffect, useState } from 'react';
import { IconBuilding } from '../components/Icon';
import {
  ACTIVATABLE_PLAN_VALUES,
  adminFetch,
  allowedLegacyPlanOptions,
  canActivateSubscription,
  defaultActivationForm,
  nextActivationForm,
  submitActivation,
  subscriptionStatusLabel,
  invoiceStatusLabel,
  canIssueInvoice,
  type ActivationForm,
} from './platformAdminHelpers';

// macrocore's own cross-tenant dashboard — NOT part of any company's account. Auth
// is a single shared secret (X-Admin-Key, see backend/.env ADMIN_API_KEY), matching
// backend/src/middleware/requireAdminKey.ts. That file's own comment says it best:
// swap for real platform-admin accounts once there's more than one person on the
// macrocore side using this. Until a payment gateway is wired up, the "Activate
// Subscription…" form below (POST .../subscription/activate,
// admin.controller.ts's
// activateSubscription) is the only way to turn a signup into a real, invoiceable
// paying account — see the 2026-09-15 decision note on saveCompany()/updateCompany()
// below for why the older plan <select> + Save can no longer do this by itself.
const ADMIN_KEY_STORAGE = 'macrocore-admin-key';

const STATUS_VALUES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];

interface CompanyUser {
  email: string;
  full_name: string | null;
  role: string;
  status: string;
}
interface Company {
  id: string;
  name: string;
  industry: string | null;
  country: string | null;
  employee_count_range: string | null;
  plan: string;
  subscription_status: string;
  trial_start_date: string | null;
  trial_end_date: string | null;
  created_at: string;
  users: CompanyUser[];
}
interface Subscription {
  id: string;
  company_id: string;
  company_name: string;
  plan: string;
  status: string;
  // Stage B2: a subscription row now records its own currency/period_amount/
  // billing_interval — see claude/chat4a-b2-subscription-billing-foundation-
  // proposal-2026-09-15.md. `monthly_price` remains a rounded MRR-reporting
  // derivative only — never render it as "the price" without the row's own
  // `currency`, and never as the exact agreed charge; `period_amount` is
  // that. These stay optional so a nullable compatibility migration remains
  // readable if a different environment contains legacy rows.
  currency?: string;
  period_amount?: number;
  billing_interval?: string;
  monthly_price: number | null;
  auto_renew: boolean;
  next_billing_date: string | null;
  created_at: string;
}
interface Invoice {
  id: string;
  // Stage B3: every issued invoice now carries its own immutable commercial
  // snapshot — see claude/chat4a-b3-subscription-invoice-foundation-
  // proposal-2026-09-15.md. `currency` here is that invoice's OWN recorded
  // currency (copied from its subscription at issue time), never assumed —
  // this is what replaces the previous hardcoded "KD" render below.
  invoice_number: string;
  company_id: string;
  company_name: string;
  subscription_id: string;
  plan: string;
  billing_interval: string;
  currency: string;
  amount: number;
  status: string;
  period_start: string;
  period_end: string;
  issue_date: string;
  due_date: string | null;
  payment_date: string | null;
}
interface Stats {
  total_companies: number;
  by_plan_and_status: { plan: string; subscription_status: string; n: number }[];
  // Stage B2: MRR is reported per currency and never summed across them — a
  // mixed-currency sum is not a meaningful number.
  mrr_by_currency: { currency: string | null; mrr: number }[];
}

export default function PlatformAdminPage() {
  const [key, setKey] = useState<string>(() => localStorage.getItem(ADMIN_KEY_STORAGE) || '');
  const [keyInput, setKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [edits, setEdits] = useState<Record<string, { plan: string; subscription_status: string; trial_end_date: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [issuingCompanyId, setIssuingCompanyId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activationForm, setActivationForm] = useState<ActivationForm>(defaultActivationForm);
  const [activationSubmitting, setActivationSubmitting] = useState(false);

  function load(activeKey: string) {
    setLoading(true);
    setError(null);
    Promise.all([
      adminFetch<{ success: boolean } & Stats>('/admin/stats', activeKey),
      adminFetch<{ success: boolean; companies: Company[] }>('/admin/companies', activeKey),
      adminFetch<{ success: boolean; subscriptions: Subscription[] }>('/admin/subscriptions', activeKey),
      adminFetch<{ success: boolean; invoices: Invoice[] }>('/admin/invoices', activeKey),
    ])
      .then(([s, c, sub, inv]) => {
        setStats(s);
        setCompanies(c.companies);
        setSubscriptions(sub.subscriptions);
        setInvoices(inv.invoices);
        setEdits(
          Object.fromEntries(
            c.companies.map((co) => [
              co.id,
              { plan: co.plan, subscription_status: co.subscription_status, trial_end_date: co.trial_end_date ? co.trial_end_date.slice(0, 10) : '' },
            ])
          )
        );
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load');
        if (String(err).includes('401') || String(err).toLowerCase().includes('invalid admin key')) {
          localStorage.removeItem(ADMIN_KEY_STORAGE);
          setKey('');
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (key) load(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function handleKeySubmit(e: FormEvent) {
    e.preventDefault();
    if (!keyInput.trim()) return;
    localStorage.setItem(ADMIN_KEY_STORAGE, keyInput.trim());
    setKey(keyInput.trim());
  }

  async function saveCompany(id: string) {
    const edit = edits[id];
    if (!edit) return;
    setSavingId(id);
    setError(null);
    try {
      await adminFetch(`/admin/companies/${id}`, key, {
        method: 'PATCH',
        body: JSON.stringify({
          plan: edit.plan,
          subscription_status: edit.subscription_status,
          trial_end_date: edit.trial_end_date ? new Date(edit.trial_end_date).toISOString() : null,
        }),
      });
      load(key);
    } catch (err) {
      // A managed company (one with a live subscriptions row) rejects a real
      // plan change through this endpoint with a 409 — see admin.controller.ts's
      // updateCompany() guard. Since Abdullah's 2026-09-15 decision, this
      // endpoint also rejects moving ANY company to a paid plan
      // (bronze/silver/gold/enterprise) at all — a real paid grant must go
      // through the "Activate Subscription…" form below, which creates the
      // subscriptions row invoicing/MRR/billing-emails depend on. adminFetch()
      // already surfaces the server's error message as-is, so this existing
      // catch block needs no special-casing either way. Changing
      // subscription_status alone (suspend/cancel/reactivate), moving a plan
      // to 'trial', or re-saving the current plan unchanged are never blocked
      // and keep working exactly as before.
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingId(null);
    }
  }

  // Stage B2's real activation path — the only one that creates a
  // subscriptions row (see admin.controller.ts's activateSubscription). Added
  // 2026-09-15 alongside the updateCompany() paid-plan guard above, since this
  // page previously had no UI for it at all — an admin had to call the API
  // directly.
  function openActivation(c: Company) {
    setError(null);
    setActivatingId(c.id);
    setActivationForm(defaultActivationForm());
  }

  // For bronze/silver/gold the amount MUST exactly match the server's
  // approved catalog (activateSubscription rejects anything else, see
  // subscriptionLifecycle.ts's resolvePeriodAmount) — so it's kept read-only
  // and auto-filled here rather than freely editable. Enterprise has no list
  // price (manually quoted, annual-only — the same rule the backend enforces).
  function setActivationField(patch: Partial<{ plan: string; billing_interval: 'monthly' | 'annual' }>) {
    setActivationForm((prev) => nextActivationForm(prev, patch));
  }

  async function activateCompanySubscription(id: string) {
    setActivationSubmitting(true);
    setError(null);
    try {
      await submitActivation(id, key, activationForm, {
        onSuccess: () => {
          setActivatingId(null);
          load(key);
        },
        onError: setError,
      });
    } finally {
      setActivationSubmitting(false);
    }
  }

  // Stage B3 — triggers POST /admin/companies/:id/subscription/invoices with
  // an empty body (the endpoint accepts no commercial values from the
  // caller; everything is copied from the company's own active subscription
  // — see admin.controller.ts's createSubscriptionInvoice). A 409 here means
  // either "no active commercial subscription" or "already invoiced this
  // period" — both surfaced via adminFetch()'s existing error message
  // passthrough, same as saveCompany's own error handling above.
  async function issueInvoice(companyId: string) {
    setIssuingCompanyId(companyId);
    setError(null);
    try {
      await adminFetch(`/admin/companies/${companyId}/subscription/invoices`, key, { method: 'POST' });
      load(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue invoice');
    } finally {
      setIssuingCompanyId(null);
    }
  }

  function extendTrial(id: string, days: number) {
    const current = edits[id]?.trial_end_date;
    const base = current ? new Date(current) : new Date();
    base.setDate(base.getDate() + days);
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], trial_end_date: base.toISOString().slice(0, 10) } }));
  }

  if (!key) {
    return (
      <div className="auth-page">
        <div className="auth-box">
          <div style={{ textAlign: 'center', marginBottom: 22 }}>
            <div
              style={{
                width: 56,
                height: 56,
                background: 'var(--stone-800, #292524)',
                borderRadius: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 12px',
                color: '#fff',
              }}
            >
              <IconBuilding size={26} />
            </div>
            <h1 style={{ marginBottom: 2 }}>macrocore — platform admin</h1>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Cross-tenant dashboard — not a company account.</div>
          </div>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={handleKeySubmit}>
            <div className="field">
              <label>Admin key</label>
              <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} autoFocus required />
            </div>
            <button className="btn btn-primary" type="submit" style={{ width: '100%' }}>
              Enter
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="platform-admin-page">
      <div className="section-title-row">
        <h1 style={{ margin: 0 }}>macrocore — platform admin</h1>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => {
            localStorage.removeItem(ADMIN_KEY_STORAGE);
            setKey('');
          }}
        >
          Lock
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && !stats && <p className="muted">Loading…</p>}

      {stats && (
        <div className="stat-grid" style={{ marginBottom: 20 }}>
          <div className="stat-card blue">
            <div className="stat-label">Total companies</div>
            <div className="stat-value">{stats.total_companies}</div>
          </div>
          {/* Stage B2: one card per currency that actually has an active
              subscription — never summed across currencies (a mixed-currency
              total is not a meaningful number). */}
          {stats.mrr_by_currency.length === 0 && (
            <div className="stat-card green">
              <div className="stat-label">MRR</div>
              <div className="stat-value" style={{ fontSize: 14 }}>
                No active subscriptions yet
              </div>
            </div>
          )}
          {stats.mrr_by_currency.map((row) => (
            <div className="stat-card green" key={row.currency || 'unknown-currency'}>
              <div className="stat-label">MRR ({row.currency || 'unknown currency'})</div>
              <div className="stat-value">{row.mrr.toFixed(3)}</div>
            </div>
          ))}
          {stats.by_plan_and_status.map((row, i) => (
            <div className="stat-card" key={i}>
              <div className="stat-label">
                {row.plan} / {row.subscription_status}
              </div>
              <div className="stat-value">{row.n}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card platform-companies-card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Companies ({companies.length})</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table platform-companies-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Users</th>
                <th>Industry</th>
                <th>Country</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Trial end</th>
                <th>Signed up</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => {
                const edit = edits[c.id] || { plan: c.plan, subscription_status: c.subscription_status, trial_end_date: '' };
                const activationAllowed = canActivateSubscription(c.id, subscriptions);
                return (
                  <Fragment key={c.id}>
                  <tr>
                    <td style={{ fontWeight: 700 }}>{c.name}</td>
                    <td className="platform-company-users">
                      {c.users.length === 0 && <span className="muted">—</span>}
                      {c.users.map((u, i) => (
                        <div key={i}>
                          {u.email}
                          <span className="muted"> ({u.role}{u.status !== 'active' ? `, ${u.status}` : ''})</span>
                        </div>
                      ))}
                    </td>
                    <td>{c.industry || '—'}</td>
                    <td>{c.country || '—'}</td>
                    <td>
                      {/* Restricted to the company's current plan (re-save, no-op)
                          plus 'trial' (a downgrade/reset) — a real paid plan can
                          only be granted via "Activate Subscription…" below, which
                          the server-side guard in updateCompany() also enforces. */}
                      <select
                        value={edit.plan}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: { ...edit, plan: e.target.value } }))}
                      >
                        {allowedLegacyPlanOptions(c.plan).map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={edit.subscription_status}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: { ...edit, subscription_status: e.target.value } }))}
                      >
                        {STATUS_VALUES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <input
                        className="platform-trial-date"
                        type="date"
                        value={edit.trial_end_date}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: { ...edit, trial_end_date: e.target.value } }))}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => extendTrial(c.id, 7)}>
                          +7d
                        </button>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => extendTrial(c.id, 30)}>
                          +30d
                        </button>
                      </div>
                    </td>
                    <td>{new Date(c.created_at).toLocaleDateString('en-GB')}</td>
                    <td>
                      <div className="platform-company-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => saveCompany(c.id)} disabled={savingId === c.id}>
                          {savingId === c.id ? '…' : 'Save'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          disabled={!activationAllowed}
                          title={activationAllowed ? undefined : 'Plan changes are not available here; this company already has a live subscription.'}
                          onClick={() => (activatingId === c.id ? setActivatingId(null) : openActivation(c))}
                        >
                          {!activationAllowed ? 'Subscription active' : activatingId === c.id ? 'Cancel' : 'Activate Subscription…'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {activationAllowed && activatingId === c.id && (
                  <tr>
                    <td colSpan={9}>
                      {/* Stage B2's real activation form — creates the subscriptions
                          row invoicing/MRR/billing-emails depend on. See
                          activateCompanySubscription() above and
                          admin.controller.ts's activateSubscription. */}
                      <div className="platform-activation-form">
                        <div className="platform-activation-field">
                          <label>Plan</label>
                          <select value={activationForm.plan} onChange={(e) => setActivationField({ plan: e.target.value })}>
                            {ACTIVATABLE_PLAN_VALUES.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="platform-activation-field">
                          <label>Billing interval</label>
                          <select
                            value={activationForm.billing_interval}
                            disabled={activationForm.plan === 'enterprise'}
                            onChange={(e) => setActivationField({ billing_interval: e.target.value as 'monthly' | 'annual' })}
                          >
                            <option value="monthly">monthly</option>
                            <option value="annual">annual</option>
                          </select>
                        </div>
                        <div className="platform-activation-field">
                          <label>Currency</label>
                          <input value="USD" disabled />
                        </div>
                        <div className="platform-activation-field">
                          <label>
                            Period amount {activationForm.plan !== 'enterprise' && '(catalog price, fixed)'}
                          </label>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={activationForm.period_amount}
                            disabled={activationForm.plan !== 'enterprise'}
                            onChange={(e) => setActivationForm((prev) => ({ ...prev, period_amount: e.target.value }))}
                          />
                        </div>
                        <button
                          className="btn btn-primary btn-sm"
                          type="button"
                          onClick={() => activateCompanySubscription(c.id)}
                          disabled={
                            activationSubmitting ||
                            !Number.isFinite(Number(activationForm.period_amount)) ||
                            Number(activationForm.period_amount) <= 0
                          }
                        >
                          {activationSubmitting ? '…' : 'Confirm activation'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  )}
                  </Fragment>
                );
              })}
              {companies.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div className="empty-state">No companies yet.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Subscriptions ({subscriptions.length})</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Plan</th>
                <th>Status</th>
                <th className="num">Price / cycle</th>
                <th>Interval</th>
                <th>Auto-renew</th>
                <th>Next billing</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 700 }}>{s.company_name}</td>
                  <td>{s.plan}</td>
                  <td>{subscriptionStatusLabel(s.status)}</td>
                  {/* Stage B2: shows the row's OWN currency and its actual
                      period_amount (the real agreed charge) — never a
                      hardcoded "KD" label, and never monthly_price presented
                      as the charge (it's a rounded MRR-reporting derivative
                      only — see B2 proposal §3.4). Falls back to the older
                      monthly_price shape for any row that predates these
                      fields (kept defensive for legacy rows). */}
                  <td className="num">
                    {s.period_amount !== undefined && s.currency
                      ? `${Number(s.period_amount).toFixed(3)} ${s.currency}`
                      : s.monthly_price !== null
                      ? `${Number(s.monthly_price).toFixed(3)} (currency unknown)`
                      : '—'}
                  </td>
                  <td>{s.billing_interval || '—'}</td>
                  <td>{s.auto_renew ? 'Yes' : 'No'}</td>
                  <td>{s.next_billing_date ? new Date(s.next_billing_date).toLocaleDateString('en-GB') : '—'}</td>
                  <td>
                    {/* Stage B3 — only a commercially `active` subscription is
                        eligible for invoicing (see admin.controller.ts's
                        createSubscriptionInvoice); tenant access status is
                        irrelevant here and deliberately not checked. No
                        fields are submitted — the endpoint copies everything
                        from this subscription's own row server-side. */}
                    {canIssueInvoice(s.status) ? (
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        onClick={() => issueInvoice(s.company_id)}
                        disabled={issuingCompanyId === s.company_id}
                      >
                        {issuingCompanyId === s.company_id ? '…' : 'Issue invoice'}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {subscriptions.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">No subscriptions yet.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Invoices ({invoices.length})</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Company</th>
                <th>Plan</th>
                <th>Interval</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Period</th>
                <th>Issued</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{inv.invoice_number}</td>
                  <td>{inv.company_name}</td>
                  <td>{inv.plan}</td>
                  <td>{inv.billing_interval}</td>
                  {/* Stage B3: shows this invoice's OWN recorded currency —
                      never a hardcoded "KD" — mirroring the exact pattern
                      already proven correct in the Subscriptions table above. */}
                  <td className="num">
                    {inv.amount !== undefined && inv.currency ? `${Number(inv.amount).toFixed(3)} ${inv.currency}` : '—'}
                  </td>
                  <td>{invoiceStatusLabel(inv.status)}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                    {inv.period_start ? new Date(inv.period_start).toLocaleDateString('en-GB') : '—'}
                    {' → '}
                    {inv.period_end ? new Date(inv.period_end).toLocaleDateString('en-GB') : '—'}
                  </td>
                  <td>{inv.issue_date ? new Date(inv.issue_date).toLocaleDateString('en-GB') : '—'}</td>
                  <td>{inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB') : '—'}</td>
                </tr>
              ))}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div className="empty-state">No invoices yet.</div>
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
