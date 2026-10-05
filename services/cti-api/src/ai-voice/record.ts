/**
 * The Salesforce context an AI call needs about one record: who to call, on
 * which numbers, whether the record carries AI-call consent, and the notes the
 * agent should know before it speaks.
 *
 * Everything is read with the REP's own Salesforce token (`sfFetch` /
 * `soqlQuery`), so the AI can never see a record the rep could not. Consent is
 * read from `AI_Call_Consent__c`; an org (or object) without that field yields
 * `consentFieldMissing: true`, which the gate treats as a block — absence of
 * the field is never read as consent.
 */
import { sfFetch as realSfFetch, soqlQuery as realSoqlQuery } from '../salesforce/client.js';
import { soqlEscape } from '../salesforce/soql.js';
import { resolveDialNumber as realResolveDialNumber } from '../salesforce/record-phone.js';
import { addressFieldNames, formatAddress, pickAddressFields, type AddressFields } from './record-address.js';

export type AiCallObject = 'Lead' | 'Opportunity' | 'Contact';

export interface AiCallRecord {
  objectType: AiCallObject;
  recordId: string;
  name: string | null;
  firstName: string | null;
  /** E.164, in dial order (resolveDialNumber's primary, then its fallback). */
  phones: string[];
  /** `AI_Call_Consent__c === true`; false when the field does not exist. */
  consentAiCall: boolean;
  consentFieldMissing: boolean;
  /** The property address, `"<street>, <city>, <state> <zip>"`; null when the record has none. */
  address: string | null;
  /** Notes fields that exist as `Label: value` lines, then recent Tasks (newest last); capped. */
  notes: string;
  ownerSfUserId: string | null;
}

export interface RecordDeps {
  sfFetch: typeof realSfFetch;
  /** Non-generic so a test fake can stand in; the real `soqlQuery` satisfies it. */
  soqlQuery: (userId: string, soql: string) => Promise<Array<Record<string, unknown>>>;
  resolveDialNumber: typeof realResolveDialNumber;
  /** Clock for the describe cache (ms since epoch). */
  now?: () => number;
}

const defaultDeps: RecordDeps = {
  sfFetch: realSfFetch,
  soqlQuery: realSoqlQuery,
  resolveDialNumber: realResolveDialNumber,
};

export const NOTES_MAX_CHARS = 6_000;
const RECORD_ID = /^[a-zA-Z0-9]{15,18}$/;
const DESCRIBE_TTL_MS = 10 * 60 * 1000;
const RECENT_TASKS = 5;

const CONSENT_FIELD = 'AI_Call_Consent__c';
/** Notes fields, in the order they are written into `notes`. */
const NOTE_FIELDS = [
  'Notes__c',
  'Agent_Notes__c',
  'Description',
  'Motivation__c',
  'SecondaryMotivation__c',
  'Appointment_Notes__c',
  'Analyst_Notes__c',
] as const;
/** The only fields ever selected — the describe narrows this to what exists. */
const WANTED_FIELDS = [CONSENT_FIELD, ...NOTE_FIELDS, 'FirstName', 'Name', 'OwnerId'] as const;

/** What the describe tells us: WANTED_FIELDS present (API name → label) and the address fields. */
interface Described {
  labels: ReadonlyMap<string, string>;
  address: AddressFields;
}

const describeCache = new Map<string, { at: number; described: Described }>();

/** Test hook: forget every cached describe. */
export function clearDescribeCache(): void {
  describeCache.clear();
}

