/** Activity around the lead: Tasks, Events, Notes, ContentNotes and emails, newest first, each source capped. */
import { SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { RESEARCH_LIMITS as L } from './limits.js';
import type { LinkIds } from './related.js';
import { classifyReadError, readSource, salesforceErrorCode, type SourceRead } from './salesforce-errors.js';
import { clip, plainText, soqlIdList } from './text.js';

export type ActivitySource = 'task' | 'event' | 'note' | 'content_note' | 'email' | 'chatter' | 'chatter_comment';
export interface ActivityItem {
  source: ActivitySource;
  id: string;
  at: string | null;
  title: string | null;
  body: string;
  meta: Record<string, string>;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** A string, or a finite number as its decimal text (CallDurationInSeconds comes back as a JSON number). */
const metaText = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));
const byNewest = (a: ActivityItem, b: ActivityItem) => (b.at ?? '').localeCompare(a.at ?? '');
const meta = (pairs: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(pairs).flatMap(([k, v]) => {
    const text = metaText(v);
    return text === null ? [] : [[k, text]];
  }));

/** `(WhoId IN (…) OR WhatId IN (…))`, or null when both lists are empty. */
function whoWhat(links: LinkIds): string | null {
  const parts = [
    ...(links.whoIds.length ? [`WhoId IN (${soqlIdList(links.whoIds)})`] : []),
    ...(links.whatIds.length ? [`WhatId IN (${soqlIdList(links.whatIds)})`] : []),
  ];
  return parts.length ? `(${parts.join(' OR ')})` : null;
}

function capped<T>(rows: T[], max: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}

const TASK_FIELDS = 'Id, Subject, Description, Status, ActivityDate, CreatedDate';
const CALL_FIELDS = 'CallDisposition, TaskSubtype, CallType, CallDurationInSeconds';

/**
 * The Tasks, with the call fields; when the integration user can't read one of them (INVALID_FIELD), once more without
 * them (sweep D-13), so a hidden call field costs the contact evidence, never every Task.
 */
async function taskRows(client: SalesforceClient, where: string): Promise<Row[]> {
  const soql = (fields: string) => `SELECT ${fields} FROM Task WHERE ${where} ORDER BY CreatedDate DESC LIMIT ${L.tasks + 1}`;
  try {
    return await client.query<Row>(soql(`${TASK_FIELDS}, ${CALL_FIELDS}`));
  } catch (err) {
    if (!(err instanceof SalesforceApiError) || salesforceErrorCode(err) !== 'INVALID_FIELD') throw err;
    return client.query<Row>(soql(TASK_FIELDS));
  }
}

export function readTasks(client: SalesforceClient, links: LinkIds): Promise<SourceRead<ActivityItem>> {
  return readSource('tasks', async () => {
    const where = whoWhat(links);
    if (!where) return { items: [], truncated: false };
    const { rows, truncated } = capped(await taskRows(client, where), L.tasks);
    return {
      truncated,
      items: rows.map((r) => ({
        source: 'task' as const,
        id: String(r.Id),
        at: str(r.CreatedDate),
        title: str(r.Subject),
        body: clip(str(r.Description) ?? '', L.noteChars).text,
        // research/last-contact.ts reads these to tell a call that reached a person from one that did not.
        meta: meta({ status: r.Status, due: r.ActivityDate, disposition: r.CallDisposition, kind: r.TaskSubtype, callType: r.CallType, seconds: r.CallDurationInSeconds }),
      })),
    };
  });
}

export function readEvents(client: SalesforceClient, links: LinkIds): Promise<SourceRead<ActivityItem>> {
  return readSource('events', async () => {
    const where = whoWhat(links);
    if (!where) return { items: [], truncated: false };
    const { rows, truncated } = capped(await client.query<Row>(
      // Ranked by CreatedDate like Tasks and Notes: StartDateTime DESC would put far-future events ahead of recent past activity.
      `SELECT Id, Subject, Description, StartDateTime, EndDateTime, Location, CreatedDate FROM Event WHERE ${where} ORDER BY CreatedDate DESC LIMIT ${L.events + 1}`,
    ), L.events);
    return {
      truncated,
      items: rows.map((r) => ({
        source: 'event' as const,
        id: String(r.Id),
        at: str(r.CreatedDate),
        title: str(r.Subject),
        body: clip(str(r.Description) ?? '', L.noteChars).text,
        meta: meta({ starts: r.StartDateTime, ends: r.EndDateTime, location: r.Location }),
      })),
    };
  });
}

