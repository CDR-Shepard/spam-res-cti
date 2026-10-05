/**
 * Recipient-local contact windows: may we reach this number right now — by
 * call, by text, or with a scheduled email?
 *
 * The algorithm is the power dialer's per-lead pre-filter, moved here verbatim
 * from services/cti-api/src/dialer/pick-did.ts (which now re-exports
 * `withinCallingHours` from this package) so the dialer and the outreach
 * planner share ONE rule. The only generalization is that the system window
 * is a parameter instead of the calling-window.ts constants:
 *  - `CALL_WINDOW`  08:00–21:00, built FROM those constants, so it is the
 *                   dialer's window by construction;
 *  - `TEXT_WINDOW`  09:00–20:00;
 *  - `EMAIL_WINDOW` 08:00–18:00 (email has no legal window; this is when a
 *                   scheduled email goes out).
 * Every window is intersected with the same per-state overlay
 * (state-calling-rules.ts), so a state's day restriction narrows texts and
 * scheduled email exactly as it narrows calls.
 */
import { CALLING_HOURS_END_HHMM_EXCLUSIVE, CALLING_HOURS_START_HHMM } from './calling-window.js';
import { effectiveCallingWindow, resolveStateRule, todayIsoWeekday } from './state-calling-rules.js';
import { stateForAreaCode, timezoneForNumber } from './tz.js';

/** A recipient-local window: `start` inclusive, `endExclusive` exclusive, both zero-padded "HH:MM". */
export interface LocalWindow {
  start: string;
  endExclusive: string;
}

/** The dialer's window, unchanged: 08:00 through 20:59 recipient-local. */
export const CALL_WINDOW: LocalWindow = Object.freeze({
  start: CALLING_HOURS_START_HHMM,
  endExclusive: CALLING_HOURS_END_HHMM_EXCLUSIVE,
});

/** Texts: 09:00 through 19:59 recipient-local. */
export const TEXT_WINDOW: LocalWindow = Object.freeze({ start: '09:00', endExclusive: '20:00' });

/** Scheduled email: 08:00 through 17:59 recipient-local. */
export const EMAIL_WINDOW: LocalWindow = Object.freeze({ start: '08:00', endExclusive: '18:00' });

/** "HH:MM" for `nowUtc` in `timezone`, zero-padded so string compare orders
 *  the same as chronological order (matches the firewall's comparator). */
function currentHHMM(nowUtc: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(nowUtc);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  // Intl can render midnight as "24:00" for some locales/environments; normalize.
  return hour === '24' ? `00:${minute}` : `${hour}:${minute}`;
}

/**
 * NANP non-geographic ranges — toll-free (800/833/844/855/866/877/888) and
 * premium-rate (900), the SAME set `firewall/tz.ts` documents as
 * intentionally absent from its NPA→tz map. These can NEVER correspond to a
 * recipient's actual state (they're not tied to any location), unlike an NPA
 * that's simply not YET in our map (FIX-9 below) — so they keep the
 * pre-existing fail-open behavior rather than the unknown-state
 * approximation.
 */
const NON_GEOGRAPHIC_NPAS = new Set(['800', '833', '844', '855', '866', '877', '888', '900']);
const NANP_E164 = /^\+1(\d{3})\d{7}$/;

/** Applies the state overlay's effective window (`local` on all 7 days ∩ the
 *  resolved state's rule) and compares it to the current recipient-local
 *  clock. Shared by both the resolved-NPA path and the
 *  unmapped-but-NANP-shaped approximation path below. */
function withinEffectiveWindow(tz: string, state: string | null, nowUtc: Date, local: LocalWindow): boolean {
  const stateRule = resolveStateRule(state);
  const isoWeekday = todayIsoWeekday(nowUtc, tz);
  const window = effectiveCallingWindow(
    { days: [1, 2, 3, 4, 5, 6, 7], start: local.start, end: local.endExclusive },
    stateRule,
    isoWeekday,
  );
  if (!window) return false;
  const nowHHMM = currentHHMM(nowUtc, tz); // FIX-10: was `hhmm`, shadowing the module-level formatter above.
  return nowHHMM >= window.start && nowHHMM < window.end;
}

/**
 * PURE: `withinCallingHours`' algorithm (documented in full below) with the
 * system window as a parameter. `toE164 === null` — a record with no phone
 * number, e.g. email-only — takes the same central-US approximation as an
 * unmapped NANP area code (America/Chicago, unknown-state rule).
 */
