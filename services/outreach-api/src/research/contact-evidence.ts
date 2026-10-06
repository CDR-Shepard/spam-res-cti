/**
 * Final review OUT I-1: the last real contact must be found for the leads that need it most, the heavily dialed and the
 * long stale. Research's activity read keeps only the newest Tasks and Events through the REST `query` resource, so a
 * connect behind 25 newer no-answers, or archived by Salesforce after a year, was missed and a returning seller was
 * treated as a new lead.
 *
 * Two small, targeted reads close that gap: the newest Tasks with the positive-evidence shapes last-contact.ts counts
 * (a connected disposition, a "Call back" or an outbound call with a real conversation's length, a CTI subject saying
 * so), and the newest past meeting Events. Both go through the `queryAll` resource, which also returns archived
 * activities, with `IsDeleted = false`. The rows are only candidates: last-contact.ts applies the same rules to them as
 * to the activity read. Ids pass SF_ID and soqlEscape (soqlIdList); nothing else in the SOQL comes from a record.
 */
import { SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { CALL_FIELDS, meta, whoWhat, type ActivityItem } from './activity.js';
import { MIN_TALK_SECONDS } from './last-contact.js';
import { RESEARCH_LIMITS as L } from './limits.js';
import type { LinkIds } from './related.js';
import { classifyReadError, salesforceErrorCode } from './salesforce-errors.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** SOQL dateTime literal, whole seconds UTC. */
const soqlDateTime = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

const TALKED = `CallDurationInSeconds >= ${MIN_TALK_SECONDS}`;
/** The SOQL form of last-contact.ts's positive evidence; a superset is fine (the rows are checked again), a subset is not. */
const CALL_EVIDENCE = [
  "CallDisposition IN ('Connected', 'Do not call')",
  `(CallDisposition = 'Call back' AND ${TALKED})`,
  `(CallDisposition = null AND ${TALKED} AND CallType != 'Inbound' AND (NOT Subject LIKE 'Inbound Call%') AND ((NOT Subject LIKE 'CallRail Recording%') OR CallType = 'Outbound'))`,
  "Subject LIKE '%| Connected |%'",
  "Subject LIKE '%| Do not call |%'",
  `(Subject LIKE '%| Call back |%' AND ${TALKED})`,
].join(' OR ');
const MEETING_SUBJECTS = ['consult', 'appointment', 'walk', 'meeting', 'visit'].map((w) => `Subject LIKE '%${w}%'`).join(' OR ');

/** A refusal (denied, missing, malformed) is no evidence: the activity read still counts. An outage throws for a retry. */
async function orNothing(read: () => Promise<Row[]>): Promise<Row[]> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof SalesforceApiError && salesforceErrorCode(err) === 'INVALID_FIELD') return [];
    classifyReadError(err);
    return [];
  }
}

function taskItem(r: Row): ActivityItem {
  return {
    source: 'task',
    id: String(r.Id),
    at: str(r.CreatedDate),
    title: str(r.Subject),
    body: '',
    meta: meta({ status: r.Status, due: r.ActivityDate, disposition: r.CallDisposition, kind: r.TaskSubtype, callType: r.CallType, seconds: r.CallDurationInSeconds }),
  };
}

function eventItem(r: Row): ActivityItem {
  return { source: 'event', id: String(r.Id), at: str(r.CreatedDate), title: str(r.Subject), body: '', meta: meta({ starts: r.StartDateTime, ends: r.EndDateTime }) };
}

/** The candidate contact Tasks and Events for the lead, archived ones included; [] when there is nothing to read. */
export async function readContactEvidence(client: SalesforceClient, links: LinkIds, now: Date): Promise<ActivityItem[]> {
  const valid = { whoIds: links.whoIds.filter(isId), whatIds: links.whatIds.filter(isId), parentIds: [] };
  const where = whoWhat(valid);
  if (!where) return [];
  const [tasks, events] = await Promise.all([
    orNothing(() =>
      client.queryIncludingArchived<Row>(
        `SELECT Id, Subject, Status, ActivityDate, CreatedDate, ${CALL_FIELDS} FROM Task WHERE ${where} AND IsDeleted = false AND (${CALL_EVIDENCE}) ORDER BY CreatedDate DESC LIMIT ${L.contactTasks}`,
      ),
    ),
    orNothing(() =>
      client.queryIncludingArchived<Row>(
        `SELECT Id, Subject, StartDateTime, EndDateTime, CreatedDate FROM Event WHERE ${where} AND IsDeleted = false AND StartDateTime < ${soqlDateTime(now)} AND (${MEETING_SUBJECTS}) ORDER BY StartDateTime DESC LIMIT ${L.contactEvents}`,
      ),
    ),
  ]);
  return [...tasks.slice(0, L.contactTasks).map(taskItem), ...events.slice(0, L.contactEvents).map(eventItem)];
}

const isId = (id: string): boolean => SF_ID.test(id);
