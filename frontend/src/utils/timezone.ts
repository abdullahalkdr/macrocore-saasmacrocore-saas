// Mirrors backend/src/utils/timezone.ts — dynamic per-company timezone offset,
// replacing the earlier hardcoded Kuwait UTC+3 constant used to display
// clock-in/out times. Computed via Intl so DST is handled for any IANA zone.
export function getTimezoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
    const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 180;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes);
  } catch {
    return 180;
  }
}
