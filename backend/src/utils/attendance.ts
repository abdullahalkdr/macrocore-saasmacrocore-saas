// Pure lateness/deduction math, kept separate from the controller so it can be
// unit-tested without a database — mirrors utils/costing.ts's approach.

// officialShiftStartTime comes back from Postgres TIME columns as 'HH:MM:SS' (or 'HH:MM').
function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

// Minutes late relative to (official shift start + grace period), on the given
// attendance date. Returns 0 (never negative) if clockIn is at or before the cutoff.
//
// Built entirely in UTC (the "Z" suffix + setUTCMinutes) rather than server-local time —
// clock_in is stamped with the DB's NOW() (UTC on Railway), and this must compare against
// the same epoch, or the cutoff silently shifts by the Node process's local UTC offset.
// Same simplification reports.controller already uses for its "today" comparisons: no
// per-company IANA timezone support yet, official_shift_start_time is a UTC wall-clock.
export function computeLateMinutes(clockIn: Date, dateStr: string, officialShiftStartTime: string, gracePeriodMinutes: number): number {
  const cutoff = new Date(`${dateStr}T00:00:00Z`);
  cutoff.setUTCMinutes(cutoff.getUTCMinutes() + parseTimeToMinutes(officialShiftStartTime) + gracePeriodMinutes);
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
