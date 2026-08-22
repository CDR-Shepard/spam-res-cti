/**
 * Which business day a rolled-over Follow-up lands on: the first one after
 * `fromDate` where the rep has fewer than `cap` open Follow-ups due. Pure apart
 * from the injected `countOn` (a live Salesforce read — the source of truth,
 * so hand-created tasks count too).
 */
import { nextBusinessDay } from '../dialer/next-business-day.js';
import { soqlEscape } from './client.js';

export const FOLLOWUP_DAILY_CAP_DEFAULT = 100;
export const MAX_ROLLOVER_BUSINESS_DAYS = 30;

/** The owner's OPEN tasks due `isoDate`; subjects are matched in code (`countFollowUps`). Bounded: >500 on one day is over any cap. */
export function followUpTasksSoql(sfOwnerId: string, isoDate: string): string {
  return `SELECT Id, Subject FROM Task WHERE OwnerId = '${soqlEscape(sfOwnerId)}' AND IsClosed = false AND ActivityDate = ${isoDate} LIMIT 500`;
}

export async function pickRolloverDay(opts: {
  fromDate: string;
  cap: number;
  workingWeekdays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  countOn: (isoDate: string) => Promise<number>;
  maxBusinessDays?: number;
}): Promise<string | null> {
  const max = opts.maxBusinessDays ?? MAX_ROLLOVER_BUSINESS_DAYS;
  let candidate = nextBusinessDay(opts.fromDate, opts.workingWeekdays, opts.holidays);
  for (let i = 0; i < max; i++) {
    const n = await opts.countOn(candidate);
    if (n < opts.cap) return candidate;
    candidate = nextBusinessDay(candidate, opts.workingWeekdays, opts.holidays);
  }
  return null;
}