export function readNotes(client: SalesforceClient, links: LinkIds): Promise<SourceRead<ActivityItem>> {
  return readSource('notes', async () => {
    if (!links.parentIds.length) return { items: [], truncated: false };
    const { rows, truncated } = capped(await client.query<Row>(
      `SELECT Id, Title, Body, CreatedDate FROM Note WHERE ParentId IN (${soqlIdList(links.parentIds)}) ORDER BY CreatedDate DESC LIMIT ${L.notes + 1}`,
    ), L.notes);
    return { truncated, items: rows.map((r) => ({ source: 'note' as const, id: String(r.Id), at: str(r.CreatedDate), title: str(r.Title), body: clip(str(r.Body) ?? '', L.noteChars).text, meta: {} })) };
  });
}

/** A VersionData body: the client parses non-JSON as `{ raw }`. */
function rawText(json: unknown): string {
  if (json && typeof json === 'object' && 'raw' in json && typeof (json as { raw: unknown }).raw === 'string') return (json as { raw: string }).raw;
  return typeof json === 'string' ? json : '';
}

export async function readContentNotes(client: SalesforceClient, links: LinkIds): Promise<SourceRead<ActivityItem>> {
  let unreadable = 0;
  const read = await readSource('content_notes', async () => {
    if (!links.parentIds.length) return { items: [], truncated: false };
    const docs = await client.query<Row>(
      `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId IN (${soqlIdList(links.parentIds)}) AND ContentDocument.FileType = 'SNOTE' ORDER BY ContentDocument.CreatedDate DESC LIMIT 100`,
    );
    // One note linked to the Lead, its Contact and its Opportunity comes back once per link: keep it once.
    const byDocument = new Map<string, Row>();
    for (const link of docs) {
      const doc = link.ContentDocument as Row | undefined;
      if (!doc || typeof doc.LatestPublishedVersionId !== 'string' || !SF_ID.test(doc.LatestPublishedVersionId)) continue;
      const key = typeof link.ContentDocumentId === 'string' ? link.ContentDocumentId : doc.LatestPublishedVersionId;
      if (!byDocument.has(key)) byDocument.set(key, doc);
    }
    const notes = [...byDocument.values()]
      .sort((a, b) => String(b.CreatedDate ?? '').localeCompare(String(a.CreatedDate ?? '')));
    const { rows, truncated } = capped(notes, L.contentNotes);
    const items: ActivityItem[] = [];
    for (const doc of rows) {
      const res = await client.request(`/sobjects/ContentVersion/${doc.LatestPublishedVersionId as string}/VersionData`);
      if (res.status >= 400) {
        // An outage or throttle (including a 403 REQUEST_LIMIT_EXCEEDED) throws and is retried with the whole
        // research; only a refusal for this one note is recorded.
        classifyReadError(new SalesforceApiError(`Note body fetch failed (${res.status})`, res.status, res.json));
        unreadable += 1;
        continue;
      }
      items.push({ source: 'content_note', id: String(doc.LatestPublishedVersionId), at: str(doc.CreatedDate), title: str(doc.Title), body: clip(plainText(rawText(res.json)), L.noteChars).text, meta: {} });
    }
    return { items, truncated };
  });
  return unreadable > 0 ? { ...read, summary: { ...read.summary, note: `${unreadable} note body unreadable` } } : read;
}

const EMAIL_FIELDS = 'Id, Subject, TextBody, FromAddress, ToAddress, MessageDate, Incoming';

export function readEmails(client: SalesforceClient, links: LinkIds): Promise<SourceRead<ActivityItem>> {
  return readSource('emails', async () => {
    const queries = [
      ...(links.whatIds.length ? [`SELECT ${EMAIL_FIELDS} FROM EmailMessage WHERE RelatedToId IN (${soqlIdList(links.whatIds)}) ORDER BY MessageDate DESC LIMIT ${L.emails + 1}`] : []),
      // Semi-joins may not be OR-ed with another condition in SOQL, hence a second query.
      ...(links.whoIds.length ? [`SELECT ${EMAIL_FIELDS} FROM EmailMessage WHERE Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId IN (${soqlIdList(links.whoIds)})) ORDER BY MessageDate DESC LIMIT ${L.emails + 1}`] : []),
    ];
    const byId = new Map<string, ActivityItem>();
    for (const q of queries) {
      for (const r of await client.query<Row>(q)) {
        byId.set(String(r.Id), {
          source: 'email',
          id: String(r.Id),
          at: str(r.MessageDate),
          title: str(r.Subject),
          body: clip(plainText(str(r.TextBody) ?? ''), L.emailChars).text,
          meta: meta({ direction: r.Incoming === true ? 'inbound' : 'outbound', from: r.FromAddress, to: r.ToAddress }),
        });
      }
    }
    const { rows, truncated } = capped([...byId.values()].sort(byNewest), L.emails);
    return { items: rows, truncated };
  });
}
