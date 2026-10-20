/**
 * The Salesforce log tick: every timeline event that owes a Task (`sf_log_status = 'pending'`: a seller's reply,
 * Sam's sent email, a flag, an opt-out or other stop) becomes one Task on the seller's record, so the team sees the
 * conversation where they already work. It runs on a schedule (Task 12 wires it); this module is the work of one tick.
 *
 * An event moves pending -> done | pending (retry) | failed:
 *  - CLAIM: one statement takes the oldest due rows of REAL conversations (`for update skip locked`, so two ticks
 *    never take the same row) and pushes their `sf_log_next_at` 10 minutes out. That is the lease: a tick that dies
 *    leaves the row pending and it comes back after the lease, not at once. A practice conversation is excluded
 *    here as well as in the store (appendEvent never makes one pending): nothing of an admin's practice reaches
 *    Salesforce even if a row were forced.
 *  - WORK: the Salesforce calls run outside any transaction (a slow org must not hold a database lock).
 *  - SETTLE: a compare-and-swap on the lease (`pending` and `sf_log_next_at` still the leased value), so a tick that
 *    ran past its lease and lost the row changes nothing and counts nothing; the Task it made is found again by the
 *    next tick's lookup, never doubled.
 *  - A failure counts an attempt and waits 1, 5, 30, 120, then 720 minutes; the 6th failure ends the event `failed`
 *    and raises ONE `sf_log_failed` alert. `sf_log_error` is the error's name (and code) only: Salesforce's message
 *    text can quote the seller's words.
 *
 * One Task per event, even when several events look alike: createTaskOnce finds a Task of ours made since the event
 * and skips any that already belongs to another event (`sf_task_id`), so two replies with the same subject never
 * share a Task. A Lead Salesforce refuses as converted is retried once, in the same attempt, on its Opportunity.
 *
 * Logs and alerts carry ids, counts and error names only: never a subject, a body, an address or a name.
 */
import { sql } from 'drizzle-orm';
import { soqlEscape, type SalesforceClient } from '@cti/salesforce';
import type { Db } from '@cti/db';
import { dispatchAlert, sellerPageUrl, type AlertEvent } from '../alerts.js';
import { DEFAULT_OWNER_TIME_ZONE } from '../appointments/calendar.js';
import { SF_ID } from '../campaigns/records.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { describeError } from '../email/errors.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { cutUtf16 } from '../research/text.js';
import { createTaskOnce, ORIGIN_FIELD, WriteRefusedError } from '../writeback/appointment.js';
import { AI_OUTREACH_ORIGIN } from '../writeback/fields.js';
import { ptToday } from '../writeback/row-run.js';

export const SF_LOG_BATCH = 20;
/** A claimed event is invisible to other ticks this long. */
export const SF_LOG_LEASE_MS = 10 * 60_000;
/** The attempt that fails an event for good. */
export const SF_LOG_MAX_ATTEMPTS = 6;
/** Minutes to wait after the 1st, 2nd ... 5th failed attempt. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;
const DESCRIPTION_BODY_MAX = 30_000;
const SUBJECT_MAX = 255;
const CONVERTED_LEAD = 'CANNOT_UPDATE_CONVERTED_LEAD';

/** Minutes to wait after the `attempts`-th failed attempt (1-based; the last wait repeats). */
export const backoffMinutes = (attempts: number): number => BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1]!;

/** What a FlagReason says, in words a rep reads in a Task subject. */
const FLAG_WORDS: ReadonlyMap<string, string> = new Map([
  ['offer_or_price', 'asked about an offer or price'],
  ['angry_or_threat', 'upset or threatening'],
  ['legal', 'mentioned an attorney or legal action'],
  ['not_owner', 'says they are not the owner'],
  ['wants_appointment', 'wants to set a time'],
  ['unsure', 'Sam was not sure how to answer'],
  ['other_sender', 'a reply came from another address'],
  ['loop_guard', 'many replies today'],
  ['after_close', 'replied after booking or closing'],
  ['draft_rejected', "Sam's reply did not pass the checks"],
]);

/** The Subject of the Task a stop (a `status` event) leaves, by the stop reason. */
const STATUS_SUBJECTS: ReadonlyMap<string, string> = new Map([
  ['opted_out', 'Opted out of Sam (AI)'],
  ['complained', "Spam complaint about Sam's email"],
  ['asked_to_stop', 'Asked Sam (AI) to stop'],
  ['not_interested', 'Not interested (Sam AI)'],
]);

/** The part of a timeline event the Task is made from. */
export interface SfLogEvent {
  kind: string;
  direction: string;
  actor: string;
  occurredAt: Date;
  subject: string | null;
  body: string | null;
  detail: string | null;
}

