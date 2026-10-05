/**
 * Salesforce Tasks for AI calls — record calls only (never a test call, never
 * a call that was not placed), always best-effort: a failure is logged and the
 * Task id stays null; nothing here throws.
 *
 *   logAiCallTask    the call itself: ONE completed Call Task as the rep who
 *                    started it, in the power dialer's connect-task shape
 *                    (buildConnectTaskInput / taskLinks) behind the same
 *                    ownership rule (mayCreateTaskOn). Subject
 *                    "AI call: <outcome in words>". Id → ai_calls.sf_task_id
 *                    and calls.salesforce_task_id.
 *   logCallbackTask  a promised call back (outcome qualified_callback or
 *                    transfer_failed): an OPEN Task for the hand-off user
 *                    (the record owner), created with their own Salesforce
 *                    connection so it is theirs; the starter's when they have
 *                    none. createCallTask has no OwnerId input.
 *
 * No CallDurationInSeconds: the AI's talk time is not the rep's, and the
 * reps' talk-time reports sum that field.
 */
import { eq } from 'drizzle-orm';
import { timezoneForNumber } from '@cti/firewall';
import { getDb, schema } from '@cti/db';
import { ORG_TIMEZONE, orgTodayIso } from '../dialer/org-day.js';
import { createCallTask, type CallTaskInput } from '../salesforce/client.js';
import { buildConnectTaskInput, taskLinks, type TaskLinks } from '../salesforce/dialer-connect-task.js';
import { isSalesforceAuthError, withTimeout } from '../salesforce/followup-worker.js';
import { fetchOwnership, mayCreateTaskOn, type OwnershipSnapshot } from '../salesforce/ownership.js';
import type { BridgeLog } from './bridge.js';
import { ctiDisposition, outcomeWords } from './outcomes.js';
import { parseCallbackAt, type ToolEffects } from './service-tools.js';
import type { AiCallRow, AiCallStore } from './store.js';

/** This org's open Task status (salesforce/followup.ts: its picklist is Open/Completed). */
export const CALLBACK_TASK_STATUS = 'Open';
export const SF_CALL_TIMEOUT_MS = 30_000;
export const SF_CREATE_TIMEOUT_MS = 60_000;
const SUBJECT_MAX = 255;
const CALLBACK_OUTCOMES = new Set(['qualified_callback', 'transfer_failed']);
const WHEN_LINE = /^Callback requested: (.+?)(?: — .*)?$/m;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PROMISED = 'The caller was promised a call back.';

export interface AiCallSfPort {
  createCallTask(userId: string, input: CallTaskInput): Promise<{ taskId: string }>;
  fetchOwnership(userId: string, recordId: string): Promise<OwnershipSnapshot>;
  /** The CTI user's Salesforce user id, or null when they have no connection. */
  sfUserIdFor(userId: string): Promise<string | null>;
}

