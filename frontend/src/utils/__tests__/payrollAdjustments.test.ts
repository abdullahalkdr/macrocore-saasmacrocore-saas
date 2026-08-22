import { describe, it, expect } from 'vitest';
import { markSystemAdjustments, mergeSystemAdjustments, FormAdjustment, RawAdjustment } from '../payrollAdjustments';

describe('markSystemAdjustments', () => {
  it('flags rows whose id is a known system-generated adjustment id', () => {
    const raw: RawAdjustment[] = [
      { id: 'adj-1', type: 'bonus', label: 'Eid bonus', amount: 50 },
      { id: 'adj-2', type: 'bonus', label: 'Performance bonus', amount: 120 },
    ];
    const result = markSystemAdjustments(raw, new Set(['adj-2']));
    expect(result.find((r) => r.id === 'adj-1')?.locked).toBeFalsy();
    expect(result.find((r) => r.id === 'adj-2')?.locked).toBe(true);
  });

  it('never locks a row with no id (can happen for legacy rows without one)', () => {
    const raw: RawAdjustment[] = [{ type: 'deduction', label: 'Late fine', amount: 5 }];
    const result = markSystemAdjustments(raw, new Set(['adj-2']));
    expect(result[0].locked).toBeFalsy();
  });

  it('stringifies amount for the editable form field', () => {
    const raw: RawAdjustment[] = [{ id: 'adj-1', type: 'bonus', label: 'x', amount: 12.5 }];
    expect(markSystemAdjustments(raw, new Set()).map((r) => r.amount)).toEqual(['12.5']);
  });
});

describe('mergeSystemAdjustments — the payroll-overwrite fix', () => {
  it('force-includes a system bonus that only exists in the fresh read (the race-condition case)', () => {
    // The manager opened the payroll edit modal, saw only a manual bonus, then a
    // performance bonus got finalized server-side while the modal stayed open. The
    // form's local state never learned about it — the merge must add it anyway.
    const fresh: RawAdjustment[] = [
      { id: 'manual-1', type: 'bonus', label: 'Eid bonus', amount: 50 },
      { id: 'sys-1', type: 'bonus', label: 'Performance bonus', amount: 120 },
    ];
    const systemIds = new Set(['sys-1']);
    const staleForm: FormAdjustment[] = [{ id: 'manual-1', type: 'bonus', label: 'Eid bonus', amount: '50' }];

    const merged = mergeSystemAdjustments(fresh, systemIds, staleForm);

    expect(merged.some((r) => r.id === 'sys-1' && r.locked)).toBe(true);
    expect(merged.some((r) => r.id === 'manual-1')).toBe(true);
    expect(merged).toHaveLength(2);
  });

  it("never lets the UI's local removal of a locked row actually drop it (defense in depth)", () => {
    // The UI already hides the delete button for locked rows, but the merge itself
    // must not trust that alone — even if a locked row is simply absent from the
    // current form state, the fresh system row still wins.
    const fresh: RawAdjustment[] = [{ id: 'sys-1', type: 'bonus', label: 'Performance bonus', amount: 120 }];
    const systemIds = new Set(['sys-1']);
    const staleForm: FormAdjustment[] = []; // locked row missing from local state entirely

    const merged = mergeSystemAdjustments(fresh, systemIds, staleForm);

    expect(merged).toEqual([{ id: 'sys-1', type: 'bonus', label: 'Performance bonus', amount: '120', locked: true }]);
  });

  it('passes normal (non-system) user rows through untouched, including new ones with no id yet', () => {
    const fresh: RawAdjustment[] = [];
    const systemIds = new Set<string>();
    const userForm: FormAdjustment[] = [
      { type: 'deduction', label: 'Uniform deposit', amount: '10' },
      { id: 'manual-1', type: 'bonus', label: 'Eid bonus', amount: '50' },
    ];

    const merged = mergeSystemAdjustments(fresh, systemIds, userForm);

    expect(merged).toEqual(userForm);
  });

  it("replaces a stale local copy of a system row with the fresh one instead of duplicating it", () => {
    // Simulates: the form's local state still has the old amount for a system row
    // (e.g. it was re-finalized/adjusted) — the authoritative fresh copy must win, and
    // there must be exactly one copy of it in the result, not two.
    const fresh: RawAdjustment[] = [{ id: 'sys-1', type: 'bonus', label: 'Performance bonus', amount: 200 }];
    const systemIds = new Set(['sys-1']);
    const staleForm: FormAdjustment[] = [{ id: 'sys-1', type: 'bonus', label: 'Performance bonus', amount: '120', locked: true }];

    const merged = mergeSystemAdjustments(fresh, systemIds, staleForm);

    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe('200');
  });

  it('returns an empty array when there is nothing fresh and nothing local', () => {
    expect(mergeSystemAdjustments([], new Set(), [])).toEqual([]);
  });
});