export function withinRecipientWindow(toE164: string | null, nowUtc: Date, window: LocalWindow): boolean {
  if (toE164 === null) return withinEffectiveWindow('America/Chicago', null, nowUtc, window);
  const resolved = timezoneForNumber(toE164);
  if (resolved) {
    const state = stateForAreaCode(resolved.matched);
    return withinEffectiveWindow(resolved.timezone, state, nowUtc, window);
  }
  const npa = NANP_E164.exec(toE164)?.[1];
  if (npa && !NON_GEOGRAPHIC_NPAS.has(npa)) {
    return withinEffectiveWindow('America/Chicago', null, nowUtc, window);
  }
  return true;
}

/**
 * PURE: is `nowUtc` within the recipient-local calling window for `toE164`,
 * once the per-state compliance overlay (weekend-calling ruling, 2026-08-31 —
 * Saturday/Sunday dialing is on globally EXCEPT where a state restricts it;
 * see `firewall/state-calling-rules.ts`) is applied? This is the dialer's
 * coarse per-lead pre-filter — the firewall's per-call gate remains
 * authoritative for click-to-dial — but both now route through the SAME
 * `effectiveCallingWindow` + state resolution, so the two enforcement sites
 * cannot disagree about a state's day restriction any more than they can
 * about the hour boundary (the calling-window.ts constants).
 *
 * The dialer has no campaign/SF context for a target — only the dialed
 * number — so the campaign side of the intersection is the system window,
 * all 7 days (the same relaxation the firewall's campaign default now gets
 * via migration 0033), and the state is inferred from the SAME area code
 * already used for tz (`stateForAreaCode`, the SAME data as the tz map — no
 * new source). When that resolves to no state at all (non-US NANP tz, e.g. a
 * Canadian number), the conservative unknown-state rule applies.
 *
 * FIX-9: a NANP-shaped number whose NPA is simply missing from our tz/state
 * maps (e.g. NANPA assigns a new geographic area code before we add it) used
 * to fail OPEN unconditionally here — which, after the weekend-calling
 * ruling, would let a ban-state's Sunday slip through for that NPA the
 * moment NANPA assigns it there. It now applies the conservative
 * UNKNOWN_STATE_RULE with `America/Chicago` as a central-US approximation
 * timezone: conservative on day 7 (Sunday banned, like every other
 * unresolved-state number), with Mon-Sat fail-open effectively retained —
 * UNKNOWN_STATE_RULE's Mon-Sat window (08:00-21:00) is exactly the system
 * window every resolvable NPA already gets, so this is no MORE restrictive
 * than a normal number on those days, just no longer unconditionally true
 * outside all hours.
 *
 * A genuinely non-geographic NANP range (toll-free/premium-rate,
 * `NON_GEOGRAPHIC_NPAS`) or a non-NANP number (international) still FAILS
 * OPEN (true) — unchanged: neither can ever correspond to a real state, so
 * there's no state-overlay risk to close, and the firewall's per-call gate
 * remains authoritative for click-to-dial.
 */
export function withinCallingHours(toE164: string, nowUtc: Date): boolean {
  return withinRecipientWindow(toE164, nowUtc, CALL_WINDOW);
}

const STEP_MS = 15 * 60_000;
const HORIZON_MS = 8 * 24 * 60 * 60_000;

/**
 * PURE: the first instant at or after `nowUtc` inside `window` for `toE164` —
 * `nowUtc` itself when already inside. Otherwise it walks forward on UTC
 * quarter-hour boundaries (every edge in the windows and the state overlay is
 * on the hour, and every US zone is a whole-hour offset, so an opening always
 * lands on one) for at most 8 days; when nothing opens by then it returns
 * `nowUtc + 8 days`, so the caller always gets a finite time.
 */
export function nextWindowOpening(toE164: string | null, nowUtc: Date, window: LocalWindow): Date {
  if (withinRecipientWindow(toE164, nowUtc, window)) return new Date(nowUtc.getTime());
  const limit = nowUtc.getTime() + HORIZON_MS;
  for (let t = Math.floor(nowUtc.getTime() / STEP_MS) * STEP_MS + STEP_MS; t <= limit; t += STEP_MS) {
    const candidate = new Date(t);
    if (withinRecipientWindow(toE164, candidate, window)) return candidate;
  }
  return new Date(limit);
}
