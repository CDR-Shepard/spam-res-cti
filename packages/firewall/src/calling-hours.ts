import { CALLING_HOURS_END_HHMM_EXCLUSIVE, CALLING_HOURS_START_HHMM } from './calling-window.js';
import { REASON } from './reasons.js';
import { effectiveCallingWindow, resolveStateRule, todayIsoWeekday, type IsoWeekday } from './state-calling-rules.js';
import type { CheckResult } from './types.js';

/**
 * The window gate 6 actually enforces: the shared system window
 * (`dialer/pick-did.ts` — local hour ∈ [8, 20], the SAME pair the power
 * dialer's pre-filter uses) with the campaign row allowed to NARROW it and
 * never to widen it.
 *
 * Before this, the two enforcement sites carried independent numbers — the
 * firewall's came from `campaign_configs` (schema default 08:00–20:00,
 * end-exclusive), the dialer's from its own literals (08:00–20:59) — so an
 * 8:10pm call was blocked on one path and attempted on the other, with nothing
 * keeping them in step (spam-defense audit §5). Clamping rather than replacing
 * keeps a deliberately shorter org window (this org runs 08:00–20:00) exactly
 * as configured, while making the outer bound one constant pair for the whole
 * system — and a campaign row edited to 22:00 can no longer push the firewall
 * past 8:59pm.
 *
 * Pure string compare: both sides are zero-padded `HH:MM`, which orders
 * lexicographically the same as it orders chronologically.
 */

/**
 * Parses "HH:MM" into minutes since midnight. FIX-1: `callingWindowFor`'s
 * clamp used to compare the raw strings lexicographically — an UNPADDED
 * value ("8:00") reads as GREATER than "09:00" character-by-character
 * ('8' > '0') even though it's numerically earlier, which let an unpadded
 * campaign start slip under the federal floor uncorrected AND let an
 * unpadded campaign end get wrongly WIDENED past the cap. Minutes compare
 * correctly regardless of padding.
 */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function callingWindowFor(campaign: {
  callingHoursStart?: string | null;
  callingHoursEnd?: string | null;
}): { start: string; end: string } {
  const start = campaign.callingHoursStart || CALLING_HOURS_START_HHMM;
  const end = campaign.callingHoursEnd || CALLING_HOURS_END_HHMM_EXCLUSIVE;
  return {
    start: hhmmToMinutes(start) > hhmmToMinutes(CALLING_HOURS_START_HHMM) ? start : CALLING_HOURS_START_HHMM,
    end: hhmmToMinutes(end) < hhmmToMinutes(CALLING_HOURS_END_HHMM_EXCLUSIVE) ? end : CALLING_HOURS_END_HHMM_EXCLUSIVE,
  };
}

const WEEKDAY_ABBR: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const WEEKDAY_FULL: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export interface CallingHoursVerdict {
  /** True only when both the day and the clock allow the call. */
  within: boolean;
  /** True when today (recipient-local) is one of the allowed ISO weekdays. */
  dayAllowed: boolean;
  /** Recipient-local weekday full name, e.g. "Sunday" — for messaging. */
  weekdayName: string;
}

/**
 * Splits what `isWithinCallingHours` used to collapse into one boolean, so a
 * caller can tell WHY a call is blocked: wrong day vs. wrong clock. A rep
 * blocked on a Sunday inside the 08:00-20:00 window was reading "outside
 * 08:00-20:00" and concluding the dialer was broken — the day was the real
 * gate, not the hour (2026-08-30 live incident).
 */
export function callingHoursVerdict(
  now: Date,
  timezone: string,
  startHHMM: string,
  endHHMM: string,
  allowedIsoWeekdays: number[],
): CallingHoursVerdict {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const iso = map[weekdayShort] ?? 1;
    const dayAllowed = allowedIsoWeekdays.includes(iso);

    const [sH, sM] = startHHMM.split(':').map(Number) as [number, number];
    const [eH, eM] = endHHMM.split(':').map(Number) as [number, number];
    const nowMins = hour * 60 + minute;
    const startMins = sH * 60 + sM;
    const endMins = eH * 60 + eM;
    const withinHours = nowMins >= startMins && nowMins < endMins;

    return { within: dayAllowed && withinHours, dayAllowed, weekdayName: WEEKDAY_FULL[iso] ?? 'Monday' };
  } catch {
    // Bad tz → fail safe to REVIEW upstream
    return { within: false, dayAllowed: false, weekdayName: '' };
  }
}

export function isWithinCallingHours(
  now: Date,
  timezone: string,
  startHHMM: string,
  endHHMM: string,
  allowedIsoWeekdays: number[],
): boolean {
  return callingHoursVerdict(now, timezone, startHHMM, endHHMM, allowedIsoWeekdays).within;
}

/** Contiguous ISO weekday ranges render as `Mon-Fri`; anything else is a comma list. */
export function formatAllowedDays(allowedIsoWeekdays: number[]): string {
  const days = [...new Set(allowedIsoWeekdays)]
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return '';
  const isContiguous = days.every((d, i) => i === 0 || d === (days[i - 1] ?? NaN) + 1);
  if (isContiguous) {
    return days.length === 1
      ? (WEEKDAY_ABBR[first] ?? '')
      : `${WEEKDAY_ABBR[first] ?? ''}-${WEEKDAY_ABBR[last] ?? ''}`;
  }
  return days.map((d) => WEEKDAY_ABBR[d] ?? '').join(', ');
}

