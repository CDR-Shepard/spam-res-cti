/**
 * Test a record, "What would be written to Salesforce" (plan 1E Task 11, spec §4.5), on request for one finished test call.
 * Every step of the 1D write plan is a read or pure: describe → writable fields → the record now (GET) → the mapping model
 * over the call → buildWritePlan (practice off, so the booking counts; no conversion) → the changes text and Chatter post.
 *
 * G-7: nothing is sent. This module imports none of the write steps (steps-write.ts), the Event/Task creates
 * (appointment.ts) or the conversion (convertStep); a test pins that and records every Salesforce request. The answer is
 * stored on the call row, so pressing again costs nothing. One press works a call out at a time (dry-run-store.ts: a
 * second press meanwhile is told it is running), and the mapping model's answer is kept the moment it is paid for, so a
 * Salesforce failure after it never pays again. Logs carry ids and codes only.
 */
import { sql } from 'drizzle-orm';
import { BookedAppointment, RecordTestDryRun } from '@cti/contracts';
import type { Db } from '@cti/db';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { costMicros, type TriageUsage } from '../ai/model.js';
import { TERMINAL_AI_CALL_STATUSES } from '../ai-calls/outcomes.js';
import { readUsers } from '../appointments/calendar.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { describeObject, type DescribeCache } from '../research/describe.js';
import { bookingSettings, outreachSettings } from '../settings.js';
import type { RequestContext } from '../tenancy/scope.js';
import { OUTCOME_WORDS, researchStatusOf } from '../writeback/context.js';
import { leadManagerFor } from '../writeback/convert.js';
import { readCurrent, writableFields, type WritableField } from '../writeback/fields.js';
import { MappingOutputError, type MappingModel } from '../writeback/mapping-model.js';
import { buildWritePlan } from '../writeback/plan.js';
import { changesFieldText, chatterText, type RenderInput } from '../writeback/render.js';
import { WRITEBACK_OUTCOMES } from '../writeback/store.js';
import { stripUrls } from '../writeback/words.js';
import {
  bookedWords, changeList, conversionWords, createdRecords, emptyDryRun, GONE_NOTE, notesOf, NOTHING_NOTE, UNMAPPED_NOTE, WRITEBACK_OFF_NOTE, writtenChanges, type Booking,
} from './dry-run-words.js';
import { claimDryRun, releaseDryRun, saveMapping, storeDryRun, storedMappingOf, type StoredMapping } from './dry-run-store.js';
import type { LimitRefusal } from './limits.js';

export interface DryRunDeps {
  db: Db;
  clients: SalesforceClientFactory;
  model: MappingModel | null;
  describes: DescribeCache;
  now: Date;
  log: RunnerLogger;
  /** APP_PUBLIC_URL: the Chatter post's "Call details" link opens the test page. */
  resultsBaseUrl: string;
}
export type DryRunResult =
  | { ok: true; dryRun: RecordTestDryRun }
  | { ok: false; error: 'not_found' | 'not_finished' | 'no_model' | 'running' | 'salesforce_error' | 'failed' }
  | { ok: false; refusal: LimitRefusal };

interface CallRow {
  id: string;
  org_id: string;
  dry_run: unknown;
  test_id: string;
  sf_object: 'Lead' | 'Opportunity';
  sf_record_id: string;
  research: unknown;
  ai_call_id: string | null;
  status: string | null;
  outcome: string | null;
  qualification: unknown;
  transcript: unknown;
  summary: string | null;
  appointment: unknown;
  callback_at: Date | string | null;
  ended_at: Date | string | null;
  org_settings: unknown;
}

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_AI_CALL_STATUSES);
const WRITES: ReadonlySet<string> = new Set(WRITEBACK_OUTCOMES);
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const dateOf = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Salesforce read that failed: the only failure the page words as "Salesforce didn't answer". */
class SalesforceReadError extends Error {
  constructor(override readonly cause: unknown) {
    super('salesforce read failed');
    this.name = 'SalesforceReadError';
  }
}
/** Marks a failure inside a Salesforce read as Salesforce's. */
async function sf<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new SalesforceReadError(err);
  }
}

