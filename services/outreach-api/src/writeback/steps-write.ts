/**
 * Plan 1D write-back steps 2-5, against `writeTarget(row)`: the appointment (Event, or the fallback hold + Task), the
 * conflict/refusal Task, the one PATCH (plan + booking moves + AI Last Call Changes), and the Chatter post. Each saves its
 * result before the next runs.
 */
import { soqlEscape } from '@cti/salesforce';
import { describeObject } from '../research/describe.js';
import { bookingSettings } from '../settings.js';
import { bookOpportunity, createTaskOnce, holdForLead, taskFields, WriteRefusedError, type AppointmentResult } from './appointment.js';
import { CHANGES_FIELD, writableFields } from './fields.js';
import { patchDroppingRefused, without, type FieldRefusal } from './patch.js';
import type { Change, WritePlan } from './plan.js';
import { changesFieldText, chatterText, ptWords } from './render.js';
import { isDone, ownerOf, ptToday, RecordGoneError, saveStep, throwIfNotARefusal, type RowRun } from './row-run.js';
import { writeTarget } from './store.js';
import { appointmentWords, createdLines, refusedWords, renderInputFor, sellerTimeZone, stripUrls, writtenChanges, type NotWritten } from './words.js';

const KIND = { phone: 'phone call', walkthrough: 'walkthrough' } as const;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const planData = (run: RowRun): Record<string, unknown> => run.row.steps.plan?.data ?? {};

/** The appointment result saved by step 2 (on a retry), or null. */
export function savedAppointment(run: RowRun): AppointmentResult | null {
  const r = run.row.steps.appointment?.data?.result;
  return r !== null && typeof r === 'object' && 'kind' in r ? (r as AppointmentResult) : null;
}

/** Step 2: the Event on the Opportunity (re-checked), or on the fallback path the hold + the "convert and book" Task. */
export async function appointmentStep(run: RowRun, plan: WritePlan): Promise<{ run: RowRun; result: AppointmentResult | null }> {
  if (isDone(run, 'appointment')) return { run, result: savedAppointment(run) };
  const a = plan.appointment;
  if (a === null) return { run: await saveStep(run, 'appointment', { status: 'skipped' }), result: null };
  const owner = await ownerOf(run);
  const target = writeTarget(run.row);
  if (a.kind === 'opportunity_event') {
    const booking = bookingSettings({ settings: run.ctx.orgSettings }, run.deps.defaultSpecialists);
    const result = await bookOpportunity(run.client, {
      oppId: target.id,
      booked: a.booked,
      location: str(planData(run).address),
      aiCallId: run.row.aiCallId,
      sellerTimeZone: sellerTimeZone(run.ctx.call.toE164),
      bufferMinutes: booking.walkthrough.bufferMinutes,
      ...(owner ? { ownerTimeZone: owner.timeZone } : {}),
    });
    const eventId = result.kind === 'created' || result.kind === 'existing' ? result.eventId : undefined;
    const status = result.kind === 'refused' ? 'failed' : 'done';
    const next = await saveStep(run, 'appointment', { status, detail: result.kind === 'refused' ? result.code : result.kind, ...(eventId ? { eventId } : {}), data: { result } }, eventId ? { sfEventId: eventId } : {});
    return { run: next, result };
  }
  const convert = run.row.steps.convert;
  const result = await holdForLead(run.client, {
    leadId: target.id,
    leadName: str(planData(run).name),
    booked: a.booked,
    aiCallId: run.row.aiCallId,
    ownerName: owner?.name ?? 'the appointment owner',
    reason: convert?.detail ?? 'the Lead was not converted',
    today: ptToday(run.deps.now),
  });
  const ids = result.kind === 'lead_hold' ? result : { eventId: null, taskId: null };
  const failed = ids.eventId === null ? 'HOLD_NOT_CREATED' : ids.taskId === null ? 'TASK_NOT_CREATED' : null;
  const next = await saveStep(
    run,
    'appointment',
    { status: failed ? 'failed' : 'done', detail: failed ?? 'lead_hold', ...(ids.eventId ? { eventId: ids.eventId } : {}), ...(ids.taskId ? { taskId: ids.taskId } : {}), data: { result } },
    { ...(ids.eventId ? { sfEventId: ids.eventId } : {}), ...(ids.taskId ? { sfTaskId: ids.taskId } : {}) },
  );
  return { run: next, result };
}

