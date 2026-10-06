/**
 * Plan 1D write-back steps 2-5, against `writeTarget(row)`: the appointment (Event, or the fallback hold + Task), the
 * conflict/refusal Task, the one PATCH (plan + booking moves + AI Last Call Changes), and the Chatter post. Each saves its
 * result before the next runs.
 */
import type { BookedAppointment } from '@cti/contracts';
import { soqlEscape } from '@cti/salesforce';
import { describeObject } from '../research/describe.js';
import { bookingSettings } from '../settings.js';
import { bookingPassed, bookOpportunity, createTaskOnce, holdForLead, PASSED_TASK_SUBJECT, taskFields, WriteRefusedError, type AppointmentResult } from './appointment.js';
import { CHANGES_FIELD, writableFields, type WritableField } from './fields.js';
import { keepUnedited, readFresh, type NotChanged } from './fresh.js';
import { patchDroppingRefused, without, type FieldRefusal } from './patch.js';
import type { Change, WritePlan } from './plan.js';
import { changesFieldText, chatterMarker, chatterText, ptWords } from './render.js';
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
  if (bookingPassed(a.booked, run.deps.now)) {
    // The time has passed (a late retry, an admin retry days later): nothing goes on the calendar; handled like a conflict.
    const result: AppointmentResult = { kind: 'expired' };
    return { run: await saveStep(run, 'appointment', { status: 'done', detail: 'expired', data: { result } }), result };
  }
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

/** The Task's words: the slot was taken or refused (an Opportunity), or the booked time passed (either object, I-1). */
function taskWords(run: RowRun, booked: BookedAppointment, appt: AppointmentResult): { subject: string; description: string } | null {
  const when = ptWords(new Date(booked.start));
  const call = `on an AI call (AI call ${run.row.aiCallId})`;
  if (appt.kind === 'expired') {
    const description = `The seller agreed to a ${KIND[booked.kind]} at ${when} ${call}, but that time passed before the write-back could save it, so nothing was put on the calendar. Call the seller to re-book.`;
    return { subject: PASSED_TASK_SUBJECT, description };
  }
  if (appt.kind !== 'conflict' && appt.kind !== 'refused') return null;
  const why = appt.kind === 'conflict' ? 'the calendar was taken' : `Salesforce refused the Event (${appt.code})`;
  return {
    subject: `AI booked a ${KIND[booked.kind]} for ${when} but ${why}: call the seller to set a time`,
    description: `The seller agreed to a ${KIND[booked.kind]} at ${when} ${call}, but ${why}. Call the seller to set a time.`,
  };
}

/**
 * Step 4 (run before the PATCH, so the changes text lists it): a Task to the appointment owner when an Opportunity's slot
 * was taken or refused, or when the booked time passed (on the Opportunity, or on the Lead that was not converted).
 */
