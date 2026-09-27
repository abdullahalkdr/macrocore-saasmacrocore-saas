// Stage B8.1 — self-service subscription purchase / upgrade confirmation jobs.
// Design: claude/chat8b-b8-1-subscription-confirmation-email-design-pass-v2-2026-09-27.md
// (§4, §4.2, §6, §8, §9).
//
// Called ONLY from paymentSettlement.ts::resolvePurchaseLinkedSession, in the
// trusted `succeeded` branch, after applyPurchaseOnTrustedSuccess() and before
// COMMIT, on the SAME client that holds company -> purchase -> (source) ->
// pending -> invoice -> attempt -> session locks.
//
// Durable insert ONLY: this module never imports or calls attemptDeliverNow()
// or enqueueEmail(), and performs no network or other external work. The jobs
// it inserts are invisible until the settlement COMMITs and are then picked up
// only by the existing periodic sweepEmailQueue().
//
// SAVEPOINT semantics (design v2 §4.2):
//   - SAVEPOINT creation failure            -> propagates (settlement rolls back)
//   - email-side failure (detail read, recipients, template, insert)
//       -> ROLLBACK TO SAVEPOINT, then RELEASE SAVEPOINT; only if BOTH succeed:
//          log (PII-free), return 0 jobs, settlement continues
//   - ROLLBACK TO SAVEPOINT failure         -> propagates
//   - recovery RELEASE SAVEPOINT failure    -> propagates
//   - success-path RELEASE SAVEPOINT failure -> propagates
// Isolation is claimed only when both recovery statements succeed; an
// uncertain transaction state is never committed.
//
// Logging: purchase id + a safe error classification only. Never a recipient
// address, subject, HTML, token, session id, admin key or raw error message.

import { env } from '../config/env';
import { resolveBillingRecipients } from '../utils/billingRecipients';
import {
  insertEmailJob,
  PURCHASE_CONFIRMED_DEDUP_PREFIX,
  Queryable,
  subscriptionPurchaseConfirmedEmailHtml,
} from '../utils/email';

export const PURCHASE_CONFIRMATION_SAVEPOINT = 'b8_1_purchase_confirmation';

export interface PurchaseConfirmationContext {
  companyId: string;
  purchaseId: string;
  invoiceId: string;
  kind: 'purchase' | 'upgrade';
  // Plans and interval come from the locked/activated subscription rows —
  // never from companies.plan.
  newPlan: string;
  previousPlan: string | null;
  billingInterval: string;
  // payment_checkout_sessions.provider of the locked session.
  provider: string;
}

type EmailStage = 'detail_read' | 'recipients' | 'template' | 'insert';

interface ConfirmationDetailRow {
  company_name: string;
  invoice_number: string;
  amount_text: string;
  currency: string;
  period_start: string;
  period_end: string;
  confirmed_at: string;
}

// Safe classification only: the stage, plus a PostgreSQL SQLSTATE when it has
// the exact 5-character shape (never the error message, which can echo data).
function classify(stage: EmailStage, err: unknown): { errorClass: EmailStage; pgCode?: string } {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? { errorClass: stage, pgCode: code } : { errorClass: stage };
}

export async function insertPurchaseConfirmationJobs(
  client: Queryable,
  ctx: PurchaseConfirmationContext
): Promise<{ inserted: number }> {
  // Not caught: a SAVEPOINT failure means the transaction is already unusable.
  await client.query(`SAVEPOINT ${PURCHASE_CONFIRMATION_SAVEPOINT}`);

  let stage: EmailStage = 'detail_read';
  let inserted = 0;
  try {
    // Exact decimal text via the same CASE expression as the B7/B8 purchase
    // read model; instants as fixed-width UTC ISO strings. Scoped to the
    // purchase's own company as well as the invoice id.
    const detail = await client.query<ConfirmationDetailRow>(
      `SELECT c.name AS company_name, i.invoice_number,
              CASE WHEN i.currency = 'KWD' THEN i.amount::text ELSE round(i.amount, 2)::text END AS amount_text,
              i.currency,
              to_char(i.period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS period_start,
              to_char(i.period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS period_end,
              to_char(i.payment_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS confirmed_at
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       WHERE i.id = $1 AND i.company_id = $2`,
      [ctx.invoiceId, ctx.companyId]
    );
    if (detail.rows.length !== 1 || !detail.rows[0].confirmed_at) {
      throw new Error('confirmation detail row missing');
    }
    const d = detail.rows[0];

    stage = 'recipients';
    const recipients = await resolveBillingRecipients(ctx.companyId, client);
    if (recipients.length === 0) {
      console.warn('[B8.1] no eligible billing recipients; no confirmation job created', { purchaseId: ctx.purchaseId });
    }

    const link = `${env.FRONTEND_URL}/account?section=billing`;
    for (const recipient of recipients) {
      stage = 'template';
      const { subject, html } = subscriptionPurchaseConfirmedEmailHtml({
        lang: recipient.preferredLanguage,
        timeZone: recipient.companyTimezone,
        kind: ctx.kind,
        testMode: ctx.provider === 'simulated',
        companyName: d.company_name,
        newPlan: ctx.newPlan,
        previousPlan: ctx.kind === 'upgrade' ? ctx.previousPlan : null,
        billingInterval: ctx.billingInterval,
        amountText: d.amount_text,
        currency: d.currency,
        invoiceNumber: d.invoice_number,
        periodStart: d.period_start,
        periodEnd: d.period_end,
        confirmedAt: d.confirmed_at,
        link,
      });

      stage = 'insert';
      const result = await insertEmailJob(client, {
        to: recipient.email,
        subject,
        html,
        category: 'billing',
        lang: recipient.preferredLanguage,
        dedupKey: `${PURCHASE_CONFIRMED_DEDUP_PREFIX}${ctx.purchaseId}:${recipient.userId}`,
        companyId: ctx.companyId,
        relatedEntityType: 'subscription_purchases',
        relatedEntityId: ctx.purchaseId,
      });
      if (result.inserted) inserted += 1;
    }
  } catch (err) {
    const info = classify(stage, err);
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${PURCHASE_CONFIRMATION_SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${PURCHASE_CONFIRMATION_SAVEPOINT}`);
    } catch (recoveryErr) {
      console.error('[B8.1] savepoint recovery failed; settlement will roll back', { purchaseId: ctx.purchaseId, ...info });
      throw recoveryErr;
    }
    console.error('[B8.1] confirmation jobs not created; settlement continues', { purchaseId: ctx.purchaseId, ...info });
    return { inserted: 0 };
  }

  // Success path — outside the try on purpose: a RELEASE failure propagates.
  await client.query(`RELEASE SAVEPOINT ${PURCHASE_CONFIRMATION_SAVEPOINT}`);
  return { inserted };
}
