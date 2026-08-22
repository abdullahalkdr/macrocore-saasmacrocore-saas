import { describe, it, expect } from 'vitest';
import { isResponseBreached, isResolutionBreached, isEscalationDue } from '../slaBreach';

const NOW = new Date('2026-08-22T12:00:00Z');
const PAST = '2026-08-22T10:00:00Z'; // 2h before NOW
const FUTURE = '2026-08-22T14:00:00Z'; // 2h after NOW

describe('isResponseBreached', () => {
  it('is true once the flag is already persisted, regardless of the other fields', () => {
    expect(isResponseBreached({ first_response_at: '2026-08-22T09:00:00Z', sla_response_due_at: FUTURE, sla_response_breached: true }, NOW)).toBe(true);
  });

  it('is true when nobody has responded yet and the due date has passed', () => {
    expect(isResponseBreached({ first_response_at: null, sla_response_due_at: PAST, sla_response_breached: false }, NOW)).toBe(true);
  });

  it('is false once someone has responded, even if the due date has passed', () => {
    expect(isResponseBreached({ first_response_at: '2026-08-22T11:00:00Z', sla_response_due_at: PAST, sla_response_breached: false }, NOW)).toBe(false);
  });

  it('is false while the due date is still in the future', () => {
    expect(isResponseBreached({ first_response_at: null, sla_response_due_at: FUTURE, sla_response_breached: false }, NOW)).toBe(false);
  });

  it('is false when there is no due date at all', () => {
    expect(isResponseBreached({ first_response_at: null, sla_response_due_at: null, sla_response_breached: false }, NOW)).toBe(false);
  });
});

describe('isResolutionBreached', () => {
  it('is true once the flag is already persisted', () => {
    expect(isResolutionBreached({ status: 'open', sla_resolution_due_at: FUTURE, sla_resolution_breached: true }, NOW)).toBe(true);
  });

  it('is true for an open ticket past its resolution due date', () => {
    expect(isResolutionBreached({ status: 'in_progress', sla_resolution_due_at: PAST, sla_resolution_breached: false }, NOW)).toBe(true);
  });

  it('is false for a resolved ticket even past its due date', () => {
    expect(isResolutionBreached({ status: 'resolved', sla_resolution_due_at: PAST, sla_resolution_breached: false }, NOW)).toBe(false);
  });

  it('is false for a closed ticket even past its due date', () => {
    expect(isResolutionBreached({ status: 'closed', sla_resolution_due_at: PAST, sla_resolution_breached: false }, NOW)).toBe(false);
  });

  it('is false while still within the resolution window', () => {
    expect(isResolutionBreached({ status: 'open', sla_resolution_due_at: FUTURE, sla_resolution_breached: false }, NOW)).toBe(false);
  });
});

describe('isEscalationDue', () => {
  const base = { escalation_level: 0, sla_response_breached: true, sla_response_due_at: PAST };

  it('is false when the company has no escalate_after_minutes configured', () => {
    expect(isEscalationDue(base, null, NOW)).toBe(false);
  });

  it('is false once the ticket has already been escalated (escalation_level > 0)', () => {
    expect(isEscalationDue({ ...base, escalation_level: 1 }, 30, NOW)).toBe(false);
  });

  it('is false when the response SLA has not actually breached yet', () => {
    expect(isEscalationDue({ ...base, sla_response_breached: false }, 30, NOW)).toBe(false);
  });

  it('is true once the escalation window has elapsed since the response due date', () => {
    // PAST is 2h (120min) before NOW — a 30 min escalate-after window has long elapsed.
    expect(isEscalationDue(base, 30, NOW)).toBe(true);
  });

  it('is false while still inside the escalation window', () => {
    // 2h before NOW, but the window is 180 minutes — hasn't elapsed yet.
    expect(isEscalationDue(base, 180, NOW)).toBe(false);
  });
});
