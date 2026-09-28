/**
 * Which business day a rolled-over task lands on (spec 2026-09-28 §5): the
 * `businessDays`-th business day after `fromDate`, or the first business day
 * after that where the rep has fewer than `cap` open tasks due. `fromDate` is
 * the LANDING BASE — the later of the dial day and the task's own due date
 * (`rolloverBase`) — not simply the dial day. Pure apart from the injected
 * `countOn` (a live Salesforce read — the source of truth, so hand-created
 * tasks count too).
 */
import type { RolloverBusinessDays } from '@cti/contracts';
import { nextBusinessDay } from '../dialer/next-business-day.js';
import { soqlEscape } from './client.js';

export const FOLLOWUP_DAILY_CAP_DEFAULT = 100;
export const MAX_ROLLOVER_BUSINESS_DAYS = 30;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a rolled task's landing is counted from: the LATER of the dial day
 * (the LA calendar date of the miss — the job's `from_date`) and the task's own
 * due date. A task worked AHEAD of its due date must not "roll" onto the date
 * it already had (Garrett, 2026-09-27: Monday tasks dialed on Sunday went
 * Monday → Monday). A task with no due date, or one Salesforce sent in a shape
 * we do not recognise, counts from the dial day — today's rule. YYYY-MM-DD
 * strings compare correctly as text.
 */
export function rolloverBase(dialDay: string, dueDate: string | null | undefined): string {
  if (!dueDate || !ISO_DAY.test(dueDate)) return dialDay;
  return dueDate > dialDay ? dueDate : dialDay;
}

/** The `businessDays`-th business day strictly after `fromDate` — where the
 *  copy lands when the cap has room. With 1 it is exactly `nextBusinessDay`. */
export function firstLandingDay(
  fromDate: string,
  businessDays: RolloverBusinessDays,
  workingWeekdays: ReadonlySet<number>,
  holidays: ReadonlySet<string>,
): string {
  let day = fromDate;
  for (let i = 0; i < businessDays; i++) day = nextBusinessDay(day, workingWeekdays, holidays);
  return day;
}

/** The owner's OPEN tasks due `isoDate`; subjects are matched in code (`countFollowUps`). Bounded: >500 on one day is over any cap. */
export function followUpTasksSoql(sfOwnerId: string, isoDate: string, withCtiOrigin = true): string {
  const origin = withCtiOrigin ? ', CTI_Origin__c' : '';
  return `SELECT Id, Subject${origin} FROM Task WHERE OwnerId = '${soqlEscape(sfOwnerId)}' AND IsClosed = false AND ActivityDate = ${isoDate} LIMIT 500`;
}

/** The cap loop is unchanged: it scans at most `maxBusinessDays` (30) candidate
 *  days, starting at `firstLandingDay` instead of the next business day. */
export async function pickRolloverDay(opts: {
  fromDate: string;
  businessDays: RolloverBusinessDays;
  cap: number;
  workingWeekdays: ReadonlySet<number>;
  holidays: ReadonlySet<string>;
  countOn: (isoDate: string) => Promise<number>;
  maxBusinessDays?: number;
}): Promise<string | null> {
  const max = opts.maxBusinessDays ?? MAX_ROLLOVER_BUSINESS_DAYS;
  let candidate = firstLandingDay(opts.fromDate, opts.businessDays, opts.workingWeekdays, opts.holidays);
  for (let i = 0; i < max; i++) {
    const n = await opts.countOn(candidate);
    if (n < opts.cap) return candidate;
    candidate = nextBusinessDay(candidate, opts.workingWeekdays, opts.holidays);
  }
  return null;
}
