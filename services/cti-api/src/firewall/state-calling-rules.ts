/**
 * Per-state calling-hours compliance overlay.
 *
 * 2026-08-31 ruling (Evren): "We need to be able to call on weekends." Saturday
 * and Sunday dialing is enabled GLOBALLY, EXCEPT where a state restricts it —
 * this module is that restriction, applied as an overlay on top of the
 * campaign's own window (see `effectiveCallingWindow`: it can only NARROW the
 * campaign window, never widen it).
 *
 * The table below is an engineering default compiled from compliance vendors
 * (kixie, LeadCompliant, tcpaguide, 2026 tables), conservative where sources
 * conflict, documented per-row. It is VERBATIM — counsel can amend this ONE
 * file later; do not add or remove rows without their sign-off.
 */

export interface DayWindow {
  /** "HH:MM" recipient-local, inclusive. */
  start: string;
  /** "HH:MM" recipient-local, EXCLUSIVE — matches the firewall's minute comparator. */
  end: string;
}

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface StateRule {
  /** ISO weekday (1=Mon..7=Sun) -> window. Absent day = calling banned that day. */
  days: Partial<Record<IsoWeekday, DayWindow>>;
}

const w = (start: string, end: string): DayWindow => ({ start, end });

/** All 7 days at a single window — the shape both baselines below share. */
const allDays = (start: string, end: string): StateRule['days'] => ({
  1: w(start, end),
  2: w(start, end),
  3: w(start, end),
  4: w(start, end),
  5: w(start, end),
  6: w(start, end),
  7: w(start, end),
});

/**
 * FEDERAL baseline: default for a state we could resolve but that has no row
 * in the table below (e.g. CA) — all 7 days, the TCPA outer bound (8am-9pm).
 */
export const FEDERAL_BASELINE: StateRule = { days: allDays('08:00', '21:00') };

/**
 * UNKNOWN-state rule: applied when the recipient's state could not be
 * resolved at all (no SF address state, no area-code→state match).
 * Conservative — Mon-Sat only, NO Sunday, because Sunday is where states in
 * the table diverge the most (some ban it outright, some cap the start hour).
 */
export const UNKNOWN_STATE_RULE: StateRule = {
  days: {
    1: w('08:00', '21:00'),
    2: w('08:00', '21:00'),
    3: w('08:00', '21:00'),
    4: w('08:00', '21:00'),
    5: w('08:00', '21:00'),
    6: w('08:00', '21:00'),
    // 7 (Sunday): intentionally absent — banned.
  },
};

/**
 * Verbatim compliance table (2026-08-31 ruling) — DO NOT add or remove rows
 * without counsel sign-off. Each entry cites its source next to the row.
 */