/** The org's test call with its test, its ai_calls row (also found by key when the trigger's answer was lost) and settings. */
async function loadCall(db: Db, orgId: string, callId: string): Promise<CallRow | null> {
  const result = await db.execute(sql`
    select c.id, c.org_id, c.dry_run, t.id as test_id, t.sf_object, t.sf_record_id, t.research, a.id as ai_call_id, a.status, a.outcome,
           a.qualification, a.transcript, a.summary, a.appointment, a.callback_at, a.ended_at, o.settings as org_settings
    from ai_record_test_calls c
    join ai_record_tests t on t.id = c.record_test_id and t.org_id = c.org_id
    join organizations o on o.id = c.org_id
    left join ai_call_requests q on c.ai_call_id is null and q.org_id = c.org_id and q.idempotency_key = c.idempotency_key
    left join ai_calls a on a.id = coalesce(c.ai_call_id, q.ai_call_id) and a.org_id = c.org_id
    where c.id = ${callId}::uuid and c.org_id = ${orgId}::uuid`);
  return rows<CallRow>(result)[0] ?? null;
}

async function charge(deps: DryRunDeps, row: CallRow, usage: TriageUsage): Promise<void> {
  await addSpend(deps.db, row.org_id, deps.now, costMicros(usage.model, usage.inputTokens, usage.outputTokens));
}

/**
 * The seller's answers in the org's values: the stored ones when an earlier press paid for them; else one model call,
 * charged and kept at once. Null for a wrong number; failed when the model answered without them, or did not answer.
 */
