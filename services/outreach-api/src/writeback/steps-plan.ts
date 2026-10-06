/**
 * Plan 1D write-back steps 0.5 and 1: convert a Lead that booked (spec §5.7), then plan the write against the record the
 * steps write to (the new Opportunity after a conversion). The plan is built once and frozen on the row.
 */
import { soqlEscape } from '@cti/salesforce';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { costMicros, type TriageUsage } from '../ai/model.js';
import { describeObject } from '../research/describe.js';
import { bookingSettings } from '../settings.js';
import { createTaskOnce, taskFields, WriteRefusedError } from './appointment.js';
import { CARRY_FIELDS, carryPatch, convertStep, LEAD_MANAGER_FIELD, leadManagerFor, type ConvertOutcome } from './convert.js';
import { readCurrent, writableFields, type WritableField } from './fields.js';
import { MappingOutputError, type MappedAnswers } from './mapping-model.js';
import { patchDroppingRefused, without } from './patch.js';
import { buildWritePlan, StoredWritePlan, type WritePlan } from './plan.js';
import { ptWords } from './render.js';
import { isAppointmentCall, ptToday, saveStep, type RowRun } from './row-run.js';
import { saveProgress, writeTarget } from './store.js';

type Row = Record<string, unknown>;
export type ConvertStepResult = 'converted' | 'fallback' | 'no_opportunity' | 'gone' | 'not_needed';

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The PATCH carrying what the lead mapping drops, and the Lead Manager, onto the new Opportunity (before the Event). */
async function carry(run: RowRun, oppId: string, lead: Row): Promise<{ carried: string[]; notCarried: Array<{ field: string; code: string }> }> {
  const { client, deps } = run;
  const owner = run.ctx.call.appointment!.specialistSfUserId;
  const leadManager = await leadManagerFor(client, str(lead.OwnerId), owner);
  const d = await describeObject(client, deps.describes, run.row.orgId, 'Opportunity');
  const wanted = new Set([...CARRY_FIELDS, LEAD_MANAGER_FIELD].map((f) => f.toLowerCase()));
  const present = d.fields.filter((f) => wanted.has(f.name.toLowerCase()));
  const select = ['Id', ...present.map((f) => f.name)];
  const [opp] = await client.query<Row>(`SELECT ${select.join(', ')} FROM Opportunity WHERE Id = '${soqlEscape(oppId)}' LIMIT 1`);
  const updateable = new Set(present.filter((f) => f.updateable === true).map((f) => f.name));
  const patch = carryPatch({ lead, opp: opp ?? {}, updateable, leadManager });
  const result = await patchDroppingRefused(client, 'Opportunity', oppId, (dropped) => without(patch, dropped));
  const refusedKeys = new Set(result.refusals.map((r) => r.field));
  const notCarried = [
    ...result.refusals,
    ...(result.recordError ? Object.keys(patch).filter((k) => !refusedKeys.has(k)).map((field) => ({ field, code: result.recordError!.code })) : []),
  ];
  return { carried: Object.keys(result.sent ?? {}), notCarried };
}

/** "Converted without an Opportunity": a Task to the appointment owner on the Account; the row then ends partial. */
async function noOpportunityTask(run: RowRun, accountId: string | null): Promise<RowRun> {
  const booked = run.ctx.call.appointment!;
  const kind = booked.kind === 'phone' ? 'phone call' : 'walkthrough';
  const subject = `AI booked a ${kind} for ${ptWords(new Date(booked.start))}; this Lead was already converted without an Opportunity — create one and book it`;
  const description = `The AI assistant booked a ${kind} on a call (AI call ${run.row.aiCallId}) for Lead ${run.row.sfRecordId}, which someone had already converted without an Opportunity. Create the Opportunity and book the time.`;
  let taskId: string | null = null;
  try {
    taskId = await createTaskOnce(run.client, taskFields({ whatId: accountId, whoId: null, ownerId: booked.specialistSfUserId, subject, description, today: ptToday(run.deps.now) }));
  } catch (err) {
    if (!(err instanceof WriteRefusedError)) throw err;
  }
  return saveStep(run, 'convert', { status: 'failed', detail: 'CONVERTED_WITHOUT_OPPORTUNITY', ...(taskId ? { taskId } : {}) }, taskId ? { sfTaskId: taskId } : {});
}

async function onConverted(run: RowRun, outcome: Extract<ConvertOutcome, { opportunityId: string }>, lead: Row): Promise<RowRun> {
  // The ids first, the moment Salesforce has answered: a retry from here on never converts again.
  const ids = {
    convertedOpportunityId: outcome.opportunityId,
    ...(outcome.accountId ? { convertedAccountId: outcome.accountId } : {}),
    ...(outcome.contactId ? { convertedContactId: outcome.contactId } : {}),
  };
  await saveProgress(run.deps.db, run.row.id, ids, run.deps.now);
  let next: RowRun = { ...run, row: { ...run.row, convertedOpportunityId: run.row.convertedOpportunityId ?? outcome.opportunityId } };
  const ours = outcome.kind === 'converted' || outcome.ours;
  const carried = ours ? await carry(next, outcome.opportunityId, lead) : { carried: [], notCarried: [] };
  const detail = outcome.kind === 'converted' ? 'converted' : ours ? 'adopted our earlier conversion' : 'already converted';
  next = await saveStep(next, 'convert', {
    status: 'done',
    detail,
    data: { leadName: str(lead.Name), priorOwnerId: str(lead.OwnerId), repConverted: !ours, ...carried },
  });
  return next;
}