/** Where the Task goes and the facts it is built from. */
export interface SfTaskTarget {
  /** What `targetId` is: a Lead's Task hangs from WhoId, an Opportunity's from WhatId. */
  sfObject: 'Lead' | 'Opportunity';
  targetId: string;
  ownerId: string;
  orgTimeZone: string | null;
  /** The web app's origin; `conversationUrl` is the seller's page on it, the one link the Description carries. */
  appPublicUrl: string;
  conversationUrl: string;
}

const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
const blank = (s: string | null): boolean => s === null || s.trim() === '';

function eventSubject(e: SfLogEvent): string {
  if (e.kind === 'email') {
    const subject = blank(e.subject) ? '(no subject)' : e.subject!;
    return `${e.direction === 'in' ? 'Email reply from seller' : 'Email from Sam (AI)'}: ${subject}`;
  }
  if (e.kind === 'flag') return e.detail === null ? 'Sam (AI) needs a person' : `Sam (AI) needs a person: ${FLAG_WORDS.get(e.detail) ?? e.detail}`;
  if (e.kind === 'status') return (e.detail === null ? undefined : STATUS_SUBJECTS.get(e.detail)) ?? `Sam (AI) conversation: ${e.detail ?? 'status'}`;
  return `Sam (AI): ${e.kind}`;
}

/** The org's zone, or Pacific when it has none (or one this runtime does not know). */
function zoneOrDefault(zone: string | null): string {
  if (zone === null || zone.trim() === '') return DEFAULT_OWNER_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_OWNER_TIME_ZONE;
  }
}

/**
 * The fields of the Task one event becomes. Pure. A flag is the one Task a person has to act on (open, high priority);
 * every other event is history (completed). `CTI_Origin__c` goes through createTaskOnce's fallback for orgs without it.
 */
export function sfTaskForEvent(e: SfLogEvent, r: SfTaskTarget): Record<string, unknown> {
  const text = blank(e.body) ? (e.detail ?? '') : cutUtf16(e.body!, DESCRIPTION_BODY_MAX);
  const link = `Conversation: ${r.conversationUrl}`;
  const flag = e.kind === 'flag';
  return {
    Subject: cutUtf16(oneLine(eventSubject(e)), SUBJECT_MAX),
    Description: text === '' ? link : `${text}\n\n${link}`,
    OwnerId: r.ownerId,
    ...(r.sfObject === 'Lead' ? { WhoId: r.targetId } : { WhatId: r.targetId }),
    Status: flag ? 'Open' : 'Completed',
    ...(flag ? { Priority: 'High' } : {}),
    ...(e.kind === 'email' ? { TaskSubtype: 'Email' } : {}),
    ActivityDate: ptToday(e.occurredAt, zoneOrDefault(r.orgTimeZone)),
    [ORIGIN_FIELD]: AI_OUTREACH_ORIGIN,
  };
}

export interface SfLogDeps {
  db: Db;
  clients: SalesforceClientFactory;
  appPublicUrl: string;
  now: Date;
  log: RunnerLogger;
  /** Defaults to dispatchAlert on `log`. Never trusted to succeed: a failed alert is logged, not thrown. */
  alert?: (event: AlertEvent) => Promise<void>;
  batch?: number;
}

export interface SfLogCounts {
  done: number;
  retried: number;
  failed: number;
}

