import { FormEvent, useEffect, useState } from 'react';
import { API_URL } from '../api/client';
import { IconBuilding } from '../components/Icon';

// macrocore's own cross-tenant dashboard — NOT part of any company's account. Auth
// is a single shared secret (X-Admin-Key, see backend/.env ADMIN_API_KEY), matching
// backend/src/middleware/requireAdminKey.ts. That file's own comment says it best:
// swap for real platform-admin accounts once there's more than one person on the
// macrocore side using this. Until a payment gateway is wired up, this is also the
// only way to turn a trial signup into a paying, unblocked account — see
// updateCompany in backend/src/controllers/admin.controller.ts.
const ADMIN_KEY_STORAGE = 'macrocore-admin-key';

const PLAN_VALUES = ['trial', 'bronze', 'silver', 'gold', 'enterprise'];
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
  monthly_price: number | null;
  auto_renew: boolean;
  next_billing_date: string | null;
  created_at: string;
}
interface Invoice {
  id: string;
  company_id: string;
  company_name: string;
  amount: number;
  status: string;
  issue_date: string;
  due_date: string | null;
  payment_date: string | null;
}
interface Stats {
  total_companies: number;
  by_plan_and_status: { plan: string; subscription_status: string; n: number }[];
  mrr: number;
}

async function adminFetch<T>(path: string, key: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key, ...(options.headers || {}) },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `Request failed (${res.status})`);
  return data as T;
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
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingId(null);
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
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
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
          <div className="stat-card green">
            <div className="stat-label">MRR</div>
            <div className="stat-value">{stats.mrr.toFixed(3)} KD</div>
          </div>
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

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Companies ({companies.length})</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
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
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700 }}>{c.name}</td>
                    <td style={{ fontSize: 12, minWidth: 180 }}>
                      {c.users.length === 0 && <span className="muted">—</span>}
                      {c.users.map((u, i) => (
                        <div key={i} style={{ whiteSpace: 'nowrap' }}>
                          {u.email}
                          <span className="muted"> ({u.role}{u.status !== 'active' ? `, ${u.status}` : ''})</span>
                        </div>
                      ))}
                    </td>
                    <td>{c.industry || '—'}</td>
                    <td>{c.country || '—'}</td>
                    <td>
                      <select
                        value={edit.plan}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: { ...edit, plan: e.target.value } }))}
                      >
                        {PLAN_VALUES.map((p) => (
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
                        type="date"
                        value={edit.trial_end_date}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: { ...edit, trial_end_date: e.target.value } }))}
                        style={{ width: 130 }}
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
                      <button className="btn btn-primary btn-sm" onClick={() => saveCompany(c.id)} disabled={savingId === c.id}>
                        {savingId === c.id ? '…' : 'Save'}
                      </button>
                    </td>
                  </tr>
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
                <th className="num">Monthly price</th>
                <th>Auto-renew</th>
                <th>Next billing</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 700 }}>{s.company_name}</td>
                  <td>{s.plan}</td>
                  <td>{s.status}</td>
                  <td className="num">{s.monthly_price !== null ? `${Number(s.monthly_price).toFixed(3)} KD` : '—'}</td>
                  <td>{s.auto_renew ? 'Yes' : 'No'}</td>
                  <td>{s.next_billing_date ? new Date(s.next_billing_date).toLocaleDateString('en-GB') : '—'}</td>
                </tr>
              ))}
              {subscriptions.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">No subscriptions yet — no payment gateway wired up.</div>
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
                <th>Company</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td style={{ fontWeight: 700 }}>{inv.company_name}</td>
                  <td className="num">{Number(inv.amount).toFixed(3)} KD</td>
                  <td>{inv.status}</td>
                  <td>{new Date(inv.issue_date).toLocaleDateString('en-GB')}</td>
                  <td>{inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-GB') : '—'}</td>
                  <td>{inv.payment_date ? new Date(inv.payment_date).toLocaleDateString('en-GB') : '—'}</td>
                </tr>
              ))}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={6}>
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
