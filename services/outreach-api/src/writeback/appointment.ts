/**
 * Plan 1D write-back, the appointment at write time (spec §5.4). An Event on the Opportunity, owned by the appointment owner
 * (Grant Golden, whoever owns the Opportunity), made the way reps make them so the org's consultation flows run. Before it
 * is made: one we already made is looked for (a retry never doubles it), and the owner's calendar is re-checked with the same
 * conflict rule the offer used (D-11).
 *
 * The fallback (a booked Lead Salesforce would not convert, or conversion is off) is a plain hold on the owner's calendar,
 * which no consultation flow fires on, plus an urgent "convert it and book it" Task to the owner.
 */
import type { BookedAppointment } from '@cti/contracts';
import { SalesforceApiError, soqlEscape, type CompositeResult, type SalesforceClient } from '@cti/salesforce';
import { DEFAULT_OWNER_TIME_ZONE, readBusy } from '../appointments/calendar.js';
import { conflicts } from '../appointments/slots.js';
import { SF_ID } from '../campaigns/records.js';
import { cutUtf16 } from '../research/text.js';
import { AI_OUTREACH_ORIGIN } from './fields.js';
import { ptWords } from './render.js';

export type AppointmentResult =
  | { kind: 'created' | 'existing'; eventId: string }
  | { kind: 'conflict' }
  /**
   * The booked time had passed when the row ran (Fix 1, I-1): nothing is put on the calendar; handled like a conflict.
   * `holdId`: a Lead hold an earlier attempt made at that time, still on the calendar (sweep D-25 N1).
   */
  | { kind: 'expired'; holdId?: string }
  | { kind: 'refused'; code: string }
  /** A null id was refused; its code is kept so the changes text and the post can say so (final review I-1). */
  | { kind: 'lead_hold'; eventId: string | null; taskId: string | null; holdCode?: string; taskCode?: string };

/**
 * The booked time has come by `now` (its START, sweep D-25 N4: an appointment already under way is as good as missed): no
 * Event, hold or conversion is made for it (Fix 1, I-1).
 */
export const bookingPassed = (booked: BookedAppointment, now: Date): boolean => new Date(booked.start).getTime() <= now.getTime();

/** The Task subject when the booked time passed before the write-back could save it (Fix 1, I-1). */
export const PASSED_TASK_SUBJECT = 'Appointment time passed before it could be saved — call the seller to re-book';

/** Salesforce refused a create for good; `code` is its first statusCode. */
export class WriteRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WriteRefusedError';
  }
}

const ORIGIN_FIELD = 'CTI_Origin__c';
const SUBJECT_MAX = 255;
const MIN_MS = 60_000;
const SUBJECTS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'Phone Consultation', walkthrough: 'Property Consultation' };
const KIND_WORDS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'phone call', walkthrough: 'walkthrough' };

/** SOQL dateTime literal: UTC, whole seconds (Salesforce stores Event times to the second). */
const soqlDateTime = (iso: string): string => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
const capped = (s: string, max: number): string => (s.length > max ? cutUtf16(s, max) : s);

function checkId(id: string, what: string): string {
  if (!SF_ID.test(id)) throw new RangeError(`${what} is not a Salesforce id`);
  return id;
}

/** "Seller's note: … ." with a full stop unless the note already ends a sentence. */
function sentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** spec §5.4: the Event a rep would make, owned by the appointment owner. */
export function opportunityEventFields(i: { oppId: string; booked: BookedAppointment; location: string | null; aiCallId: string; sellerTimeZone: string | null }): Record<string, unknown> {
  const { booked } = i;
  const note = oneLine(booked.note);
  const location = i.location === null ? '' : oneLine(i.location);
  const walkthrough = booked.kind === 'walkthrough';
  const description = [
    `Booked by the AI assistant on a call (AI call ${i.aiCallId}).`,
    ...(note === '' ? [] : [sentence(`Seller's note: ${note}`)]),
    ...(i.sellerTimeZone === null ? [] : [`Seller's time zone: ${i.sellerTimeZone}.`]),
    ...(walkthrough && booked.addressConfirmed ? ['Address confirmed with the seller.'] : []),
  ].join(' ');
  return {
    Subject: SUBJECTS[booked.kind],
    WhatId: i.oppId,
    OwnerId: booked.specialistSfUserId,
    StartDateTime: booked.start,
    EndDateTime: booked.end,
    IsAllDayEvent: false,
    ShowAs: 'Busy',
    ...(walkthrough && location !== '' ? { Location: capped(location, 255) } : {}),
    Description: description,
    [ORIGIN_FIELD]: AI_OUTREACH_ORIGIN,
  };
}

