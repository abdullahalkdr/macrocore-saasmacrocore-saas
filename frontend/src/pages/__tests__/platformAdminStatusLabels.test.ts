import { describe, expect, it } from 'vitest';
import { canIssueInvoice, invoiceStatusLabel, subscriptionStatusLabel } from '../platformAdminHelpers';

// Stage B7 (design v3 §6.4) — Platform Admin presentation of self-service
// checkout rows. listSubscriptions/listInvoices return every row.
describe('Platform Admin status labels', () => {
  it('labels the new subscription states understandably, existing values unchanged', () => {
    expect(subscriptionStatusLabel('pending_payment')).toBe('Pending payment — customer checkout');
    expect(subscriptionStatusLabel('abandoned')).toBe('Abandoned — never activated');
    for (const s of ['active', 'past_due', 'cancelled']) expect(subscriptionStatusLabel(s)).toBe(s);
  });
  it('labels void invoices, existing values unchanged', () => {
    expect(invoiceStatusLabel('void')).toBe('Void — unpaid, closed');
    expect(invoiceStatusLabel('issued')).toBe('issued');
    expect(invoiceStatusLabel('paid')).toBe('paid');
  });
  it('"Issue invoice" is offered for active subscriptions only — never for pending/abandoned checkout rows', () => {
    expect(canIssueInvoice('active')).toBe(true);
    for (const s of ['pending_payment', 'abandoned', 'past_due', 'cancelled']) expect(canIssueInvoice(s)).toBe(false);
  });
});