/** Step 4 (run before the PATCH, so the changes text lists it): an Opportunity whose slot was taken or refused gets a Task to the owner. */
export async function taskStep(run: RowRun, plan: WritePlan, appt: AppointmentResult | null): Promise<RowRun> {
  if (isDone(run, 'task')) return run;
  const booked = plan.appointment?.booked;
  if (!booked || plan.appointment?.kind !== 'opportunity_event' || (appt?.kind !== 'conflict' && appt?.kind !== 'refused')) return saveStep(run, 'task', { status: 'skipped' });
  const when = ptWords(new Date(booked.start));
  const why = appt.kind === 'conflict' ? 'the calendar was taken' : `Salesforce refused the Event (${appt.code})`;
  const subject = `AI booked a ${KIND[booked.kind]} for ${when} but ${why}: call the seller to set a time`;
  const description = `The seller agreed to a ${KIND[booked.kind]} at ${when} on an AI call (AI call ${run.row.aiCallId}), but ${why}. Call the seller to set a time.`;
  try {
    const taskId = await createTaskOnce(run.client, taskFields({ whatId: writeTarget(run.row).id, whoId: null, ownerId: booked.specialistSfUserId, subject, description, today: ptToday(run.deps.now) }));
    return saveStep(run, 'task', { status: 'done', taskId }, { sfTaskId: taskId });
  } catch (err) {
    if (!(err instanceof WriteRefusedError)) throw err;
    return saveStep(run, 'task', { status: 'failed', detail: err.code });
  }
}

/** spec §3.4 step 3: an Opportunity's do-not-call also sets DoNotCall on its primary contact. A failure is recorded, not thrown. */
async function contactDnc(run: RowRun, oppId: string): Promise<NotWritten[]> {
  const refused = (code: string): NotWritten[] => [{ label: 'Contact Do Not Call', reason: refusedWords(code), field: 'DoNotCall', code }];
  const rows = await run.client.query<{ ContactId?: unknown }>(`SELECT ContactId FROM OpportunityContactRole WHERE OpportunityId = '${soqlEscape(oppId)}' AND IsPrimary = true LIMIT 1`);
  const contactId = str(rows[0]?.ContactId);
  if (contactId === null) return [];
  try {
    const result = await patchDroppingRefused(run.client, 'Contact', contactId, (dropped) => without({ DoNotCall: true }, dropped), 0);
    const code = result.refusals[0]?.code ?? result.recordError?.code;
    return code === undefined ? [] : refused(code);
  } catch (err) {
    if (err instanceof RecordGoneError) return refused(err.code);
    throw err;
  }
}

/** The fields the conversion's carry PATCH could not write, as "Not written" entries. */
function notCarried(run: RowRun): NotWritten[] {
  const raw = run.row.steps.convert?.data?.notCarried;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => (r && typeof r.field === 'string' && typeof r.code === 'string' ? [{ label: r.field, reason: refusedWords(r.code), field: r.field, code: r.code }] : []));
}

