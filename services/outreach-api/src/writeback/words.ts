/**
 * Plan 1D write-back: the words the run passes to the renderers (render.ts): what was booked or held, what the write-back
 * created, the conversion, and the results link. Ids, times and Salesforce names only; the call's content is the renderers'.
 */
import type { BookedAppointment } from '@cti/contracts';
import { timezoneForNumber } from '@cti/firewall';
import type { OwnerUser } from '../appointments/calendar.js';
import type { AppointmentResult } from './appointment.js';
import { OUTCOME_WORDS } from './context.js';
import type { Change, WritePlan } from './plan.js';
import { ptWords, type Applied, type RenderInput } from './render.js';
import type { RowRun } from './row-run.js';

const PT_ZONE = 'America/Los_Angeles';
const KIND_WORDS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'phone consultation', walkthrough: 'walkthrough' };
const EVENT_SUBJECTS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'Phone Consultation', walkthrough: 'Property Consultation' };

/** One entry of "Not written", with the code behind it (last_error). */
export interface NotWritten {
  label: string;
  reason: string;
  /** The allowlist name (or the org's) of the field, so a refused do-not-call flag gets its own section (D-22). */
  field: string;
  code: string;
}
export const refusedWords = (code: string): string => `Salesforce refused (${code})`;

/** The seller's zone from the number dialed (as cti-api's localTimeFor reads it); null when unknown. */
export function sellerTimeZone(toE164: string): string | null {
  return timezoneForNumber(toE164)?.timezone ?? null;
}

/** " (seller: 1:00 PM CDT)" when the seller is outside Pacific time. */
function sellerPart(start: Date, zone: string | null): string {
  if (zone === null || zone === PT_ZONE) return '';
  try {
    const words = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(start);
    return ` (seller: ${words.replace(/ /g, ' ')})`;
  } catch {
    return '';
  }
}

const ownerName = (owner: OwnerUser | null): string => owner?.name ?? 'the appointment owner';

/** The Chatter post's "Booked:" words: what was booked (or held), with whom and when, or why it was not. */
export function appointmentWords(i: { booked: BookedAppointment; result: AppointmentResult | null; owner: OwnerUser | null; address: string | null; sellerZone: string | null }): string | null {
  const { booked, result, owner } = i;
  const kind = KIND_WORDS[booked.kind];
  const start = new Date(booked.start);
  const when = ptWords(start);
  const name = ownerName(owner);
  switch (result?.kind) {
    case 'created':
    case 'existing': {
      const at = booked.kind === 'walkthrough' && i.address ? ` at ${i.address}` : '';
      return `${kind} with ${owner?.firstName ?? name}${at}, ${when}${sellerPart(start, i.sellerZone)}`;
    }
    case 'conflict':
      return `${kind} for ${when} not booked: the calendar was taken (Task to ${name})`;
    case 'refused':
      return `${kind} for ${when} not booked: Salesforce refused the Event, ${result.code} (Task to ${name})`;
    case 'lead_hold':
      return `${kind} ${when} held on ${name}'s calendar; the Lead was not converted (Task to ${name})`;
    default:
      return null;
  }
}

/** The "Created" lines of the changes text: what this write-back made (the Chatter post comes later and is not claimed). */
export function createdLines(i: { plan: WritePlan; result: AppointmentResult | null; owner: OwnerUser | null; taskId: string | null }): string[] {
  const booked = i.plan.appointment?.booked;
  if (!booked) return [];
  const when = ptWords(new Date(booked.start));
  const name = ownerName(i.owner);
  const r = i.result;
  if (r?.kind === 'created' || r?.kind === 'existing') return [`Event: ${EVENT_SUBJECTS[booked.kind]}, ${when}, owner ${name}`];
  if (r?.kind === 'lead_hold') {
    return [...(r.eventId ? [`Hold on ${name}'s calendar: ${when}`] : []), ...(r.taskId ? [`Task to ${name}: convert the Lead and book it`] : [])];
  }
  return i.taskId ? [`Task to ${name}: call the seller to set a time (${when} was not booked)`] : [];
}

/** URLs out of the summary before it is posted: Chatter turns them into links (D-17). */
export function stripUrls(s: string | null): string | null {
  if (s === null) return null;
  return s
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '(link)')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|info|biz|app|dev)\b\S*/gi, '(link)')
    .trim();
}

export const resultsUrl = (run: RowRun): string =>
  run.ctx.campaignId === null ? `${run.deps.appPublicUrl}/campaigns` : `${run.deps.appPublicUrl}/campaigns/${run.ctx.campaignId}?call=${run.row.aiCallId}`;

/** The renderers' input for this row. */
export function renderInputFor(run: RowRun, plan: WritePlan, applied: Applied, extra: { appointmentWords: string | null; owner: OwnerUser | null; summary: string | null }): RenderInput {
  const convert = run.row.steps.convert;
  const converted = convert?.status === 'done' && run.row.convertedOpportunityId !== null;
  const data = convert?.data ?? {};
  const refused = convert === undefined || converted || convert.detail === 'CONVERTED_WITHOUT_OPPORTUNITY' ? null : (convert.detail ?? 'not converted');
  return {
    at: run.ctx.call.endedAt ?? run.deps.now,
    outcomeWords: OUTCOME_WORDS[run.ctx.call.outcome] ?? run.ctx.call.outcome,
    aiCallId: run.row.aiCallId,
    plan,
    applied,
    summary: extra.summary,
    appointmentWords: extra.appointmentWords,
    resultsUrl: resultsUrl(run),
    conversion: converted ? { leadName: typeof data.leadName === 'string' ? data.leadName : null, ownerName: ownerName(extra.owner), adopted: data.repConverted === true } : null,
    conversionRefused: refused,
    transferredTo: run.ctx.call.transferredTo,
  };
}

/** The changes as written: the plan's and the booking's, less what Salesforce refused (matched case-insensitively, D-22). */
export function writtenChanges(changes: readonly Change[], refusedFields: ReadonlySet<string>): Change[] {
  return changes.filter((c) => !refusedFields.has(c.field.toLowerCase()));
}