export const STATE_CALLING_RULES: Record<string, StateRule> = {
  // source: kixie/LeadCompliant/tcpaguide 2026 tables — Sunday solicitation ban
  AL: { days: { 1: w('08:00', '21:00'), 2: w('08:00', '21:00'), 3: w('08:00', '21:00'), 4: w('08:00', '21:00'), 5: w('08:00', '21:00'), 6: w('08:00', '21:00') } },
  // source: kixie/LeadCompliant/tcpaguide 2026 tables — Sunday ban
  MS: { days: { 1: w('08:00', '21:00'), 2: w('08:00', '21:00'), 3: w('08:00', '21:00'), 4: w('08:00', '21:00'), 5: w('08:00', '21:00'), 6: w('08:00', '21:00') } },
  // source: La. R.S. 45:844.22 + Sunday ban
  LA: { days: { 1: w('09:00', '20:00'), 2: w('09:00', '20:00'), 3: w('09:00', '20:00'), 4: w('09:00', '20:00'), 5: w('09:00', '20:00'), 6: w('09:00', '20:00') } },
  // source: RI hours-of-operation rule
  RI: { days: { 1: w('09:00', '18:00'), 2: w('09:00', '18:00'), 3: w('09:00', '18:00'), 4: w('09:00', '18:00'), 5: w('09:00', '18:00'), 6: w('10:00', '17:00') } },
  // source: Sunday ban (vendor tables)
  SD: { days: { 1: w('09:00', '21:00'), 2: w('09:00', '21:00'), 3: w('09:00', '21:00'), 4: w('09:00', '21:00'), 5: w('09:00', '21:00'), 6: w('09:00', '21:00') } },
  // source: 10 M.R.S. § 1499-B (strictest — no Saturday, no Sunday)
  ME: { days: { 1: w('09:00', '17:00'), 2: w('09:00', '17:00'), 3: w('09:00', '17:00'), 4: w('09:00', '17:00'), 5: w('09:00', '17:00') } },
  // source: 6 CCR 1010-3 "day limits" — conservative
  CO: { days: { 1: w('09:00', '20:00'), 2: w('09:00', '20:00'), 3: w('09:00', '20:00'), 4: w('09:00', '20:00'), 5: w('09:00', '20:00'), 6: w('09:00', '20:00') } },
  // source: ORS 646A.364 "Sunday limited" — conservative
  OR: { days: { 1: w('08:00', '21:00'), 2: w('08:00', '21:00'), 3: w('08:00', '21:00'), 4: w('08:00', '21:00'), 5: w('08:00', '21:00'), 6: w('08:00', '21:00') } },
  // source: Tex. Bus. & Com. § 304.052 (Sunday noon)
  TX: { days: { 1: w('09:00', '21:00'), 2: w('09:00', '21:00'), 3: w('09:00', '21:00'), 4: w('09:00', '21:00'), 5: w('09:00', '21:00'), 6: w('09:00', '21:00'), 7: w('12:00', '21:00') } },
  // source: GBL § 399-z (no Sunday before 1 PM)
  NY: { days: { 1: w('08:00', '21:00'), 2: w('08:00', '21:00'), 3: w('08:00', '21:00'), 4: w('08:00', '21:00'), 5: w('08:00', '21:00'), 6: w('08:00', '21:00'), 7: w('13:00', '21:00') } },
  // source: Fla. Stat. § 501.059 (FTSA)
  FL: { days: allDays('08:00', '20:00') },
  // source: Okla. tit. 15 § 753
  OK: { days: allDays('09:00', '20:00') },
  // source: Com. Law § 14-2204
  MD: { days: allDays('08:00', '20:00') },
  // source: 940 CMR 29.04
  MA: { days: allDays('08:00', '20:00') },
  // source: § 407.1101
  MO: { days: allDays('09:00', '20:00') },
  // source: § 40-12-301
  WY: { days: allDays('09:00', '20:00') },
  // source: § 445.111a
  MI: { days: allDays('09:00', '21:00') },
  // source: § 48-1003
  ID: { days: allDays('09:00', '21:00') },
  // source: § 24-4.7-5-2
  IN: { days: allDays('09:00', '21:00') },
};

/**
 * Resolve a 2-letter state code to its rule: the table row if listed, the
 * federal baseline if it's a known state absent from the table, or the
 * conservative unknown-state rule if `state` itself couldn't be resolved.
 */
export function resolveStateRule(state: string | null): StateRule {
  if (!state) return UNKNOWN_STATE_RULE;
  return STATE_CALLING_RULES[state.toUpperCase()] ?? FEDERAL_BASELINE;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}
/** Zero-padded "HH:MM" strings order lexicographically the same as chronologically. */
const maxHHMM = (a: string, b: string): string => (a >= b ? a : b);
const minHHMM = (a: string, b: string): string => (a <= b ? a : b);

export interface EffectiveCallingWindowCampaign {
  /** ISO weekdays (1=Mon..7=Sun) the campaign itself allows. */
  days: number[];
  /** "HH:MM" recipient-local, inclusive. */
  start: string;
  /** "HH:MM" recipient-local, exclusive. */
  end: string;
}

/**
 * The intersection of the campaign's own window and the state overlay's
 * window for `isoWeekday` — null when EITHER side bans the day, or when the
 * intersection is empty (the state's window compresses the campaign's to
 * nothing, e.g. a campaign that opens after the state's window closes).
 */
export function effectiveCallingWindow(
  campaign: EffectiveCallingWindowCampaign,
  stateRule: StateRule,
  isoWeekday: number,
): DayWindow | null {
  if (!campaign.days.includes(isoWeekday)) return null;
  const stateWindow = stateRule.days[isoWeekday as IsoWeekday];
  if (!stateWindow) return null;
  const start = maxHHMM(campaign.start, stateWindow.start);
  const end = minHHMM(campaign.end, stateWindow.end);
  if (toMinutes(start) >= toMinutes(end)) return null;
  return { start, end };
}

const WEEKDAY_SHORT_TO_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * Today's ISO weekday (1=Mon..7=Sun) in `timezone`, for `now`. Falls back to
 * Monday (1) if `timezone` is unparseable — callers reach this only after the
 * firewall's "unknown TZ" REVIEW path has already been ruled out upstream.
 */
export function todayIsoWeekday(now: Date, timezone: string): number {
  try {
    const weekdayShort = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
    return WEEKDAY_SHORT_TO_ISO[weekdayShort] ?? 1;
  } catch {
    return 1;
  }
}
