// Extracted from PayrollPage.tsx's Payroll Overwrite Fix so the merge/lock logic is a
// plain, unit-testable function instead of living inline inside a form submit handler.
// See PayrollPage.tsx's handleSubmit/openEdit for how these are wired to the API.

export interface RawAdjustment {
  id?: string;
  type: 'bonus' | 'deduction';
  label: string;
  amount: number;
}

// The form's row shape — `amount` stays a string while the field is being edited,
// and `locked` marks a row this form must not let the user edit or remove.
export interface FormAdjustment {
  id?: string;
  type: 'bonus' | 'deduction';
  label: string;
  amount: string;
  locked?: boolean;
}

// Turns a freshly-fetched adjustments list into form rows, flagging any row whose id
// appears in the employee's known system-generated (performance-bonus) adjustment ids
// as locked. Used by PayrollPage's openEdit when a payroll record is first opened.
export function markSystemAdjustments(adjustments: RawAdjustment[], systemAdjustmentIds: Set<string>): FormAdjustment[] {
  return adjustments.map((a) => ({
    id: a.id,
    type: a.type,
    label: a.label,
    amount: String(a.amount),
    locked: !!a.id && systemAdjustmentIds.has(a.id),
  }));
}

// The critical fix itself. payroll.controller.ts's update() fully replaces a payroll
// record's adjustments with whatever array the save request submits. If a performance
// bonus is finalized (performanceScores.controller.ts's finalizeScore) while this form
// is sitting open, the form's local state is stale and no longer reflects that new
// system row — submitting it as-is would silently delete the bonus.
//
// The fix: right before submit, re-fetch this payroll record's adjustments AND the
// employee's current system-generated adjustment ids (both fresh reads, not the
// possibly-stale form state), then:
//   1. Force-include every system-generated row from that FRESH read, marked locked.
//   2. Keep every user-edited row from the current form state that is NOT itself one
//      of those fresh system rows (so a stale/duplicate copy of the same system row
//      never gets double-counted or allowed to overwrite the authoritative fresh copy).
// Non-system user rows are otherwise passed through completely untouched — this
// function only ever protects system-generated rows, never alters manual entries.
export function mergeSystemAdjustments(
  freshAdjustments: RawAdjustment[],
  systemAdjustmentIds: Set<string>,
  currentFormAdjustments: FormAdjustment[]
): FormAdjustment[] {
  const freshSystemRows: FormAdjustment[] = freshAdjustments
    .filter((a) => !!a.id && systemAdjustmentIds.has(a.id as string))
    .map((a) => ({ id: a.id, type: a.type, label: a.label, amount: String(a.amount), locked: true }));
  const freshSystemIds = new Set(freshSystemRows.map((r) => r.id));
  const userEditedRows = currentFormAdjustments.filter((a) => !a.locked && !(a.id && freshSystemIds.has(a.id)));
  return [...freshSystemRows, ...userEditedRows];
}
