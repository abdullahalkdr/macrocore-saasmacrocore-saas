// Stage B7 — where the hosted (simulated) checkout sends the customer back
// (design v3 §6.1 step 7). Polls the tenant-scoped purchase status; never
// trusts anything in the URL beyond the purchase id it looks up. Rendered
// OUTSIDE Layout, like PlanCheckoutPage.
//
// Stage B8 (design v4 §9.3): fetching, polling and the auth-store plan sync
// live in the pure returnPageController (tested without a DOM). This page is
// a thin renderer: order-scoped copy is HISTORICAL ("this order did / did not
// change your subscription"), and the "current plan" line comes only from
// the controller's fresh /company/me snapshot — never from the purchase.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { fetchCompanySnapshot, fetchPurchase, startPurchaseCheckout } from '../../api/billing';
import { useT } from '../../i18n';
import { useAuthStore } from '../../store/authStore';
import { BillingShell } from './PlanCheckoutPage';
import { billingErrorKey, formatMoney, ReturnState } from './billingHelpers';
import { createReturnPageController, ReturnPageSnapshot } from './returnPageController';

const POLL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes, then the customer can refresh manually

export default function CheckoutReturnPage() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const purchaseId = searchParams.get('purchase');
  const updateCompany = useAuthStore((s) => s.updateCompany);

  const [snap, setSnap] = useState<ReturnPageSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const controller = useMemo(
    () =>
      createReturnPageController({
        fetchPurchase: (id) => fetchPurchase(id).then((r) => r.purchase),
        fetchCompany: () => fetchCompanySnapshot(),
        syncCompanyPlan: (plan) => updateCompany({ plan }),
        schedule: (fn, ms) => {
          const handle = setTimeout(fn, ms);
          return () => clearTimeout(handle);
        },
        onUpdate: setSnap,
        pollMs: POLL_MS,
        maxPolls: MAX_POLLS,
      }),
    [updateCompany]
  );

  useEffect(() => {
    if (!purchaseId) return;
    setSnap(null);
    controller.start(purchaseId);
    return () => controller.stop();
  }, [controller, purchaseId]);

  const purchase = snap?.purchase ?? null;
  const view = snap?.view ?? null;
  const state: ReturnState | null = view?.state ?? null;

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
      if (purchaseId) controller.start(purchaseId);
    }
  }

  const planName = (key: string) => t.billing.planNames[key] ?? key;
  const statusName = (status: string) => {
    switch (status) {
      case 'active': return t.account.billing.activeStatus;
      case 'trial': return t.account.billing.trialWithoutEndStatus;
      case 'past_due': return t.account.billing.pastDueStatus;
      case 'suspended': return t.account.billing.suspendedStatus;
      case 'cancelled': return t.account.billing.cancelledStatus;
      default: return t.account.billing.unknownStatus;
    }
  };
  const startOver = () =>
    navigate(purchase ? `/billing/plans/${purchase.plan}?interval=${purchase.billing_interval}` : '/billing/plans/silver');

  let body;
  if (!purchaseId) {
    body = <div className="error-banner">{t.billing.returnPage.missingId}</div>;
  } else if (snap?.notFound) {
    body = <div className="error-banner">{t.billing.returnPage.notFound}</div>;
  } else if (snap?.loadError && !purchase) {
    body = (
      <div className="billing-result">
        <div className="error-banner" role="alert">{t.billing.errors.generic}</div>
        <button type="button" className="btn btn-secondary" onClick={() => controller.start(purchaseId)}>
          {t.billing.retryLoad}
        </button>
      </div>
    );
  } else if (!purchase || !view || !state) {
    body = <div className="muted" role="status">{t.billing.returnPage.loading}</div>;
  } else {
    const b7Text: Record<ReturnState, string> = {
      success: t.billing.returnPage.successBody(planName(purchase.plan)),
      failed: t.billing.returnPage.retryBody,
      cancelled: t.billing.returnPage.retryBody,
      pending: t.billing.returnPage.pendingBody,
      notStarted: t.billing.returnPage.retryBody,
      expired: t.billing.returnPage.expiredBody,
      closed: t.billing.returnPage.closedBody,
    };
    const head: Record<ReturnState, { icon: string; tone: 'ok' | 'warn' | 'bad'; title: string }> = {
      success: { icon: '✓', tone: 'ok', title: t.billing.returnPage.success },
      failed: { icon: '!', tone: 'bad', title: t.billing.returnPage.failed },
      cancelled: { icon: '×', tone: 'warn', title: t.billing.returnPage.cancelled },
      pending: { icon: '…', tone: 'warn', title: t.billing.returnPage.pending },
      notStarted: { icon: '…', tone: 'warn', title: t.billing.returnPage.notStarted },
      expired: { icon: '⏱', tone: 'warn', title: t.billing.returnPage.expired },
      closed: { icon: '—', tone: 'warn', title: t.billing.returnPage.closed },
    };
    const h = head[state];
    const orderText =
      view.orderLine.key === 'orderUpgraded'
        ? t.billing.returnPage.orderUpgraded(planName(view.orderLine.plan))
        : view.orderLine.key === 'orderDidNotChange'
        ? t.billing.returnPage.orderDidNotChange
        : b7Text[state];
    const canRetry = state === 'failed' || state === 'cancelled' || state === 'pending' || state === 'notStarted';
    body = (
      <div className="card billing-result" aria-live="polite">
        <div className={`billing-status-icon ${h.tone}`} aria-hidden="true">{h.icon}</div>
        <h1 style={{ fontSize: 20 }}>{h.title}</h1>
        <p className="muted" style={{ fontSize: 13 }}>{orderText}</p>
        <p style={{ fontSize: 13, margin: '10px 0 0' }}>
          <strong>{planName(purchase.plan)}</strong> ·{' '}
          {purchase.billing_interval === 'annual' ? t.billing.annual : t.billing.monthly} ·{' '}
          <bdi dir="ltr" className="billing-amount">{formatMoney(purchase.amount, purchase.currency)}</bdi>
        </p>
        {view.upgradeFrom && (
          <p className="billing-footnote" style={{ margin: '4px 0 0' }}>{t.billing.returnPage.upgradeFrom(planName(view.upgradeFrom))}</p>
        )}
        <p className="billing-footnote">{t.billing.returnPage.invoice(purchase.invoice_number)}</p>
        {snap?.companyStatus === 'ok' && view.currentPlan && (
          <p style={{ fontSize: 13, margin: '6px 0 0' }}>
            {t.billing.returnPage.currentPlanNow(planName(view.currentPlan.plan), statusName(view.currentPlan.status))}
          </p>
        )}
        {snap?.companyStatus === 'failed' && (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{t.billing.returnPage.currentPlanUnknown}</p>
        )}
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
