// Pure-JS mirror of the breach/escalation predicates in
// backend/src/controllers/supportTickets.controller.ts's slaReport() lazy sweep. The
// backend still owns the actual persisted sla_response_breached/sla_resolution_breached/
// escalation_level flags (flipped by real UPDATE statements, once, at report time) —
// these functions exist so that logic has a testable, reusable equivalent, and so a
// future per-ticket view can show a live "about to breach" state without waiting for
// the next sweep. Keep these in sync with supportTickets.controller.ts if that SQL
// ever changes.

export interface ResponseBreachInput {
  first_response_at: string | null;
  sla_response_due_at: string | null;
  sla_response_breached: boolean;
}

// Mirrors: `first_response_at IS NULL AND sla_response_due_at < NOW()` (plus the
// already-persisted flag short-circuiting to true, same as the real row would read
// after its next sweep).
export function isResponseBreached(ticket: ResponseBreachInput, now: Date = new Date()): boolean {
  if (ticket.sla_response_breached) return true;
  if (ticket.first_response_at) return false;
  if (!ticket.sla_response_due_at) return false;
  return new Date(ticket.sla_response_due_at).getTime() < now.getTime();
}

export interface ResolutionBreachInput {
  status: string;
  sla_resolution_due_at: string | null;
  sla_resolution_breached: boolean;
}

// Mirrors: `status NOT IN ('resolved', 'closed') AND sla_resolution_due_at < NOW()`.
export function isResolutionBreached(ticket: ResolutionBreachInput, now: Date = new Date()): boolean {
  if (ticket.sla_resolution_breached) return true;
  if (ticket.status === 'resolved' || ticket.status === 'closed') return false;
  if (!ticket.sla_resolution_due_at) return false;
  return new Date(ticket.sla_resolution_due_at).getTime() < now.getTime();
}

export interface EscalationInput {
  escalation_level: number;
  sla_response_breached: boolean;
  sla_response_due_at: string | null;
}

// Mirrors: `escalation_level = 0 AND sla_response_breached = true AND
// escalate_after_minutes IS NOT NULL AND
// sla_response_due_at + (escalate_after_minutes * INTERVAL '1 minute') < NOW()`.
// Only ever true for a ticket whose response breach is ALREADY persisted — this is
// intentionally not a live recompute, same as the SQL it mirrors.
export function isEscalationDue(ticket: EscalationInput, escalateAfterMinutes: number | null, now: Date = new Date()): boolean {
  if (escalateAfterMinutes === null || escalateAfterMinutes === undefined) return false;
  if (ticket.escalation_level !== 0) return false;
  if (!ticket.sla_response_breached) return false;
  if (!ticket.sla_response_due_at) return false;
  return new Date(ticket.sla_response_due_at).getTime() + escalateAfterMinutes * 60000 < now.getTime();
}
