// Dynamic per-company timezone offset — replaces the earlier hardcoded Kuwait
// UTC+3 constant (a multi-tenant SaaS can't hardcode one country's offset; a
// Dubai or London tenant needs their own). Computed via Intl per-date so DST is
// handled correctly for zones that observe it (Kuwait/Dubai don't, but this must
// still be correct for any IANA zone a future tenant picks).
export function getTimezoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
    // e.g. "GMT+3", "GMT-5", "GMT+5:30"
    const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 180; // fall back to Kuwait's offset — the only tenant base today
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes);
  } catch {
    return 180; // unknown/invalid IANA name — same safe fallback
  }
}