interface Claimed {
  id: string;
  orgId: string;
  conversationId: string;
  kind: string;
  direction: string;
  actor: string;
  subject: string | null;
  body: string | null;
  detail: string | null;
  attempts: number;
  occurredAtMs: number | string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  ownerSfUserId: string | null;
  convertedOpportunityId: string | null;
  orgTimeZone: string | null;
  connectionSfUserId: string | null;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * The oldest due pending events of real conversations, leased until `leaseEnd`, with what the Task needs from their
 * record, organization and Salesforce connection. The final SELECT orders them oldest first by when they happened: the
 * order of an UPDATE's RETURNING is not guaranteed, and two same-subject replies are best logged in the order they came.
 */
async function claimDue(db: Db, now: Date, leaseEnd: Date, limit: number): Promise<Claimed[]> {
  const result = await db.execute(sql`
    with due as (
      select ev.id from conversation_events ev
      join seller_conversations sc on sc.id = ev.conversation_id and sc.org_id = ev.org_id
      where ev.sf_log_status = 'pending' and ev.sf_log_next_at <= ${iso(now)} and sc.practice_user_id is null
      order by ev.sf_log_next_at, ev.id
      limit ${limit}
      -- The row lock is what stops two ticks claiming one row; SKIP LOCKED keeps a tick from waiting on rows another holds.
      for update of ev skip locked
    ), leased as (
      update conversation_events ev set sf_log_next_at = ${iso(leaseEnd)}
      from due where ev.id = due.id
      returning ev.id, ev.org_id, ev.conversation_id, ev.kind, ev.direction, ev.actor, ev.occurred_at, ev.subject, ev.body, ev.detail, ev.sf_log_attempts
    )
    select l.id, l.org_id as "orgId", l.conversation_id as "conversationId", l.kind, l.direction, l.actor, l.subject, l.body, l.detail,
           l.sf_log_attempts as attempts, (extract(epoch from l.occurred_at) * 1000)::float8 as "occurredAtMs",
           r.sf_object as "sfObject", r.sf_record_id as "sfRecordId", r.owner_sf_user_id as "ownerSfUserId",
           w.converted_opportunity_id as "convertedOpportunityId", o.timezone as "orgTimeZone", cc.sf_user_id as "connectionSfUserId"
    from leased l
    join seller_conversations sc on sc.id = l.conversation_id
    join crm_records r on r.id = sc.crm_record_id
    join organizations o on o.id = l.org_id
    left join crm_connections cc on cc.org_id = l.org_id and cc.provider = 'salesforce'
    left join lateral (
      select wb.converted_opportunity_id from ai_call_writebacks wb
      where wb.org_id = l.org_id and wb.sf_record_id = r.sf_record_id and r.sf_object = 'Lead' and wb.converted_opportunity_id is not null
      order by wb.created_at desc
      limit 1
    ) w on true
    order by l.occurred_at, l.id`);
  return rows<Claimed>(result);
}

/** A user (005...) owns the Task: the record's owner when it is one, else the connection's own user (a queue owns records too). */
function ownerFor(c: Claimed): string {
  const owner = c.ownerSfUserId;
  if (owner !== null && owner.startsWith('005') && SF_ID.test(owner)) return owner;
  if (c.connectionSfUserId === null) throw new CrmNotConnectedError();
  return c.connectionSfUserId;
}

/** A converted Lead's Task goes on the Opportunity its call's write-back recorded; otherwise on the record itself. */
function targetFor(c: Claimed, r: Pick<SfTaskTarget, 'ownerId' | 'orgTimeZone' | 'appPublicUrl' | 'conversationUrl'>): SfTaskTarget {
  return c.sfObject === 'Lead' && c.convertedOpportunityId !== null
    ? { ...r, sfObject: 'Opportunity', targetId: c.convertedOpportunityId }
    : { ...r, sfObject: c.sfObject, targetId: c.sfRecordId };
}

/** The Opportunity a converted Lead became, or null when it has none (or Salesforce does not say). */
async function convertedOpportunityOf(client: SalesforceClient, leadId: string): Promise<string | null> {
  const [lead] = await client.query<{ ConvertedOpportunityId?: unknown }>(`SELECT ConvertedOpportunityId FROM Lead WHERE Id = '${soqlEscape(leadId)}'`);
  const id = lead?.ConvertedOpportunityId;
  return typeof id === 'string' && SF_ID.test(id) ? id : null;
}

/** Another event already owns this Salesforce Task (its `sf_task_id`). */
async function ownedByAnother(db: Db, taskId: string, eventId: string): Promise<boolean> {
  const result = await db.execute(sql`select 1 as owned from conversation_events where sf_task_id = ${taskId} and id <> ${eventId}::uuid limit 1`);
  return rows<unknown>(result).length > 0;
}

/** The Salesforce Task for one claimed event, made or found. Throws for the tick to count an attempt. */
async function logOne(deps: SfLogDeps, client: SalesforceClient, c: Claimed): Promise<string> {
  const event: SfLogEvent = { kind: c.kind, direction: c.direction, actor: c.actor, occurredAt: new Date(Number(c.occurredAtMs)), subject: c.subject, body: c.body, detail: c.detail };
  const common = { ownerId: ownerFor(c), orgTimeZone: c.orgTimeZone, appPublicUrl: deps.appPublicUrl, conversationUrl: sellerPageUrl(deps.appPublicUrl, c.sfRecordId) };
  const target = targetFor(c, common);
  const once = (t: SfTaskTarget) => createTaskOnce(client, sfTaskForEvent(event, t), event.occurredAt, (taskId) => ownedByAnother(deps.db, taskId, c.id));
  try {
    return await once(target);
  } catch (err) {
    if (!(err instanceof WriteRefusedError && err.code === CONVERTED_LEAD && target.sfObject === 'Lead')) throw err;
    // Converted since the record was read: its Task belongs on the Opportunity. No Opportunity means nowhere to put it: an attempt used.
    const opportunityId = await convertedOpportunityOf(client, target.targetId);
    if (opportunityId === null) throw err;
    return once({ ...target, sfObject: 'Opportunity', targetId: opportunityId });
  }
}

/** The error as a column and a log line may say it: its name, and its code when it has one. Never its message. */
function errorLabel(err: unknown): string {
  const { errorName, errorCode } = describeError(err);
  return (errorCode ? `${errorName}:${errorCode}` : errorName).slice(0, 100);
}

type Settled = 'done' | 'retried' | 'failed' | 'lost';

/** This tick still holds the event: it is pending and `sf_log_next_at` is the value this tick leased. */
const holds = (c: Claimed, leasedUntil: Date) => sql`id = ${c.id}::uuid and sf_log_status = 'pending' and sf_log_next_at = ${iso(leasedUntil)}`;

async function settleDone(db: Db, c: Claimed, leasedUntil: Date, taskId: string): Promise<Settled> {
  const result = await db.execute(sql`
    update conversation_events set sf_log_status = 'done', sf_task_id = ${taskId}, sf_log_error = null, sf_log_next_at = null
    where ${holds(c, leasedUntil)}
    returning id`);
  return rows<unknown>(result).length > 0 ? 'done' : 'lost';
}

async function settleFailure(db: Db, c: Claimed, leasedUntil: Date, now: Date, err: unknown): Promise<Settled> {
  const attempts = c.attempts + 1;
  const exhausted = attempts >= SF_LOG_MAX_ATTEMPTS;
  const nextAt = exhausted ? sql`null` : iso(new Date(now.getTime() + backoffMinutes(attempts) * 60_000));
  const result = await db.execute(sql`
    update conversation_events
    set sf_log_attempts = ${attempts}, sf_log_error = ${errorLabel(err)}, sf_log_status = ${exhausted ? 'failed' : 'pending'}, sf_log_next_at = ${nextAt}
    where ${holds(c, leasedUntil)}
    returning id`);
  if (rows<unknown>(result).length === 0) return 'lost';
  return exhausted ? 'failed' : 'retried';
}

async function alertFailed(deps: SfLogDeps, alert: (event: AlertEvent) => Promise<void>, c: Claimed): Promise<void> {
  try {
    await alert({
      kind: 'sf_log_failed',
      severity: 'warning',
      orgId: c.orgId,
      message: `A conversation event could not be logged to Salesforce after ${SF_LOG_MAX_ATTEMPTS} attempts (event ${c.id}).`,
      context: { eventId: c.id, conversationId: c.conversationId },
    });
  } catch (err) {
    deps.log.error({ eventId: c.id, ...describeError(err) }, 'sf log alert failed');
  }
}

/**
 * One tick: logs up to `batch` due events, oldest first, one at a time (within a tick a Task one event just made is
 * already owned when the next looks; the schedule must not overlap two ticks on one seller). A Salesforce client is built once per
 * organization per tick; one that cannot be built counts an attempt for each of that organization's events.
 */
export async function logEventsToSalesforce(deps: SfLogDeps): Promise<SfLogCounts> {
  const { db, now, log } = deps;
  const alert = deps.alert ?? ((event: AlertEvent) => dispatchAlert(log, event));
  const leasedUntil = new Date(now.getTime() + SF_LOG_LEASE_MS);
  const claimed = await claimDue(db, now, leasedUntil, Math.max(1, Math.trunc(deps.batch ?? SF_LOG_BATCH)));
  const clients = new Map<string, Promise<SalesforceClient>>();
  const clientFor = (orgId: string): Promise<SalesforceClient> => {
    const known = clients.get(orgId);
    if (known !== undefined) return known;
    const made = deps.clients(orgId);
    clients.set(orgId, made);
    return made;
  };
  const counts: SfLogCounts = { done: 0, retried: 0, failed: 0 };
  let lost = 0;
  for (const c of claimed) {
    let outcome: Settled;
    try {
      const client = await clientFor(c.orgId);
      outcome = await settleDone(db, c, leasedUntil, await logOne(deps, client, c));
    } catch (err) {
      log.warn({ eventId: c.id, conversationId: c.conversationId, attempt: c.attempts + 1, ...describeError(err) }, 'salesforce log failed');
      outcome = await settleFailure(db, c, leasedUntil, now, err);
      if (outcome === 'failed') await alertFailed(deps, alert, c);
    }
    if (outcome === 'lost') lost += 1;
    else counts[outcome] += 1;
  }
  if (claimed.length > 0) log.info({ claimed: claimed.length, ...counts, lost }, 'salesforce log tick');
  return counts;
}
