/**
 * Salesforce reads for appointment booking, through the tenant's integration connection: the users on the appointment owner
 * list, and the owner's busy calendar time (Events not shown as Free).
 *
 * All-day Events are stored as midnight GMT with EndDateTime = the last day's midnight (a one-day Event has start = end), so
 * they are matched by local DATE, never by instant: the busy query asks for timed Events overlapping [from, to) and for
 * all-day Events on a date the range touches in the owner's zone, and readBusy keeps exactly those rows.
 */
import { IanaZone } from '@cti/contracts';
import { soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { soqlIdList } from '../research/text.js';
import type { Busy } from './slots.js';
import { zonedParts, type LocalDay } from './zoned.js';

export interface OwnerUser {
  sfUserId: string;
  firstName: string | null;
  name: string;
  isActive: boolean;
  timeZone: string;
  /** The Salesforce zone that was refused and read as DEFAULT_OWNER_TIME_ZONE instead (logged by the caller), else null. */
  zoneRefused: string | null;
}

/** The agent says it ("a quick call with Grant"): letters, spaces, apostrophes, dots and hyphens only. */
const FIRST_NAME = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
/** A User zone the slot contract or Intl refuses is read as the tenant default. */
export const DEFAULT_OWNER_TIME_ZONE = 'America/Los_Angeles';
/** Salesforce's names for UTC (it has a plain "GMT"); the slot contract only takes Area/Location zones. */
const UTC_ZONE = 'Etc/UTC';
const UTC_ALIASES: ReadonlySet<string> = new Set(['GMT', 'UTC', 'UCT', 'Zulu', 'Universal', 'Greenwich', 'Etc/GMT', 'Etc/UTC', 'Etc/UCT', 'Etc/Zulu', 'Etc/Universal', 'Etc/Greenwich', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'GMT0']);
export const BUSY_ROW_LIMIT = 2000;
const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function zoneOf(v: unknown): { timeZone: string; zoneRefused: string | null } {
  const zone = str(v);
  if (!zone) return { timeZone: DEFAULT_OWNER_TIME_ZONE, zoneRefused: null };
  if (UTC_ALIASES.has(zone)) return { timeZone: UTC_ZONE, zoneRefused: null };
  const refused = { timeZone: DEFAULT_OWNER_TIME_ZONE, zoneRefused: zone.slice(0, 64) };
  if (!IanaZone.safeParse(zone).success) return refused;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return { timeZone: zone, zoneRefused: null };
  } catch {
    return refused;
  }
}

function toUser(row: Row): OwnerUser | null {
  const id = str(row.Id);
  const name = str(row.Name);
  if (!id || !SF_ID.test(id) || !name) return null;
  const first = str(row.FirstName);
  return { sfUserId: id, firstName: first && FIRST_NAME.test(first) ? first : null, name, isActive: row.IsActive === true, ...zoneOf(row.TimeZoneSidKey) };
}

/** The users on the list, keyed by the Id Salesforce returns. Bad ids are dropped first; none left, no query. */
export async function readUsers(client: SalesforceClient, ids: readonly string[]): Promise<Map<string, OwnerUser>> {
  const valid = ids.filter((id) => SF_ID.test(id));
  if (valid.length === 0) return new Map();
  const rows = await client.query<Row>(`SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User WHERE Id IN (${soqlIdList(valid)})`);
  return new Map(rows.flatMap((r) => {
    const u = toUser(r);
    return u ? [[u.sfUserId, u] as const] : [];
  }));
}

/** SOQL dateTime literal: UTC, whole seconds. */
const soqlDateTime = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** UTC midnight of a local day: how Salesforce stores an all-day Event on that date. */
const dayMs = (d: LocalDay): number => Date.UTC(d.year, d.month - 1, d.day);

/** The local dates [first, last] the range [from, to) touches in `timeZone`, as UTC-midnight ms. */
function rangeDays(from: Date, to: Date, timeZone: string): { first: number; last: number } {
  return { first: dayMs(zonedParts(from, timeZone)), last: dayMs(zonedParts(new Date(Math.max(from.getTime(), to.getTime() - 1)), timeZone)) };
}

/**
 * Pure: the owner's Events not shown as Free that are busy within [from, to): timed Events overlapping it, and all-day Events
 * on a local date it touches in `timeZone` (start date ≤ the last date, end date ≥ the first).
 */
export function busySoql(ownerId: string, from: Date, to: Date, timeZone: string): string {
  if (!SF_ID.test(ownerId)) throw new Error('busySoql needs a valid owner id');
  const days = rangeDays(from, to, timeZone);
  return (
    'SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event ' +
    `WHERE OwnerId = '${soqlEscape(ownerId)}' AND ShowAs != 'Free' AND ` +
    `((IsAllDayEvent = false AND StartDateTime < ${soqlDateTime(to)} AND EndDateTime > ${soqlDateTime(from)}) OR ` +
    `(IsAllDayEvent = true AND StartDateTime <= ${soqlDateTime(new Date(days.last))} AND EndDateTime >= ${soqlDateTime(new Date(days.first))})) ` +
    `ORDER BY StartDateTime LIMIT ${BUSY_ROW_LIMIT}`
  );
}

const instant = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** UTC midnight of a YYYY-MM-DD date, or null. */
function dateMs(v: unknown): number | null {
  const m = ISO_DATE.exec(str(v) ?? '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const utcDayMs = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const localDay = (ms: number): LocalDay => {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** One busy item per date the all-day row covers (ActivityDate through EndDateTime's date) that the range touches. */
function allDayBusy(row: Row, start: Date | null, end: Date | null, days: { first: number; last: number }): Busy[] {
  const first = dateMs(row.ActivityDate) ?? (start ? utcDayMs(start) : null);
  if (first === null) return [];
  const last = Math.max(first, end ? utcDayMs(end) : first);
  const out: Busy[] = [];
  for (let d = Math.max(first, days.first); d <= Math.min(last, days.last); d += DAY_MS) {
    out.push({ start: start ?? new Date(first), end: end ?? new Date(first), allDay: true, day: localDay(d) });
  }
  return out;
}

/**
 * The owner's busy time within [from, to): timed rows overlapping it (touching is not overlapping), and all-day rows on the
 * local dates (in `timeZone`, the owner's) it touches, one item per date. Rows that cannot be read are skipped.
 */
export async function readBusy(client: SalesforceClient, ownerId: string, from: Date, to: Date, timeZone: string): Promise<Busy[]> {
  const rows = await client.query<Row>(busySoql(ownerId, from, to, timeZone));
  const days = rangeDays(from, to, timeZone);
  return rows.flatMap((row): Busy[] => {
    const start = instant(row.StartDateTime);
    const end = instant(row.EndDateTime);
    if (row.IsAllDayEvent === true) return allDayBusy(row, start, end, days);
    if (!start || !end || start.getTime() >= to.getTime() || end.getTime() <= from.getTime()) return [];
    return [{ start, end, allDay: false }];
  });
}