/** The fallback hold: no WhoId or WhatId and no consultation Subject, so no consultation flow fires; a rep can delete it. */
export function leadHoldFields(i: { booked: BookedAppointment; leadName: string | null; leadId: string; aiCallId: string }): Record<string, unknown> {
  const name = i.leadName === null || oneLine(i.leadName) === '' ? 'the Lead' : oneLine(i.leadName);
  return {
    Subject: capped(`Hold: AI-booked ${KIND_WORDS[i.booked.kind]} – convert ${name}`, SUBJECT_MAX),
    OwnerId: i.booked.specialistSfUserId,
    StartDateTime: i.booked.start,
    EndDateTime: i.booked.end,
    IsAllDayEvent: false,
    ShowAs: 'Busy',
    Description: `Held by the AI assistant for Lead ${i.leadId} (AI call ${i.aiCallId}). The Lead could not be converted: convert it, book the appointment on its Opportunity, then delete this hold.`,
    [ORIGIN_FIELD]: AI_OUTREACH_ORIGIN,
  };
}

/** An urgent Task, due today (PT), owned by `ownerId`. Only the ids given are set. */
export function taskFields(i: { whatId: string | null; whoId: string | null; ownerId: string; subject: string; description: string; today: string }): Record<string, unknown> {
  return {
    Subject: capped(oneLine(i.subject), SUBJECT_MAX),
    Description: i.description,
    OwnerId: i.ownerId,
    ...(i.whatId === null ? {} : { WhatId: i.whatId }),
    ...(i.whoId === null ? {} : { WhoId: i.whoId }),
    Status: 'Open',
    Priority: 'High',
    ActivityDate: i.today,
    [ORIGIN_FIELD]: AI_OUTREACH_ORIGIN,
  };
}

const isOriginRefusal = (r: CompositeResult): boolean =>
  r.errors.some((e) => e.statusCode.startsWith('INVALID_FIELD') && (e.message.includes(ORIGIN_FIELD) || (e.fields ?? []).includes(ORIGIN_FIELD)));

/** sObject Collections may refuse an unknown or hidden field for the whole request (HTTP 400) rather than per record. */
const isOriginRequestRefusal = (err: unknown): boolean =>
  err instanceof SalesforceApiError && err.status === 400 && /INVALID_FIELD/.test(err.message) && err.message.includes(ORIGIN_FIELD);

/** One create; when Salesforce does not know CTI_Origin__c (per record, or for the whole request: D-23 M6), once more without it. */
async function createOne(client: SalesforceClient, sobject: string, fields: Record<string, unknown>): Promise<CompositeResult> {
  const unknown: CompositeResult = { success: false, errors: [{ statusCode: 'UNKNOWN_ERROR', message: '' }] };
  try {
    const [first] = await client.createRecords([{ sobject, fields }]);
    if (!first || first.success || !isOriginRefusal(first)) return first ?? unknown;
  } catch (err) {
    if (!isOriginRequestRefusal(err)) throw err;
  }
  const { [ORIGIN_FIELD]: _origin, ...rest } = fields;
  const [second] = await client.createRecords([{ sobject, fields: rest }]);
  return second ?? unknown;
}