/** Step 0.5: only a Lead whose call booked an appointment; anything else is `not_needed`. */
export async function convertStepRun(run: RowRun): Promise<{ run: RowRun; result: ConvertStepResult }> {
  if (run.row.sfObject !== 'Lead' || !isAppointmentCall(run)) return { run, result: 'not_needed' };
  const saved = run.row.steps.convert?.status;
  if (saved === 'done' && run.row.convertedOpportunityId !== null) return { run, result: 'converted' };
  if (saved === 'failed' || saved === 'skipped') return { run, result: run.row.steps.convert?.detail === 'CONVERTED_WITHOUT_OPPORTUNITY' ? 'no_opportunity' : 'fallback' };

  if (!bookingSettings({ settings: run.ctx.orgSettings }, run.deps.defaultSpecialists).convertLeads) {
    return { run: await saveStep(run, 'convert', { status: 'skipped', detail: 'conversion is off' }), result: 'fallback' };
  }
  const booked = run.ctx.call.appointment!;
  const leadDescribe = await describeObject(run.client, run.deps.describes, run.row.orgId, 'Lead');
  const { outcome, lead } = await convertStep(run.client, { leadId: run.row.sfRecordId, ownerId: booked.specialistSfUserId, callEndedAt: run.ctx.call.endedAt ?? run.deps.now, leadDescribe });
  switch (outcome.kind) {
    case 'gone':
      return { run, result: 'gone' };
    case 'refused':
      run.deps.log.warn({ writebackId: run.row.id, aiCallId: run.row.aiCallId, step: 'convert', code: outcome.code }, 'ai_call.writeback: Salesforce refused the Lead conversion; taking the fallback');
      return { run: await saveStep(run, 'convert', { status: 'failed', detail: `${outcome.code}: ${outcome.message}` }), result: 'fallback' };
    case 'no_opportunity':
      return { run: await noOpportunityTask(run, outcome.accountId), result: 'no_opportunity' };
    default:
      return { run: await onConverted(run, outcome, lead ?? {}), result: 'converted' };
  }
}

/** Charges the tenant for one mapping call and records its tokens on the row. */
async function charge(run: RowRun, usage: TriageUsage): Promise<void> {
  await addSpend(run.deps.db, run.row.orgId, run.deps.now, costMicros(usage.model, usage.inputTokens, usage.outputTokens));
  await saveProgress(run.deps.db, run.row.id, { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, run.deps.now);
}

/** The seller's answers in the org's values; null when there is nothing to map, no model, or the model failed; 'budget' when spent. */
async function mapAnswers(run: RowRun, sfObject: 'Lead' | 'Opportunity', fields: ReadonlyMap<string, WritableField>): Promise<MappedAnswers | null | 'budget'> {
  const { deps, ctx } = run;
  if (ctx.call.outcome === 'wrong_number' || deps.model === null) return null;
  if ((await spentTodayMicros(deps.db, run.row.orgId, deps.now)) >= budgetMicros(ctx.settings)) {
    // A booked appointment must reach the calendar now: it goes ahead without the mapping (said in the changes text).
    // Anything else waits for the next UTC day (spec §8).
    if (isAppointmentCall(run)) return null;
    return 'budget';
  }
  try {
    const out = await deps.model.map({ sfObject, outcome: ctx.call.outcome, qualification: ctx.call.qualification, transcript: ctx.call.transcript, summary: ctx.call.summary, fields: [...fields.values()] });
    await charge(run, out.usage);
    const { usage: _usage, ...mapped } = out;
    return mapped;
  } catch (err) {
    if (err instanceof MappingOutputError) await charge(run, err.usage);
    // Not retried: the status moves do not need the model (spec §8); fill-blanks are skipped and say so.
    deps.log.warn({ writebackId: run.row.id, step: 'plan', errName: errName(err) }, 'ai_call.writeback: the answer mapping failed; writing without it');
    return null;
  }
}

/** Step 1: the frozen plan, or a new one against the target's fresh describe and values. */
export async function planStep(run: RowRun): Promise<{ kind: 'plan'; run: RowRun; plan: WritePlan } | { kind: 'gone' } | { kind: 'budget' }> {
  if (run.row.plan !== null) return { kind: 'plan', run, plan: StoredWritePlan.parse(run.row.plan) };
  const target = writeTarget(run.row);
  const describe = await describeObject(run.client, run.deps.describes, run.row.orgId, target.sobject);
  const fields = writableFields(describe, target.sobject);
  const current = await readCurrent(run.client, target.sobject, target.id, [...fields.values()].map((f) => f.name), describe);
  if (current === null) return { kind: 'gone' };
  const mapped = await mapAnswers(run, target.sobject, fields);
  if (mapped === 'budget') return { kind: 'budget' };
  const converted = run.row.convertedOpportunityId !== null;
  const plan = buildWritePlan({
    sfObject: target.sobject,
    outcome: run.ctx.call.outcome,
    mapped,
    current: current.values,
    researchStatus: converted ? null : run.ctx.researchStatus,
    fields,
    appointment: run.ctx.call.appointment,
    callbackAt: run.ctx.call.callbackAt,
    now: run.deps.now,
    converted: converted ? { fromLeadId: run.row.sfRecordId } : null,
    practice: run.ctx.call.practice,
  });
  const next = await saveStep(run, 'plan', { status: 'done', data: { address: current.address, name: current.name } }, { plan });
  return { kind: 'plan', run: next, plan };
}
