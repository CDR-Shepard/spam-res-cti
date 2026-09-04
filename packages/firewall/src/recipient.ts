import { resolveStateRule, todayIsoWeekday, type IsoWeekday } from './state-calling-rules.js';
import { stateForAreaCode } from './tz.js';


/**
 * FIX-3: the area-code fallback for the recipient's STATE, applied whenever
 * `resolvedState` is still null after both tz-resolution attempts (SF
 * address, then the dialed number's area code) — independent of whether tz
 * itself already resolved. Without this, a record whose SF address resolves
 * tz via COUNTRY (state blank, country "US" — `resolveTimezone`'s
 * US-or-unknown fallback) short-circuits the old area-code fallback, because
 * that fallback lived inside `if (!resolvedTz)` and tz was already set. State
 * then stayed null forever for such a record, which falls to the
 * conservative UNKNOWN_STATE_RULE (Sunday banned) even when the dialed
 * number's own area code plainly identifies a real state (e.g. 619 → CA).
 * Pure and exported so it's directly testable without the whole `evaluate()`
 * pipeline (db, SF client), same pattern as `callingWindowFor`.
 */
export function resolveRecipientState(resolvedState: string | null, e164: string): string | null {
  if (resolvedState) return resolvedState;
  const npa = /^\+1(\d{3})\d{7}$/.exec(e164)?.[1];
  return npa ? stateForAreaCode(npa) : null;
}

/**
 * FIX-4: gate 7d's hours label, sourced from the ENFORCED `STATE_CALLING_RULES`
 * table (today's weekday window for `stateCode`, via the SAME
 * `resolveStateRule`/`todayIsoWeekday` helpers gate 6 uses) — not the legacy
 * `state_calling_rules` DB table gate 7d otherwise still reads for its
 * frequency-cap portion. The two tables have drifted (e.g. the DB seed has OK
 * at 08:00-20:00; the enforced code table is 09:00-20:00), so printing the
 * DB's hours told the rep a window the firewall doesn't actually allow.
 * Pure and exported so it's directly testable without the whole `evaluate()`
 * pipeline (db, SF client), same pattern as `callingWindowFor`.
 */
export function enforcedStateHoursLabel(stateCode: string, now: Date, tz: string): string {
  const isoWeekday = todayIsoWeekday(now, tz);
  const rule = resolveStateRule(stateCode);
  const window = rule.days[isoWeekday as IsoWeekday];
  return window ? `${window.start}-${window.end}` : 'no calling today';
}