async function mapAnswers(deps: DryRunDeps, row: CallRow, outcome: string, fields: ReadonlyMap<string, WritableField>, stored: StoredMapping | null): Promise<StoredMapping> {
  if (outcome === 'wrong_number') return { mapped: null, failed: false };
  if (stored) return stored;
  if (!deps.model) return { mapped: null, failed: true };
  const qualification = isObject(row.qualification) ? Object.fromEntries(Object.entries(row.qualification).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  const transcript = Array.isArray(row.transcript) ? row.transcript.filter((t): t is { role: string; text: string } => isObject(t) && typeof t.role === 'string' && typeof t.text === 'string') : [];
  let answer: Awaited<ReturnType<MappingModel['map']>>;
  try {
    answer = await deps.model.map({ sfObject: row.sf_object, outcome, qualification, transcript, summary: row.summary, fields: [...fields.values()] });
  } catch (err) {
    deps.log.warn({ callId: row.id, errName: errName(err) }, 'record-test: dry run answer mapping failed; status moves only');
    if (!(err instanceof MappingOutputError)) return { mapped: null, failed: true };
    await charge(deps, row, err.usage);
    const failed = { mapped: null, failed: true };
    await saveMapping(deps.db, row.org_id, row.id, failed);
    return failed;
  }
  const { usage, ...mapped } = answer;
  await charge(deps, row, usage);
  const kept = { mapped, failed: false };
  await saveMapping(deps.db, row.org_id, row.id, kept);
  return kept;
}

/** The appointment owner and, for a Lead with conversion on, the Lead Manager the conversion would set (reads only). */
async function bookingOf(row: CallRow, client: Awaited<ReturnType<SalesforceClientFactory>>, booked: BookedAppointment, priorOwner: string | null): Promise<Booking> {
  const converts = row.sf_object === 'Lead' && bookingSettings({ settings: row.org_settings }, []).convertLeads;
  const manager = converts ? await leadManagerFor(client, priorOwner, booked.specialistSfUserId) : null;
  const users = await readUsers(client, [...new Set([booked.specialistSfUserId, ...(manager ? [manager] : [])])]);
  const owner = users.get(booked.specialistSfUserId);
  const ownerName = owner?.name ?? 'the appointment owner';
  return { booked, ownerName, ownerFirstName: owner?.firstName ?? null, convertsWithLeadManager: manager === null ? null : (users.get(manager)?.name ?? "the Lead's owner") };
}

async function compute(deps: DryRunDeps, row: CallRow, outcome: string, stored: StoredMapping | null): Promise<RecordTestDryRun> {
  const client = await sf(() => deps.clients(row.org_id));
  const describe = await sf(() => describeObject(client, deps.describes, row.org_id, row.sf_object));
  const fields = writableFields(describe, row.sf_object);
  const current = await sf(() => readCurrent(client, row.sf_object, row.sf_record_id, [...fields.values()].map((f) => f.name), describe));
  if (current === null) return emptyDryRun('failed', GONE_NOTE);
  const { mapped, failed } = await mapAnswers(deps, row, outcome, fields, stored);
  const appointment = BookedAppointment.safeParse(row.appointment);
  const plan = buildWritePlan({
    sfObject: row.sf_object, outcome, mapped, current: current.values, researchStatus: researchStatusOf(row.research, row.sf_object), fields,
    appointment: appointment.success ? appointment.data : null, callbackAt: dateOf(row.callback_at), now: deps.now, converted: null, practice: false,
  });
  const booked = plan.result === 'appointment' ? (plan.appointment?.booked ?? null) : null;
  const booking = booked ? await sf(() => bookingOf(row, client, booked, current.ownerId)) : null;
  const created = createdRecords(row.sf_object, booking);
  const conversion = conversionWords(booking);
  const written = writtenChanges(plan);
  const base: Omit<RenderInput, 'applied' | 'summary' | 'appointmentWords'> = {
    at: dateOf(row.ended_at) ?? deps.now, outcomeWords: OUTCOME_WORDS[outcome] ?? outcome, aiCallId: row.ai_call_id!, plan,
    resultsUrl: `${deps.resultsBaseUrl.replace(/\/$/, '')}/test-record?id=${row.test_id}`,
    conversion: conversion && booking ? { leadName: current.name, ownerName: booking.ownerName, adopted: false } : null, conversionRefused: null,
  };
  // A real call posts nothing when it changed and created nothing and ended "other" (steps-write.ts chatter step).
  const posts = !(plan.result === 'other' && written.length === 0 && created.length === 0);
  return {
    status: 'ready',
    changes: changeList(plan),
    changesText: changesFieldText({ ...base, summary: null, appointmentWords: null, applied: { written, notWritten: [], created } }),
    chatterText: posts ? chatterText({ ...base, summary: stripUrls(row.summary), appointmentWords: bookedWords(booking), applied: { written, notWritten: [], created: [] } }) : null,
    wouldCreate: [...created, ...(posts ? ['Chatter post'] : [])],
    conversion,
    // 1D: with write-back off a real call writes none of this (it is offered no times, so books nothing either).
    note: notesOf([failed ? UNMAPPED_NOTE : null, outreachSettings({ settings: row.org_settings }).aiCallWriteback ? null : WRITEBACK_OFF_NOTE]),
  };
}

export async function dryRunTestCall(deps: DryRunDeps, ctx: RequestContext, callId: string): Promise<DryRunResult> {
  const row = await loadCall(deps.db, ctx.orgId, callId);
  if (!row) return { ok: false, error: 'not_found' };
  const saved = RecordTestDryRun.safeParse(row.dry_run);
  if (row.dry_run !== null && saved.success) return { ok: true, dryRun: saved.data };
  if (row.ai_call_id === null || row.status === null || !TERMINAL.has(row.status)) return { ok: false, error: 'not_finished' };
  const outcome = row.outcome ?? 'other';
  if (!WRITES.has(outcome)) return { ok: true, dryRun: await storeDryRun(deps.db, ctx.orgId, row.id, emptyDryRun('nothing', NOTHING_NOTE)) };
  // An earlier press's paid-for answers need neither the model nor budget.
  const paid = storedMappingOf(row.dry_run) !== null;
  if (!deps.model && !paid) return { ok: false, error: 'no_model' };
  if (!paid && (await spentTodayMicros(deps.db, ctx.orgId, deps.now)) >= budgetMicros(outreachSettings({ settings: row.org_settings }))) {
    return { ok: false, refusal: { code: 'AI_BUDGET_SPENT' } };
  }
  const claim = await claimDryRun(deps.db, ctx.orgId, row.id, deps.now);
  if (!claim.claimed) return claim.done ? { ok: true, dryRun: claim.done } : { ok: false, error: 'running' };
  let dryRun: RecordTestDryRun;
  try {
    dryRun = await compute(deps, row, outcome, claim.mapping);
  } catch (err) {
    await releaseDryRun(deps.db, ctx.orgId, row.id, deps.now).catch(() => {});
    if (err instanceof SalesforceReadError) {
      deps.log.warn({ orgId: ctx.orgId, callId: row.id, errName: errName(err.cause) }, 'record-test: dry run could not read Salesforce');
      return { ok: false, error: 'salesforce_error' };
    }
    deps.log.error({ orgId: ctx.orgId, callId: row.id, errName: errName(err) }, 'record-test: dry run failed');
    return { ok: false, error: 'failed' };
  }
  return { ok: true, dryRun: await storeDryRun(deps.db, ctx.orgId, row.id, dryRun) };
}