export async function taskStep(run: RowRun, plan: WritePlan, appt: AppointmentResult | null): Promise<RowRun> {
  if (isDone(run, 'task')) return run;
  const a = plan.appointment;
  const onOpportunity = a?.kind === 'opportunity_event';
  const words = a && appt && (onOpportunity || appt.kind === 'expired') ? taskWords(run, a.booked, appt) : null;
  if (!a || words === null) return saveStep(run, 'task', { status: 'skipped' });
  const target = writeTarget(run.row);
  const record = target.sobject === 'Lead' ? { whatId: null, whoId: target.id } : { whatId: target.id, whoId: null };
  try {
    const taskId = await createTaskOnce(run.client, taskFields({ ...record, ownerId: a.booked.specialistSfUserId, ...words, today: ptToday(run.deps.now) }));
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

/** I-3: the patch and its changes less what a rep changed since the plan, from a read made just before every PATCH. */
async function unedited(run: RowRun, writable: ReadonlyMap<string, WritableField>, patch: Record<string, unknown>, changes: Change[]) {
  if (Object.keys(patch).length === 0) return { base: patch, changes, notChanged: [] as NotChanged[] };
  const target = writeTarget(run.row);
  const statusField = writable.get(target.sobject === 'Lead' ? 'Status' : 'StageName')?.name ?? null;
  const fresh = await readFresh(run.client, target.sobject, target.id, [...Object.keys(patch), ...(statusField ? [statusField] : [])]);
  const saved = planData(run).status;
  const planStatus = saved === undefined ? undefined : typeof saved === 'string' ? saved : null;
  const kept = keepUnedited({ patch, changes, fresh, statusField, planStatus });
  const held = new Set(kept.notChanged.map((n) => n.field.toLowerCase()));
  return { base: kept.patch, changes: changes.filter((c) => !held.has(c.field.toLowerCase())), notChanged: kept.notChanged };
}

/** Step 3: one PATCH with the plan, the booking moves and AI Last Call Changes; refused fields dropped and listed. */
export async function fieldsStep(run: RowRun, plan: WritePlan, appt: AppointmentResult | null): Promise<RowRun> {
  if (isDone(run, 'fields')) return run;
  const target = writeTarget(run.row);
  const a = plan.appointment;
  const booked = appt?.kind === 'created' || appt?.kind === 'existing';
  const bookingPatch = a?.kind === 'opportunity_event' ? (booked ? a.onBooked : a.onConflict) : {};
  // The booking's stage and rating moves first, like the status moves of any other plan.
  const planned: Change[] = [...(a?.kind === 'opportunity_event' ? (booked ? a.onBookedChanges : a.onConflictChanges) : []), ...plan.changes];
  const earlier = [...notCarried(run), ...(plan.contactDnc ? await contactDnc(run, target.id) : [])];
  const describe = await describeObject(run.client, run.deps.describes, run.row.orgId, target.sobject);
  const writable = writableFields(describe, target.sobject);
  const { base, changes, notChanged } = await unedited(run, writable, { ...plan.patch, ...bookingPatch }, planned);
  const label = (key: string): { label: string; field: string } => {
    const c = changes.find((x) => x.field.toLowerCase() === key.toLowerCase());
    return c ? { label: c.label, field: c.field } : { label: key.toLowerCase() === CHANGES_FIELD.toLowerCase() ? 'AI Last Call Changes' : key, field: key };
  };
  const toNotWritten = (r: FieldRefusal): NotWritten => ({ ...label(r.field), reason: refusedWords(r.code), code: r.code });
  const changesName = writable.get(CHANGES_FIELD)?.name ?? null;
  const owner = await ownerOf(run);
  const created = createdLines({ plan, result: appt, owner, taskId: run.row.steps.task?.taskId ?? null });
  const text = (written: Change[], notWritten: NotWritten[]) =>
    changesFieldText(renderInputFor(run, plan, { written, notWritten, created, notChanged }, { appointmentWords: null, owner, summary: null }));

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
  return saveStep(run, 'fields', { status: 'done', data: { written, notWritten, notChanged } });
}

/** SOQL dateTime literal, whole seconds UTC. */
const soqlDateTime = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Our post on the record from an earlier attempt whose answer was lost: found by the call marker on its first line (M4). */
async function findOurPost(run: RowRun, parentId: string): Promise<string | null> {
  const since = run.ctx.call.endedAt === null ? '' : ` AND CreatedDate >= ${soqlDateTime(run.ctx.call.endedAt)}`;
  const rows = await run.client.query<{ Id?: unknown; Body?: unknown }>(
    `SELECT Id, Body FROM FeedItem WHERE ParentId = '${soqlEscape(parentId)}' AND Type = 'TextPost'${since} ORDER BY CreatedDate DESC LIMIT 50`,
  );
  const marker = `${chatterMarker(run.row.aiCallId)} `;
  const ours = rows.find((r) => typeof r.Body === 'string' && r.Body.startsWith(marker));
  return typeof ours?.Id === 'string' ? ours.Id : null;
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
  const found = await findOurPost(run, target.id);
  if (found !== null) return saveStep(run, 'chatter', { status: 'done', detail: 'found the post an earlier attempt made' }, { sfFeedItemId: found });
  const [r] = await run.client.createRecords([{ sobject: 'FeedItem', fields: { ParentId: target.id, Body: body, Type: 'TextPost', IsRichText: false } }]);
  if (r?.success && r.id) return saveStep(run, 'chatter', { status: 'done' }, { sfFeedItemId: r.id });
  const code = r?.errors[0]?.statusCode ?? 'UNKNOWN_ERROR';
  throwIfNotARefusal(code);
  return saveStep(run, 'chatter', { status: 'failed', detail: code });
}