async function describeFields(
  userId: string,
  objectType: AiCallObject,
  deps: RecordDeps,
): Promise<Described> {
  const now = (deps.now ?? Date.now)();
  const key = `${userId}:${objectType}`;
  const hit = describeCache.get(key);
  if (hit && now - hit.at < DESCRIBE_TTL_MS) return hit.described;

  const res = await deps.sfFetch(userId, `/sobjects/${objectType}/describe`);
  if (res.status >= 400) throw new Error(`Salesforce ${objectType} describe failed (${res.status})`);
  const raw = (res.json as { fields?: Array<{ name?: unknown; label?: unknown; type?: unknown }> } | null)?.fields ?? [];
  const fields = raw.flatMap((f) =>
    typeof f.name === 'string'
      ? [{ name: f.name, type: typeof f.type === 'string' ? f.type : '', label: typeof f.label === 'string' ? f.label.trim() : '' }]
      : [],
  );
  const wanted = new Set<string>(WANTED_FIELDS);
  const labels = new Map(fields.filter((f) => wanted.has(f.name)).map((f) => [f.name, f.label || f.name] as const));
  const described = { labels, address: pickAddressFields(objectType, fields) };
  describeCache.set(key, { at: now, described });
  return described;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

type TaskRow = { Subject?: unknown; Description?: unknown; ActivityDate?: unknown; CreatedDate?: unknown };

function taskLine(t: TaskRow): string {
  const date = text(t.ActivityDate) ?? text(t.CreatedDate)?.slice(0, 10) ?? 'undated';
  const subject = text(t.Subject) ?? '(no subject)';
  const description = text(t.Description);
  return `Task ${date} — ${subject}${description ? `: ${description}` : ''}`;
}

/** Oldest content is dropped first: the tail (newest Tasks) is what survives. */
function capNotes(s: string): string {
  return s.length <= NOTES_MAX_CHARS ? s : `…${s.slice(s.length - (NOTES_MAX_CHARS - 1))}`;
}

async function recentTasks(userId: string, objectType: AiCallObject, rid: string, deps: RecordDeps): Promise<TaskRow[]> {
  const link = objectType === 'Opportunity' ? 'WhatId' : 'WhoId';
  try {
    const rows: TaskRow[] = await deps.soqlQuery(
      userId,
      `SELECT Subject, Description, ActivityDate, CreatedDate FROM Task WHERE ${link} = '${rid}' ORDER BY CreatedDate DESC LIMIT ${RECENT_TASKS}`,
    );
    return [...rows].reverse(); // newest last
  } catch (err) {
    // Tasks are background context, not a safety input: the call can go ahead
    // without them, so a failed read is logged and degrades to "no tasks".
    console.warn('[ai-voice] recent Task read failed:', (err as Error).message);
    return [];
  }
}

async function phonesOf(userId: string, objectType: AiCallObject, recordId: string, deps: RecordDeps): Promise<string[]> {
  const dial = await deps.resolveDialNumber(userId, objectType, recordId);
  if (!dial || dial.skipOnDialer) return [];
  return [dial.e164, dial.fallbackE164].filter((n): n is string => !!n);
}

/**
 * Load the AI-call context for one record, or null when the id is malformed or
 * the record is not visible to this rep. A failed describe, record query or
 * phone lookup THROWS (consent and phones are safety inputs); a failed Task
 * read only degrades the context.
 */
export async function loadAiCallRecord(
  userId: string,
  objectType: AiCallObject,
  recordId: string,
  deps: RecordDeps = defaultDeps,
): Promise<AiCallRecord | null> {
  if (!RECORD_ID.test(recordId)) return null;
  const rid = soqlEscape(recordId);
  const { labels, address: addressFields } = await describeFields(userId, objectType, deps);
  const selected = [...new Set(['Id', ...WANTED_FIELDS.filter((f) => labels.has(f)), ...addressFieldNames(addressFields)])];
  const rows = await deps.soqlQuery(
    userId,
    `SELECT ${selected.join(', ')} FROM ${objectType} WHERE Id = '${rid}' LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;

  const [tasks, phones] = await Promise.all([
    recentTasks(userId, objectType, rid, deps),
    phonesOf(userId, objectType, recordId, deps),
  ]);

  const noteLines = NOTE_FIELDS.flatMap((f) => {
    const v = labels.has(f) ? text(row[f]) : null;
    return v ? [`${labels.get(f)}: ${v}`] : [];
  });
  const consentFieldMissing = !labels.has(CONSENT_FIELD);

  return {
    objectType,
    recordId,
    name: text(row.Name),
    firstName: text(row.FirstName),
    phones,
    consentAiCall: !consentFieldMissing && row[CONSENT_FIELD] === true,
    consentFieldMissing,
    address: formatAddress(row, addressFields),
    notes: capNotes([...noteLines, ...tasks.map(taskLine)].join('\n')),
    ownerSfUserId: text(row.OwnerId),
  };
}
