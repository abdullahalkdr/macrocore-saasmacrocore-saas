// Pure lateness/deduction math, kept separate from the controller so it can be
// unit-tested without a database — mirrors utils/costing.ts's approach.

// officialShiftStartTime comes back from Postgres TIME columns as 'HH:MM:SS' (or 'HH:MM').
function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

// Every macrocore company operates in Kuwait (no multi-country customers yet), so
// official_shift_start_time is entered and understood as Kuwait local wall-clock time
// (UTC+3), not UTC. Hardcoded constant rather than a per-company IANA timezone field —
// simplest thing that's actually correct for the one timezone this product runs in
// today; revisit with a real per-company timezone column if that ever changes.
const KUWAIT_UTC_OFFSET_MINUTES = 3 * 60;

// Minutes late relative to (official shift start + grace period), on the given
// attendance date. Returns 0 (never negative) if clockIn is at or before the cutoff.
//
// clockIn is a real UTC instant (the DB's NOW() on Railway). officialShiftStartTime is a
// Kuwait-local wall-clock reading, so the cutoff is built in UTC and then shifted back by
// KUWAIT_UTC_OFFSET_MINUTES to land on the equivalent UTC instant — e.g. "08:00" Kuwait
// time on 2026-08-22 is 2026-08-22T05:00:00Z, not T08:00:00Z. Without this shift, every
// clock-in was compared against a cutoff 3 hours later than the real shift start, wrongly
// inflating late_minutes (and the resulting deduction) by up to 3 hours for every employee.
export function computeLateMinutes(clockIn: Date, dateStr: string, officialShiftStartTime: string, gracePeriodMinutes: number): number {
  const cutoff = new Date(`${dateStr}T00:00:00Z`);
  cutoff.setUTCMinutes(
    cutoff.getUTCMinutes() + parseTimeToMinutes(officialShiftStartTime) + gracePeriodMinutes - KUWAIT_UTC_OFFSET_MINUTES
  );
  const diffMs = clockIn.getTime() - cutoff.getTime();
  return diffMs > 0 ? Math.round(diffMs / 60000) : 0;
}

// Per-minute rate = monthly salary / (working days per month * standard shift minutes).
// Employees with no salary on file (e.g. commission-only) simply accrue no deduction.
//
// Deliberately monthly-only: hourly employees are paid strictly for hours actually
// worked (clock_out - clock_in, computed in payroll.controller.ts), so a late clock-in
// already reduces their pay on its own — those missed minutes were never on the clock to
// begin with. Also charging a per-minute deduction on top would dock the same minutes
// twice. Monthly salary doesn't have that self-correcting property (it's a fixed amount
// regardless of hours), which is exactly why it needs an explicit deduction.
export function computeDeduction(
  wageType: 'monthly' | 'hourly',
  salaryMonthly: number | null,
  workingDaysPerMonth: number,
  standardShiftMinutes: number,
  lateMinutes: number
): number {
  if (lateMinutes <= 0 || wageType === 'hourly') return 0;
  if (!salaryMonthly || workingDaysPerMonth <= 0 || standardShiftMinutes <= 0) return 0;
  const perMinuteRate = salaryMonthly / (workingDaysPerMonth * standardShiftMinutes);
  return perMinuteRate * lateMinutes;
}