/** The first row's Id; when the org lacks CTI_Origin__c, the same lookup without it. */
async function findOne(client: SalesforceClient, soql: (withOrigin: boolean) => string): Promise<string | null> {
  try {
    const rows = await client.query<{ Id?: unknown }>(soql(true));
    return typeof rows[0]?.Id === 'string' ? rows[0].Id : null;
  } catch (err) {
    if (!(err instanceof Error && /INVALID_FIELD/.test(err.message) && err.message.includes(ORIGIN_FIELD))) throw err;
    const rows = await client.query<{ Id?: unknown }>(soql(false));
    return typeof rows[0]?.Id === 'string' ? rows[0].Id : null;
  }
}

const originClause = (withOrigin: boolean): string => (withOrigin ? ` AND ${ORIGIN_FIELD} = '${soqlEscape(AI_OUTREACH_ORIGIN)}'` : '');
const firstCode = (r: CompositeResult): string => r.errors[0]?.statusCode ?? 'UNKNOWN_ERROR';

/**
 * The Event on the Opportunity: an existing one of ours, else (the time still ahead, the calendar still free) a new one. A
 * passed time, a conflict or a refusal creates nothing; the caller moves the stage to Followup and gives the owner a Task.
 */
export async function bookOpportunity(
  client: SalesforceClient,
  i: { oppId: string; booked: BookedAppointment; location: string | null; aiCallId: string; sellerTimeZone: string | null; bufferMinutes: number; ownerTimeZone?: string; now?: Date },
): Promise<AppointmentResult> {
  const opp = checkId(i.oppId, 'oppId');
  const owner = checkId(i.booked.specialistSfUserId, 'the appointment owner');
  const existing = await findOne(
    client,
    (o) => `SELECT Id FROM Event WHERE WhatId = '${soqlEscape(opp)}' AND OwnerId = '${soqlEscape(owner)}' AND StartDateTime = ${soqlDateTime(i.booked.start)}${originClause(o)} LIMIT 1`,
  );
  if (existing !== null) return { kind: 'existing', eventId: existing };
  // The time has passed (a late retry): an Event an earlier attempt made was found above; none is made now (I-1).
  if (i.now !== undefined && bookingPassed(i.booked, i.now)) return { kind: 'expired' };

  const window = { start: new Date(i.booked.start), end: new Date(i.booked.end) };
  const bufferMs = i.booked.kind === 'walkthrough' ? i.bufferMinutes * MIN_MS : 0;
  const zone = i.ownerTimeZone ?? DEFAULT_OWNER_TIME_ZONE;
  const busy = await readBusy(client, owner, new Date(window.start.getTime() - bufferMs), new Date(window.end.getTime() + bufferMs), zone);
  if (conflicts(window, busy, zone, bufferMs)) return { kind: 'conflict' };

  const created = await createOne(client, 'Event', opportunityEventFields({ ...i, oppId: opp }));
  return created.success && created.id ? { kind: 'created', eventId: created.id } : { kind: 'refused', code: firstCode(created) };
}

/** Clock skew allowed between the call's end (our clock) and a Task's CreatedDate (Salesforce's). */
const TASK_SKEW_MS = 60_000;

/**
 * A Task once: the one we made since the call ended (same record, owner, Subject and origin), else a new one. `since` is
 * the call's end, so the lookup covers the row's whole life, an admin retry days later included (final review); null
 * (no end time known) looks without a date bound.
 */
export async function createTaskOnce(client: SalesforceClient, fields: Record<string, unknown>, since: Date | null): Promise<string> {
  const ids = (['WhatId', 'WhoId'] as const).flatMap((k) => (typeof fields[k] === 'string' ? [[k, checkId(fields[k] as string, k)] as const] : []));
  const owner = checkId(String(fields.OwnerId), 'OwnerId');
  const on = ids.map(([k, id]) => `${k} = '${soqlEscape(id)}'`);
  const record = on.length > 1 ? `(${on.join(' OR ')})` : (on[0] ?? 'WhatId = null');
  const existing = await findOne(
    client,
    (o) =>
      `SELECT Id FROM Task WHERE ${record} AND OwnerId = '${soqlEscape(owner)}' AND Subject = '${soqlEscape(String(fields.Subject))}'${originClause(o)}${sinceClause(since)} LIMIT 1`,
  );
  if (existing !== null) return existing;
  const created = await createOne(client, 'Task', fields);
  if (created.success && created.id) return created.id;
  throw new WriteRefusedError(firstCode(created), `Salesforce refused the Task: ${firstCode(created)}`);
}

