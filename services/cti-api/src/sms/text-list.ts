/**
 * The rep's texts, as the softphone's Texts tab shows them.
 *
 * Every text to a rep's number is already a row in `inbound_messages` (the
 * inbound-text worker turns it into a Salesforce Task and an email). The tab
 * reads those rows straight from our database, so a rep sees a text even when
 * its Task could not be written, and names each sender from the Task's own
 * links — the same person the Task and the email were linked to, not a fresh
 * phone match.
 */
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { schema, type getDb, type InboundMessage } from '@cti/db';
import { soqlQuery } from '../salesforce/client.js';
import { withTimeout } from '../salesforce/followup-worker.js';
import { isValidSfId } from '../dialer/handoff-store.js';
import { isOptOutText, RECONNECT_SALESFORCE, textEmailLinkTarget } from './inbound-text.js';

type Db = ReturnType<typeof getDb>;

/** A Salesforce read the list waits for. Past this the texts show without names. */
export const TASK_LINK_TIMEOUT_MS = 5_000;

/** Where the text stands in Salesforce, in the four states the rep can act on. */
export type TextSalesforceState = 'logged' | 'pending' | 'reconnect' | 'failed';

/** The record a text's Task points at, and the names Salesforce gives them. */
export interface TaskLinkInfo {
  whoId: string | null;
  whatId: string | null;
  whoName: string | null;
  whatName: string | null;
}

/** One row of GET /texts. Never carries the Twilio id or the raw worker error. */
export interface TextListItem {
  id: string;
  fromE164: string;
  toE164: string;
  body: string;
  numMedia: number;
  receivedAt: string;
  optOut: boolean;
  salesforce: TextSalesforceState;
  senderName: string | null;
  /** The record a tap opens: the open Opportunity, else the Lead/Contact, else the Task. */
  openRecordId: string | null;
}

export function textSalesforceState(row: Pick<InboundMessage, 'status' | 'sfTaskId' | 'lastError'>): TextSalesforceState {
  if (row.sfTaskId) return 'logged';
  if (row.status === 'pending' || row.status === 'in_flight') return 'pending';
  if (row.lastError === RECONNECT_SALESFORCE) return 'reconnect';
  return 'failed';
}

/**
 * Which record a tap opens. `tasksKnown` is false when the Salesforce lookup
 * failed: the Task id is still right, so the tap opens the Task. When the
 * lookup answered without this Task, the Task is gone (a rep deleted it) and
 * there is nothing to open.
 */
function openRecordFor(sfTaskId: string | null, task: TaskLinkInfo | undefined, tasksKnown: boolean): string | null {
  if (!sfTaskId) return null;
  if (!task) return tasksKnown ? null : sfTaskId;
  return textEmailLinkTarget({ WhoId: task.whoId ?? undefined, WhatId: task.whatId ?? undefined }, sfTaskId);
}

export function textListItem(row: InboundMessage, task: TaskLinkInfo | undefined, tasksKnown: boolean): TextListItem {
  return {
    id: row.id,
    fromE164: row.fromE164,
    toE164: row.toE164,
    body: row.body,
    numMedia: row.numMedia,
    receivedAt: row.receivedAt.toISOString(),
    optOut: isOptOutText(row.body),
    salesforce: textSalesforceState(row),
    senderName: task?.whoName ?? task?.whatName ?? null,
    openRecordId: openRecordFor(row.sfTaskId, task, tasksKnown),
  };
}

interface TaskRow {
  Id: string;
  WhoId: string | null;
  WhatId: string | null;
  Who: { Name?: string | null } | null;
  What: { Name?: string | null } | null;
}

type SoqlQuery = (userId: string, soql: string) => Promise<TaskRow[]>;

/**
 * One SOQL read, as the rep, for every Task in the list. Only well-formed
 * Salesforce ids reach the query. Rejects on a Salesforce error or after
 * TASK_LINK_TIMEOUT_MS; the route then lists the texts without names.
 */
export async function fetchTaskLinks(
  userId: string,
  taskIds: readonly string[],
  query: SoqlQuery = (u, q) => soqlQuery<TaskRow>(u, q),
): Promise<Map<string, TaskLinkInfo>> {
  const links = new Map<string, TaskLinkInfo>();
  const ids = [...new Set(taskIds.filter(isValidSfId))];
  if (ids.length === 0) return links;
  const soql = `SELECT Id, WhoId, WhatId, Who.Name, What.Name FROM Task WHERE Id IN (${ids.map((id) => `'${id}'`).join(',')})`;
  const rows = await withTimeout(query(userId, soql), TASK_LINK_TIMEOUT_MS, 'text task lookup');
  for (const r of rows) {
    links.set(r.Id, {
      whoId: r.WhoId ?? null,
      whatId: r.WhatId ?? null,
      whoName: r.Who?.Name ?? null,
      whatName: r.What?.Name ?? null,
    });
  }
  return links;
}

/** The rep's texts, newest first. */
export function selectRepTexts(db: Db, userId: string, limit: number) {
  return db
    .select()
    .from(schema.inboundMessages)
    .where(eq(schema.inboundMessages.userId, userId))
    .orderBy(desc(schema.inboundMessages.receivedAt), desc(schema.inboundMessages.id))
    .limit(limit);
}

/** How many of the rep's texts arrived after `since` — the tab's badge. */
export function countRepTextsSince(db: Db, userId: string, since: Date) {
  return db
    .select({ n: count().mapWith(Number) })
    .from(schema.inboundMessages)
    .where(and(eq(schema.inboundMessages.userId, userId), gt(schema.inboundMessages.receivedAt, since)));
}
