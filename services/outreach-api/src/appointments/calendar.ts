/**
 * Salesforce reads for appointment booking, through the tenant's integration connection: the users on the appointment owner
 * list, and the owner's busy calendar time (Events not shown as Free).
 *
 * All-day Events are stored as midnight GMT with EndDateTime = the last day's midnight (a one-day Event has start = end), so
 * the busy query's lower bound is moved back a day, and each all-day row blocks its local days by date, never by instant.
 */
import { IanaZone } from '@cti/contracts';
import { soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { soqlIdList } from '../research/text.js';
import type { Busy } from './slots.js';
import type { LocalDay } from './zoned.js';

export interface OwnerUser {
  sfUserId: string;
  firstName: string | null;
  name: string;
  isActive: boolean;
  timeZone: string;
}

/** The agent says it ("a quick call with Grant"): letters, spaces, apostrophes, dots and hyphens only. */
const FIRST_NAME = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
/** A User zone the slot contract or Intl refuses (Salesforce has e.g. "GMT") is read as the tenant default. */
export const DEFAULT_OWNER_TIME_ZONE = 'America/Los_Angeles';
export const BUSY_ROW_LIMIT = 2000;
const DAY_MS = 86_400_000;
/** Days either side of the range an all-day Event may still matter on (local days differ from UTC days by at most one). */
const ALL_DAY_MARGIN_DAYS = 2;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function zoneOf(v: unknown): string {
  const zone = str(v);
  if (!zone || !IanaZone.safeParse(zone).success) return DEFAULT_OWNER_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_OWNER_TIME_ZONE;
  }
}

function toUser(row: Row): OwnerUser | null {
  const id = str(row.Id);
  const name = str(row.Name);
  if (!id || !SF_ID.test(id) || !name) return null;
  const first = str(row.FirstName);
  return { sfUserId: id, firstName: first && FIRST_NAME.test(first) ? first : null, name, isActive: row.IsActive === true, timeZone: zoneOf(row.TimeZoneSidKey) };
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

/** Pure: the owner's Events not shown as Free that overlap [from − 1 day, to). */
export function busySoql(ownerId: string, from: Date, to: Date): string {
  if (!SF_ID.test(ownerId)) throw new Error('busySoql needs a valid owner id');
  const after = new Date(from.getTime() - DAY_MS);
  return (
    'SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event ' +
    `WHERE OwnerId = '${soqlEscape(ownerId)}' AND ShowAs != 'Free' AND StartDateTime < ${soqlDateTime(to)} AND EndDateTime > ${soqlDateTime(after)} ` +
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

/** One busy item per date the all-day row covers (ActivityDate through EndDateTime's date), cut to the range's margin. */
function allDayBusy(row: Row, start: Date | null, end: Date | null, from: Date, to: Date): Busy[] {
  const first = dateMs(row.ActivityDate) ?? (start ? utcDayMs(start) : null);
  if (first === null) return [];
  const last = Math.max(first, end ? utcDayMs(end) : first);
  const lo = Math.max(first, utcDayMs(from) - ALL_DAY_MARGIN_DAYS * DAY_MS);
  const hi = Math.min(last, utcDayMs(to) + (ALL_DAY_MARGIN_DAYS - 1) * DAY_MS);
  const out: Busy[] = [];
  for (let d = lo; d <= hi; d += DAY_MS) out.push({ start: start ?? new Date(first), end: end ?? new Date(first), allDay: true, day: localDay(d) });
  return out;
}

/** The owner's busy time overlapping [from, to). Rows that cannot be read are skipped. */
export async function readBusy(client: SalesforceClient, ownerId: string, from: Date, to: Date): Promise<Busy[]> {
  const rows = await client.query<Row>(busySoql(ownerId, from, to));
  return rows.flatMap((row): Busy[] => {
    const start = instant(row.StartDateTime);
    const end = instant(row.EndDateTime);
    if (row.IsAllDayEvent === true) return allDayBusy(row, start, end, from, to);
    return start && end ? [{ start, end, allDay: false }] : [];
  });
}