export interface SfLogDeps {
  sf: AiCallSfPort;
  store: AiCallStore;
  log: BridgeLog;
  now: () => Date;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const transcriptLine = (row: AiCallRow) => `Transcript in CTI: AI call ${row.id}`;

/** The record a Task belongs on, or null when this call gets no Task. */
function recordLinks(row: AiCallRow): TaskLinks | null {
  if (row.isTest || !row.sfObject || !row.sfRecordId || !row.callSid) return null;
  return taskLinks(row.sfObject, row.sfRecordId);
}

export function aiCallTaskInput(row: AiCallRow, links: TaskLinks, summary: string): CallTaskInput {
  const { callDurationInSeconds: _rep, ...base } = buildConnectTaskInput(
    {
      id: row.ctiCallId ?? row.id,
      callSid: row.callSid ?? '',
      fromNumber: row.fromE164 ?? '',
      toNumber: row.toE164,
      bridgedAt: row.startedAt ?? row.createdAt,
      endedAt: row.endedAt,
      talkSeconds: null,
    },
    links,
    null,
  );
  return {
    ...base,
    subject: `AI call: ${outcomeWords(row.outcome)}`.slice(0, SUBJECT_MAX),
    callDisposition: ctiDisposition(row.outcome),
    description: `${summary}\n${transcriptLine(row)}`,
  };
}

/** The callback's calendar day: a date-only request as given, else the time in the prospect's zone. */
function callbackDay(row: AiCallRow, when: string | null, now: Date): string {
  if (when && DATE_ONLY.test(when)) return when;
  const tz = timezoneForNumber(row.toE164)?.timezone;
  return row.callbackAt ? orgTodayIso(row.callbackAt, tz ?? undefined) : orgTodayIso(now);
}

/** An exact ISO time as "Wed, Oct 7, 5:00 PM" in the prospect's zone; anything else as the agent wrote it. */
function whenWords(row: AiCallRow, when: string): string {
  const at = DATE_ONLY.test(when) ? null : parseCallbackAt(when);
  if (!at) return when;
  const timeZone = timezoneForNumber(row.toE164)?.timezone ?? ORG_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

export function callbackTaskInput(row: AiCallRow, links: TaskLinks, summary: string, now: Date): CallTaskInput {
  const missedTransfer = row.outcome === 'transfer_failed';
  const when = missedTransfer ? null : (WHEN_LINE.exec(row.summary ?? '')?.[1]?.trim() ?? null);
  return {
    subject: `AI call: callback ${when ? whenWords(row, when) : 'requested'}`.slice(0, SUBJECT_MAX),
    callType: 'Outbound',
    activityDate: missedTransfer ? orgTodayIso(now) : callbackDay(row, when, now),
    ...links,
    description: [summary, ...(missedTransfer ? [PROMISED] : []), transcriptLine(row)].join('\n'),
    customFields: { Status: CALLBACK_TASK_STATUS },
  };
}

/** May `userId` (as `sfUserId`) put a Task on this record? The dialer's rule; a lookup failure fails closed. */
async function allowed(userId: string, sfUserId: string, links: TaskLinks, deps: SfLogDeps): Promise<boolean> {
  return mayCreateTaskOn([links.whoId, links.whatId], sfUserId, (id) =>
    withTimeout(deps.sf.fetchOwnership(userId, id), SF_CALL_TIMEOUT_MS, 'ownership lookup'),
  );
}

async function create(userId: string, input: CallTaskInput, deps: SfLogDeps): Promise<string> {
  const { taskId } = await withTimeout(deps.sf.createCallTask(userId, input), SF_CREATE_TIMEOUT_MS, 'task create');
  return taskId;
}

export async function logAiCallTask(row: AiCallRow, summary: string, deps: SfLogDeps): Promise<string | null> {
  const links = recordLinks(row);
  if (!links) return null;
  try {
    const sfUserId = await deps.sf.sfUserIdFor(row.startedBy);
    if (!sfUserId) {
      deps.log.warn({ aiCallId: row.id }, 'ai-voice: starter has no Salesforce connection — no Task');
      return null;
    }
    if (!(await allowed(row.startedBy, sfUserId, links, deps))) {
      deps.log.info({ aiCallId: row.id }, 'ai-voice: record not owned by the starter — no Task (ownership rule)');
      return null;
    }
    const taskId = await create(row.startedBy, aiCallTaskInput(row, links, summary), deps);
    await deps.store.setSfTaskId(row.id, taskId).catch((e: unknown) =>
      deps.log.error({ aiCallId: row.id, taskId, err: errText(e) }, 'ai-voice: Task created but its id was not stored'),
    );
    return taskId;
  } catch (e) {
    deps.log.error({ aiCallId: row.id, auth: isSalesforceAuthError(e), err: errText(e) }, 'ai-voice: Salesforce Task failed');
    return null;
  }
}

/** The hand-off user when they can write to Salesforce, else the starter. */
async function callbackAuthor(row: AiCallRow, deps: SfLogDeps): Promise<{ userId: string; sfUserId: string } | null> {
  for (const userId of [row.handoffUserId, row.startedBy]) {
    if (!userId) continue;
    const sfUserId = await deps.sf.sfUserIdFor(userId);
    if (sfUserId) return { userId, sfUserId };
  }
  return null;
}

const statusRefused = (e: unknown): boolean => /RESTRICTED_PICKLIST|bad value for restricted picklist/i.test(errText(e));

export async function logCallbackTask(row: AiCallRow, summary: string, deps: SfLogDeps): Promise<string | null> {
  const links = recordLinks(row);
  if (!links || !row.outcome || !CALLBACK_OUTCOMES.has(row.outcome)) return null;
  try {
    const author = await callbackAuthor(row, deps);
    if (!author) {
      deps.log.warn({ aiCallId: row.id }, 'ai-voice: nobody with Salesforce to own the callback Task');
      return null;
    }
    if (!(await allowed(author.userId, author.sfUserId, links, deps))) {
      deps.log.info({ aiCallId: row.id }, 'ai-voice: callback Task not allowed on this record (ownership rule)');
      return null;
    }
    const input = callbackTaskInput(row, links, summary, deps.now());
    try {
      return await create(author.userId, input, deps);
    } catch (e) {
      if (!statusRefused(e)) throw e;
      // A rejected picklist value never creates the Task, so one retry is safe.
      deps.log.warn({ aiCallId: row.id }, 'ai-voice: open Task status refused, creating the callback Task completed');
      const { customFields: _status, ...completed } = input;
      return await create(author.userId, completed, deps);
    }
  } catch (e) {
    deps.log.error({ aiCallId: row.id, auth: isSalesforceAuthError(e), err: errText(e) }, 'ai-voice: callback Task failed');
    return null;
  }
}

/**
 * Tool effects plus Salesforce: a transfer that rings out AFTER finalize
 * already ran (the status callback won the race) makes its callback Task
 * here; otherwise finalize makes it. Detached, so the caller's TwiML is not
 * held up by Salesforce.
 */
export function withSalesforceEffects(base: ToolEffects, deps: SfLogDeps): ToolEffects {
  return {
    ...base,
    async transferFailed(ctx, info) {
      await base.transferFailed(ctx, info);
      if (!info.finalized) return;
      void (async () => {
        const row = await ctx.store.get(ctx.aiCallId);
        if (row) await logCallbackTask(row, row.summary ?? '', deps);
      })().catch((e: unknown) => ctx.log.error({ aiCallId: ctx.aiCallId, err: errText(e) }, 'ai-voice: late callback Task failed'));
    },
  };
}

/** The live Salesforce port: the rep-token client, the cached ownership lookup, salesforce_connections. */
export function liveAiCallSf(): AiCallSfPort {
  return {
    createCallTask,
    fetchOwnership,
    async sfUserIdFor(userId) {
      const [row] = await getDb()
        .select({ sfUserId: schema.salesforceConnections.sfUserId })
        .from(schema.salesforceConnections)
        .where(eq(schema.salesforceConnections.userId, userId))
        .limit(1);
      return row?.sfUserId ?? null;
    },
  };
}