/** Step 3: one PATCH with the plan, the booking moves and AI Last Call Changes; refused fields dropped and listed. */
export async function fieldsStep(run: RowRun, plan: WritePlan, appt: AppointmentResult | null): Promise<RowRun> {
  if (isDone(run, 'fields')) return run;
  const target = writeTarget(run.row);
  const a = plan.appointment;
  const booked = appt?.kind === 'created' || appt?.kind === 'existing';
  const bookingPatch = a?.kind === 'opportunity_event' ? (booked ? a.onBooked : a.onConflict) : {};
  // The booking's stage and rating moves first, like the status moves of any other plan.
  const changes: Change[] = [...(a?.kind === 'opportunity_event' ? (booked ? a.onBookedChanges : a.onConflictChanges) : []), ...plan.changes];
  const base = { ...plan.patch, ...bookingPatch };
  const label = (key: string): { label: string; field: string } => {
    const c = changes.find((x) => x.field.toLowerCase() === key.toLowerCase());
    return c ? { label: c.label, field: c.field } : { label: key.toLowerCase() === CHANGES_FIELD.toLowerCase() ? 'AI Last Call Changes' : key, field: key };
  };
  const toNotWritten = (r: FieldRefusal): NotWritten => ({ ...label(r.field), reason: refusedWords(r.code), code: r.code });
  const earlier = [...notCarried(run), ...(plan.contactDnc ? await contactDnc(run, target.id) : [])];
  const describe = await describeObject(run.client, run.deps.describes, run.row.orgId, target.sobject);
  const changesName = writableFields(describe, target.sobject).get(CHANGES_FIELD)?.name ?? null;
  const owner = await ownerOf(run);
  const created = createdLines({ plan, result: appt, owner, taskId: run.row.steps.task?.taskId ?? null });
  const text = (written: Change[], notWritten: NotWritten[]) =>
    changesFieldText(renderInputFor(run, plan, { written, notWritten, created }, { appointmentWords: null, owner, summary: null }));

  const result = await patchDroppingRefused(run.client, target.sobject, target.id, (dropped, refusals) => {
    const written = writtenChanges(changes, dropped);
    const fields = { ...base, ...(changesName ? { [changesName]: text(written, [...earlier, ...refusals.map(toNotWritten)]) } : {}) };
    return without(fields, dropped);
  });
  let written = writtenChanges(changes, new Set(result.refusals.map((r) => r.field.toLowerCase())));
  let notWritten = [...earlier, ...result.refusals.map(toNotWritten)];
  if (result.recordError !== null) {
    // A whole-record refusal: nothing of the patch was written. Once more with only the changes field, so the record says so.
    const code = result.recordError.code;
    const refusedKeys = new Set(result.refusals.map((r) => r.field.toLowerCase()));
    notWritten = [...notWritten, ...Object.keys(base).filter((k) => !refusedKeys.has(k.toLowerCase())).map((k) => ({ ...label(k), reason: refusedWords(code), code }))];
    written = [];
    if (changesName) {
      const [only] = await run.client.updateRecords([{ sobject: target.sobject, id: target.id, fields: { [changesName]: text(written, notWritten) } }]);
      if (only && !only.success) throwIfNotARefusal(only.errors[0]?.statusCode ?? 'UNKNOWN_ERROR');
    }
  }
  return saveStep(run, 'fields', { status: 'done', data: { written, notWritten } });
}

/** Step 5: one FeedItem on the record written to (the new Opportunity after a conversion), unless there is nothing to say. */
export async function chatterStep(run: RowRun, plan: WritePlan, appt: AppointmentResult | null): Promise<RowRun> {
  if (isDone(run, 'chatter')) return run;
  const data = run.row.steps.fields?.data ?? {};
  const written = (Array.isArray(data.written) ? data.written : []) as Change[];
  const notWritten = (Array.isArray(data.notWritten) ? data.notWritten : []) as NotWritten[];
  const createdAny = run.row.sfEventId !== null || run.row.sfTaskId !== null || run.row.convertedOpportunityId !== null;
  if (plan.result === 'other' && written.length === 0 && !createdAny) return saveStep(run, 'chatter', { status: 'skipped', detail: 'nothing to post' });
  const owner = await ownerOf(run);
  const booked = plan.appointment?.booked;
  const words = booked ? appointmentWords({ booked, result: appt, owner, address: str(planData(run).address), sellerZone: sellerTimeZone(run.ctx.call.toE164) }) : null;
  const body = chatterText(renderInputFor(run, plan, { written, notWritten, created: [] }, { appointmentWords: words, owner, summary: stripUrls(run.ctx.call.summary) }));
  const target = writeTarget(run.row);
  const [r] = await run.client.createRecords([{ sobject: 'FeedItem', fields: { ParentId: target.id, Body: body, Type: 'TextPost', IsRichText: false } }]);
  if (r?.success && r.id) return saveStep(run, 'chatter', { status: 'done' }, { sfFeedItemId: r.id });
  const code = r?.errors[0]?.statusCode ?? 'UNKNOWN_ERROR';
  throwIfNotARefusal(code);
  return saveStep(run, 'chatter', { status: 'failed', detail: code });
}
