/**
 * Contact history — every dial the company made to a PERSON, and the three
 * decisions the dialer takes from it. Pure; the rows come from
 * contact-history-live.ts (the power-dial log and the click-to-dial call log).
 *
 * A person is the union of a record's numbers and the record itself: a dial to
 * either number, or logged against the record, is a dial to the person.
 */
import { DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP } from '@cti/firewall';

export interface Dial {
  userId: string;
  /** The power-dial run that made it; null for click-to-dial. */
  sessionId: string | null;
  toNumber: string;
  at: Date;
  connected: boolean;
  source: 'dialer' | 'manual';
}

export interface Person {
  numbers: readonly string[];
  recordId: string | null;
}

/** Courtesy, not law: three hours between dials to the same person. */
export const COOLDOWN_MS = 3 * 60 * 60_000;

export type CadenceVerdict = 'ok' | 'cooldown' | 'daily_cap';

/**
 * May the power dialer dial this person now? `daily_cap` (a law) outranks
 * `cooldown` (a courtesy). The run's OWN dials are exempt from the courtesy —
 * that is the end-of-run retry and the rep's explicit Redial — but never from
 * the cap: every dial by anyone counts toward the law.
 */
export function cadenceVerdict(
  dials: readonly Dial[],
  now: Date,
  opts: { sessionId: string; capped: boolean },
): CadenceVerdict {
  const t = now.getTime();
  if (opts.capped) {
    const inWindow = dials.filter((d) => t - d.at.getTime() < DAILY_CAP_WINDOW_MS).length;
    if (inWindow >= DAILY_DIAL_CAP) return 'daily_cap';
  }
  const recentByOthers = dials.some((d) => d.sessionId !== opts.sessionId && t - d.at.getTime() < COOLDOWN_MS);
  return recentByOthers ? 'cooldown' : 'ok';
}

/**
 * Roll the follow-up forward? The task OWNER has dialed the person at least
 * twice since the org day began, and none of those dials connected. Nobody
 * else's dials count: the task is theirs to work. Runs do not matter: two short
 * runs, a run's retry pass, or a power dial plus a manual call all read alike.
 */
export function rolloverDue(dials: readonly Dial[], ownerUserId: string, dayStart: Date): boolean {
  const own = dials.filter((d) => d.userId === ownerUserId && d.at.getTime() >= dayStart.getTime());
  return own.length >= 2 && own.every((d) => !d.connected);
}

/** The number that most recently reached the person, if it is still one of theirs. */
export function preferredNumber(dials: readonly Dial[], numbers: readonly string[]): string | null {
  const mine = new Set(numbers);
  const connects = dials.filter((d) => d.connected && mine.has(d.toNumber)).sort((a, b) => b.at.getTime() - a.at.getTime());
  return connects[0]?.toNumber ?? null;
}
