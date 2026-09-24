// Stage B7 — where the hosted (simulated) checkout sends the customer back
// (design v3 §6.1 step 7). Polls the tenant-scoped purchase status; never
// trusts anything in the URL beyond the purchase id it looks up. Rendered
// OUTSIDE Layout, like PlanCheckoutPage.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, get } from '../../api/client';
import { fetchPurchase, PurchaseSummary, startPurchaseCheckout } from '../../api/billing';
import { useT } from '../../i18n';
import { useAuthStore } from '../../store/authStore';
import { BillingShell } from './PlanCheckoutPage';
import { billingErrorKey, formatMoney, returnState, shouldPoll, ReturnState } from './billingHelpers';

const POLL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes, then the customer can refresh manually

export default function CheckoutReturnPage() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const purchaseId = searchParams.get('purchase');
  const updateCompany = useAuthStore((s) => s.updateCompany);

  const [purchase, setPurchase] = useState<PurchaseSummary | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const polls = useRef(0);
  const syncedCompany = useRef(false);

  const load = useCallback(async () => {
    if (!purchaseId) return;
    setLoadError(false);
    try {
      const { purchase: p } = await fetchPurchase(purchaseId);
      setPurchase(p);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setLoadError(true);
    }
  }, [purchaseId]);

  useEffect(() => {
    load();
  }, [load]);

  const state: ReturnState | null = purchase ? returnState(purchase) : null;

  useEffect(() => {
    if (!state || !shouldPoll(state) || polls.current >= MAX_POLLS) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [state, purchase, load]);

  // On success, refresh the cached company snapshot so the sidebar's plan
  // locks update immediately (Layout also re-polls /company/me on its own).
  useEffect(() => {
    if (state !== 'success' || syncedCompany.current) return;
    syncedCompany.current = true;
    get<{ plan: string }>('/company/me')
      .then((c) => updateCompany({ plan: c.plan }))
      .catch(() => {});
  }, [state, updateCompany]);

  async function retry() {
    if (!purchase || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const { checkout_url } = await startPurchaseCheckout(purchase.id);
      window.location.assign(checkout_url);
    } catch (err) {
      setActionError(t.billing.errors[billingErrorKey(err instanceof ApiError ? err.code : undefined)]);
      setBusy(false);
      load();
    }
  }

  const planName = (key: string) => t.billing.planNames[key] ?? key;
  const startOver = () =>
    navigate(purchase ? `/billing/plans/${purchase.plan}?interval=${purchase.billing_interval}` : '/billing/plans/silver');

  let body;
  if (!purchaseId) {
    body = <div className="error-banner">{t.billing.returnPage.missingId}</div>;
  } else if (notFound) {
    body = <div className="error-banner">{t.billing.returnPage.notFound}</div>;
  } else if (loadError && !purchase) {
    body = (
      <div className="billing-result">
        <div className="error-banner" role="alert">{t.billing.errors.generic}</div>
        <button type="button" className="btn btn-secondary" onClick={load}>{t.billing.retryLoad}</button>
      </div>
    );
  } else if (!purchase || !state) {
    body = <div className="muted" role="status">{t.billing.returnPage.loading}</div>;
  } else {
    const view: Record<ReturnState, { icon: string; tone: 'ok' | 'warn' | 'bad'; title: string; text: string }> = {
      success: { icon: '✓', tone: 'ok', title: t.billing.returnPage.success, text: t.billing.returnPage.successBody(planName(purchase.plan)) },
      failed: { icon: '!', tone: 'bad', title: t.billing.returnPage.failed, text: t.billing.returnPage.retryBody },
      cancelled: { icon: '×', tone: 'warn', title: t.billing.returnPage.cancelled, text: t.billing.returnPage.retryBody },
      pending: { icon: '…', tone: 'warn', title: t.billing.returnPage.pending, text: t.billing.returnPage.pendingBody },
      notStarted: { icon: '…', tone: 'warn', title: t.billing.returnPage.notStarted, text: t.billing.returnPage.retryBody },
      expired: { icon: '⏱', tone: 'warn', title: t.billing.returnPage.expired, text: t.billing.returnPage.expiredBody },
      closed: { icon: '—', tone: 'warn', title: t.billing.returnPage.closed, text: t.billing.returnPage.closedBody },
    };
    const v = view[state];
    const canRetry = state === 'failed' || state === 'cancelled' || state === 'pending' || state === 'notStarted';
    body = (
      <div className="card billing-result" aria-live="polite">
        <div className={`billing-status-icon ${v.tone}`} aria-hidden="true">{v.icon}</div>
        <h1 style={{ fontSize: 20 }}>{v.title}</h1>
        <p className="muted" style={{ fontSize: 13 }}>{v.text}</p>
        <p style={{ fontSize: 13, margin: '10px 0 0' }}>
          <strong>{planName(purchase.plan)}</strong> ·{' '}
          {purchase.billing_interval === 'annual' ? t.billing.annual : t.billing.monthly} ·{' '}
          <bdi dir="ltr" className="billing-amount">{formatMoney(purchase.amount, purchase.currency)}</bdi>
        </p>
        <p className="billing-footnote">{t.billing.returnPage.invoice(purchase.invoice_number)}</p>
        {actionError && <div className="error-banner" role="alert">{actionError}</div>}
        <div className="actions">
          {state === 'success' && (
            <Link to="/dashboard" className="btn btn-primary">{t.billing.returnPage.goDashboard}</Link>
          )}
          {canRetry && (
            <button type="button" className="btn btn-primary" onClick={retry} disabled={busy} aria-busy={busy}>
              {busy ? t.billing.confirm.working : t.billing.returnPage.retry}
            </button>
          )}
          {(state === 'expired' || state === 'closed') && (
            <button type="button" className="btn btn-primary" onClick={startOver}>{t.billing.returnPage.startOver}</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <BillingShell>
      <h1 style={{ textAlign: 'center' }}>{t.billing.returnPage.title}</h1>
      {body}
    </BillingShell>
  );
}