const sinceClause = (since: Date | null): string =>
  since === null || Number.isNaN(since.getTime()) ? '' : ` AND CreatedDate >= ${soqlDateTime(new Date(since.getTime() - TASK_SKEW_MS).toISOString())}`;

/** The id, or null with the refusal's code when Salesforce refused; anything else propagates for a retry. */
async function refusedAsNull(run: () => Promise<string>): Promise<{ id: string | null; code?: string }> {
  try {
    return { id: await run() };
  } catch (err) {
    if (err instanceof WriteRefusedError) return { id: null, code: err.code };
    throw err;
  }
}

/** A hold we already put on the owner's calendar at the booked time (a retry never doubles it), or null. */
export async function findLeadHold(client: SalesforceClient, booked: BookedAppointment): Promise<string | null> {
  const owner = checkId(booked.specialistSfUserId, 'the appointment owner');
  return findOne(
    client,
    (o) =>
      `SELECT Id FROM Event WHERE WhatId = null AND WhoId = null AND OwnerId = '${soqlEscape(owner)}' AND StartDateTime = ${soqlDateTime(booked.start)}${originClause(o)} AND Subject LIKE 'Hold: AI-booked%' LIMIT 1`,
  );
}

/**
 * FALLBACK ONLY: used when a booked Lead could not be converted (Task 24). The hold keeps the time on the owner's calendar;
 * the Task (always to the appointment owner, who distributes appointments; never the Lead's owner) says why and what to do.
 */
export async function holdForLead(
  client: SalesforceClient,
  i: { leadId: string; leadName: string | null; booked: BookedAppointment; aiCallId: string; ownerName: string; reason: string; today: string; since: Date | null },
): Promise<AppointmentResult> {
  const lead = checkId(i.leadId, 'leadId');
  const owner = checkId(i.booked.specialistSfUserId, 'the appointment owner');
  const hold = await refusedAsNull(async () => {
    const found = await findLeadHold(client, i.booked);
    if (found !== null) return found;
    const created = await createOne(client, 'Event', leadHoldFields({ booked: i.booked, leadName: i.leadName, leadId: lead, aiCallId: i.aiCallId }));
    if (created.success && created.id) return created.id;
    throw new WriteRefusedError(firstCode(created), 'hold refused');
  });
  const eventId = hold.id;
  const when = ptWords(new Date(i.booked.start));
  const subject = `AI booked a ${KIND_WORDS[i.booked.kind]} for ${when} but could not convert this Lead — convert it and book it`;
  const description = [
    `The AI assistant booked a ${KIND_WORDS[i.booked.kind]} for ${when} with ${oneLine(i.ownerName)} on a call (AI call ${i.aiCallId}), but Salesforce did not convert this Lead.`,
    `Reason: ${oneLine(i.reason)}`,
    eventId === null ? 'No hold could be put on the calendar: book the time now.' : 'A hold is on the calendar at that time: convert the Lead, book it on the Opportunity, then delete the hold.',
  ].join('\n');
  const task = await refusedAsNull(() => createTaskOnce(client, taskFields({ whatId: null, whoId: lead, ownerId: owner, subject, description, today: i.today }), i.since));
  return {
    kind: 'lead_hold',
    eventId,
    taskId: task.id,
    ...(hold.code === undefined ? {} : { holdCode: hold.code }),
    ...(task.code === undefined ? {} : { taskCode: task.code }),
  };
}
