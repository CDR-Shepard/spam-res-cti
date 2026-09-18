/**
 * Starter numbers for a rep who signs in with none.
 *
 * A new hire used to need an operator: sign in, tell someone, wait for them to
 * run `buy-agent-numbers.ts assign --email …`. Until that happened the softphone
 * had nothing to dial from. Now the first sign-in claims the standard starter
 * set — 6 Los Angeles + 6 San Diego — straight out of the unassigned reserve.
 *
 * Pure on purpose: the database lives behind `AutoAssignDeps`, so every rule
 * here is testable without one. The live wiring is in auto-assign-live.ts.
 *
 * BEST EFFORT, ALWAYS. This runs inside the Salesforce sign-in. Nothing in it
 * may throw: a rep with no numbers can be fixed by an operator in a minute, a
 * rep who cannot sign in cannot work at all.
 */
import { LA_CODES, SD_CODES } from './plan.js';

/** The standard starter set — the same 6 LA / 6 SD `buyPlanForRep` tops reps up to. */
export const STARTER_NUMBERS = { la: 6, sd: 6 } as const;

export interface AutoAssignDeps {
  /** ACTIVE agent numbers already assigned to this user (any health). */
  countHeld: (userId: string) => Promise<number>;
  /**
   * Atomically claim up to `n` free reserve numbers in `codes` for this user,
   * within THEIR org only. Must be safe against a concurrent claimer — two new
   * hires signing in the same minute must never be handed the same number.
   * Resolves to the e164s actually claimed (possibly fewer than `n`).
   */
  claim: (args: { orgId: string; userId: string; codes: readonly string[]; n: number; label: string }) => Promise<string[]>;
}

export type AutoAssignOutcome =
  /** Claimed a starter set. `short*` is how many the reserve could NOT supply. */
  | { status: 'assigned'; la: string[]; sd: string[]; shortLa: number; shortSd: number }
  /** The rep already holds numbers — nothing to do. This is every sign-in but the first. */
  | { status: 'already'; held: number }
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
    // ONLY a rep with nothing. Holding even one number means a person already
    // made a decision about this rep's set (or a partial claim already ran) —
    // topping up silently on every sign-in would fight an operator who removed
    // numbers on purpose, and would let ordinary logins drain the reserve.
    const held = await deps.countHeld(who.userId);
    if (held > 0) return { status: 'already', held };

    const la = await deps.claim({
      orgId: who.orgId, userId: who.userId, codes: LA_CODES,
      n: STARTER_NUMBERS.la, label: starterLabel(who.email, 'LA'),
    });
    const sd = await deps.claim({
      orgId: who.orgId, userId: who.userId, codes: SD_CODES,
      n: STARTER_NUMBERS.sd, label: starterLabel(who.email, 'SD'),
    });
    return {
      status: 'assigned', la, sd,
      shortLa: STARTER_NUMBERS.la - la.length,
      shortSd: STARTER_NUMBERS.sd - sd.length,
    };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
