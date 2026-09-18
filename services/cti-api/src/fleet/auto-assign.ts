/**
 * Starter numbers for a rep who signs in without a full set.
 *
 * A new hire used to need an operator: sign in, tell someone, wait for them to
 * run `buy-agent-numbers.ts assign --email …`. Until that happened the softphone
 * had nothing to dial from. Now sign-in claims whatever the rep is short of the
 * standard 6 Los Angeles + 6 San Diego, straight out of the unassigned reserve.
 *
 * SHORTFALL, NOT "HOLDS NOTHING". The first cut only acted for a rep holding
 * zero numbers, and that is a trap: the reserve's LA and SD counts drift apart
 * (flagged reserve numbers are retired one at a time), so a hire can get 6 LA and
 * 0 SD — and "holds zero" then refuses every later retry. They would dial San
 * Diego from a 213 number for the rest of their tenure, which is precisely the
 * local-presence property this product exists to protect. Claiming the shortfall
 * converges on 6/6 and then no-ops forever, so a partial set heals on the next
 * sign-in. It is also the SAME rule `buy-rep`, `assign` and `plan` already use
 * (`buyPlanForRep`), so there is one definition of "a usable number" everywhere.
 *
 * Pure on purpose: the database lives behind `AutoAssignDeps`. Live wiring is in
 * auto-assign-live.ts.
 *
 * BEST EFFORT, ALWAYS. This runs inside the Salesforce sign-in and must never
 * throw: a rep short of numbers is a one-minute operator fix, a rep who cannot
 * sign in cannot work at all.
 */
import { buyPlanForRep, LA_CODES, SD_CODES, type Holding } from './plan.js';

/** The standard set — the same 6 LA / 6 SD `buyPlanForRep` tops every rep up to. */
export const STARTER_NUMBERS = { la: 6, sd: 6 } as const;

/** What a claim can do while it holds the rep's lock, inside ONE transaction. */
export interface AutoAssignTx {
  /** Every agent number currently assigned to this user, in their org. */
  holdings: () => Promise<Holding[]>;
  /**
   * Atomically claim up to `n` free reserve numbers in `codes`. Must be safe
   * against a concurrent claimer for a DIFFERENT rep. Resolves to the e164s
   * actually claimed — possibly fewer than `n` when the reserve runs dry.
   */
  claim: (args: { codes: readonly string[]; n: number; label: string }) => Promise<string[]>;
}

export interface AutoAssignDeps {
  /**
   * Run `fn` inside one transaction that holds a lock keyed on this user.
   *
   * Both halves matter. The LOCK stops one rep with two sign-ins in flight (a
   * double-click spawns two tabs, and Salesforce skips consent and redirects
   * both at once) from passing the shortfall check twice and walking away with
   * 24 numbers. The TRANSACTION means a failure on the SD claim rolls the LA
   * claim back too, so a transient error leaves the rep exactly as they were and
   * the next sign-in retries cleanly, instead of committing half a set.
   */
  withUserLock: <T>(who: { orgId: string; userId: string }, fn: (tx: AutoAssignTx) => Promise<T>) => Promise<T>;
}

export type AutoAssignOutcome =
  /** Claimed numbers. `short*` is what the reserve could NOT supply this time. */
  | { status: 'assigned'; la: string[]; sd: string[]; shortLa: number; shortSd: number }
  /** Already at 6/6 usable — nothing to do. This is nearly every sign-in. */
  | { status: 'already' }
  /** Not eligible; says why. Expected, not an error. */
  | { status: 'skipped'; reason: string }
  /** Something broke. Logged by the caller, never thrown. */
  | { status: 'failed'; reason: string };

/**
 * The label the manual `assign` command writes — `Agent <email-local-part> <LA|SD>`.
 * Kept byte-identical: `buy-rep` counts a rep's prior purchases by this label, so
 * a different spelling here would make it re-buy numbers the rep already has.
 */
export function starterLabel(email: string, cls: 'LA' | 'SD'): string {
  return `Agent ${email.split('@')[0]} ${cls}`;
}

export async function assignStarterNumbers(
  deps: AutoAssignDeps,
  who: { orgId: string; userId: string; email: string },
): Promise<AutoAssignOutcome> {
  try {
    return await deps.withUserLock(who, async (tx): Promise<AutoAssignOutcome> => {
      const need = buyPlanForRep(await tx.holdings(), STARTER_NUMBERS);
      if (need.la === 0 && need.sd === 0) return { status: 'already' };

      const la = need.la > 0
        ? await tx.claim({ codes: LA_CODES, n: need.la, label: starterLabel(who.email, 'LA') })
        : [];
      const sd = need.sd > 0
        ? await tx.claim({ codes: SD_CODES, n: need.sd, label: starterLabel(who.email, 'SD') })
        : [];
      return { status: 'assigned', la, sd, shortLa: need.la - la.length, shortSd: need.sd - sd.length };
    });
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Who gets starter numbers automatically: reps on an allowed Salesforce profile.
 *
 * Without this gate ANY of the org's ~100 Salesforce users who opens the app once
 * — a transaction coordinator, someone curious — is handed 12 billable numbers
 * out of a reserve of a few dozen, and three of them empty it before the next
 * real hire arrives. An unknown profile (the lookup failed) is NOT eligible:
 * failing closed costs one retry on the next sign-in, failing open costs numbers.
 */
export function isEligibleProfile(profileName: string | null | undefined, allowed: readonly string[]): boolean {
  if (!profileName) return false;
  const name = profileName.trim().toLowerCase();
  return allowed.some((a) => a.trim().toLowerCase() === name);
}

/** Parse the comma-separated `STARTER_NUMBER_PROFILES` setting. */
export function parseProfiles(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}