/**
 * The gate-6 BLOCK detail: names the day restriction when that's the actual
 * reason, otherwise keeps the original hours message unchanged. Callers
 * append their own tz-source suffix (` · ${tzSource}`), matching how the
 * PASSED branch already does it.
 */
export function callingHoursBlockDetail(
  verdict: CallingHoursVerdict,
  window: { start: string; end: string },
  timezone: string,
  allowedIsoWeekdays: number[],
): string {
  return verdict.dayAllowed
    ? `Now is outside ${window.start}-${window.end} ${timezone}`
    : `Calling is ${formatAllowedDays(allowedIsoWeekdays)} only (today is ${verdict.weekdayName}, recipient-local)`;
}

/**
 * Gate 6's full boundary: the campaign's own calling window (recipient-local)
 * INTERSECTED with the per-state compliance overlay (weekend-calling ruling,
 * 2026-08-31 — Saturday/Sunday dialing is on globally, except where a state
 * restricts it; state-calling-rules.ts). Pure and exported so it's directly
 * testable without standing up the whole `evaluate()` pipeline, same as
 * `velocityGateCheck`/`attemptGateChecks`.
 *
 * Priority order for WHY a day is blocked (each keeps its own message):
 *  1. The CAMPAIGN itself excludes the day → the original 779fe15 message,
 *     unchanged (`callingHoursBlockDetail`'s day-banned branch).
 *  2. The campaign allows the day but the STATE's rule bans it → names the
 *     state (e.g. "Calling AL is Mon-Sat only ...").
 *  3. The campaign allows the day but the recipient's state is unresolved and
 *     the conservative unknown-state rule bans it (Sundays only) → a message
 *     that says so, instead of naming a state we don't actually have.
 * Otherwise, the clock is checked against the EFFECTIVE (campaign ∩ state)
 * window — never the raw campaign window — for both the PASS detail and the
 * outside-hours BLOCK detail.
 */
export function callingHoursGateCheck(args: {
  now: Date;
  tz: string;
  /** 2-letter US state code, or null if it couldn't be resolved. */
  state: string | null;
  /** The campaign's own window, already clamped to the system bound (callingWindowFor). */
  window: { start: string; end: string };
  allowedDays: number[];
  tzSource?: string;
}): CheckResult {
  const { now, tz, state, window, allowedDays, tzSource } = args;
  const tzDetailSuffix = tzSource ? ` · ${tzSource}` : '';

  // 1. Campaign-day gate first — identical priority and message to 779fe15.
  const campaignVerdict = callingHoursVerdict(now, tz, window.start, window.end, allowedDays);
  if (!campaignVerdict.dayAllowed) {
    return {
      name: 'calling_hours',
      passed: false,
      severity: 'block',
      reasonCode: REASON.OUTSIDE_CALLING_HOURS,
      detail: `${callingHoursBlockDetail(campaignVerdict, window, tz, allowedDays)}${tzDetailSuffix}`,
    };
  }

  // 2. The state overlay's day gate.
  const isoWeekday = todayIsoWeekday(now, tz);
  const stateRule = resolveStateRule(state);
  const effectiveWindow = effectiveCallingWindow({ days: allowedDays, start: window.start, end: window.end }, stateRule, isoWeekday);
  if (!effectiveWindow) {
    const weekdayName = WEEKDAY_FULL[isoWeekday] ?? '';
    const stateDayWindow = stateRule.days[isoWeekday as IsoWeekday];
    // FIX-2: `effectiveCallingWindow` returns null for TWO different reasons —
    // the state bans the day outright (no entry for `isoWeekday`), or the day
    // IS allowed but the state's window doesn't overlap the campaign's
    // (narrower) window at all. The old code assumed the first case
    // unconditionally, which produced a self-contradictory message on the
    // second (e.g. "Calling FL is Mon-Sun only (today is Wednesday...)" when
    // FL plainly allows Wednesday). Branch on whether the state actually has
    // NO window for today.
    const detail = stateDayWindow === undefined
      ? (state
          ? `Calling ${state} is ${formatAllowedDays(Object.keys(stateRule.days).map(Number))} only (today is ${weekdayName}, recipient-local)`
          : `${weekdayName} calling requires a known state (recipient state unresolved)`)
      : (state
          ? `Now is outside ${stateDayWindow.start}-${stateDayWindow.end} ${tz} (${state} rule)`
          : `Now is outside ${stateDayWindow.start}-${stateDayWindow.end} ${tz}`);
    return {
      name: 'calling_hours',
      passed: false,
      severity: 'block',
      reasonCode: REASON.OUTSIDE_CALLING_HOURS,
      detail: `${detail}${tzDetailSuffix}`,
    };
  }

  // 3. The clock, against the EFFECTIVE (campaign ∩ state) window.
  const stateSuffix = state ? ` · ${state} rule` : '';
  const verdict = callingHoursVerdict(now, tz, effectiveWindow.start, effectiveWindow.end, allowedDays);
  if (verdict.within) {
    return {
      name: 'calling_hours',
      passed: true,
      severity: 'info',
      reasonCode: REASON.CALLING_HOURS_OK,
      detail: `${effectiveWindow.start}-${effectiveWindow.end} ${tz}${stateSuffix}${tzDetailSuffix}`,
    };
  }
  return {
    name: 'calling_hours',
    passed: false,
    severity: 'block',
    reasonCode: REASON.OUTSIDE_CALLING_HOURS,
    detail: `${callingHoursBlockDetail(verdict, effectiveWindow, tz, allowedDays)}${tzDetailSuffix}`,
  };
}
