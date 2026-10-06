/**
 * Test a record, "What would be written to Salesforce" (plan 1E Task 11): the pure half. From a write plan built against
 * the record as it is now, the change list the page groups, what a real call would create, and the conversion line.
 * Words only; nothing here reads or writes Salesforce.
 */
import type { BookedAppointment, RecordTestDryRun, WritebackChange } from '@cti/contracts';
import { MAX_WRITEBACK_CHANGES, SKIPPED_WORDS } from '../ai-calls/results-query.js';
import type { Change, WritePlan } from '../writeback/plan.js';
import { ptWords } from '../writeback/render.js';

export const NOTHING_NOTE = 'A real call that ended this way writes nothing to Salesforce.';
export const GONE_NOTE = 'The record is gone.';
export const UNMAPPED_NOTE = "Couldn't map the seller's answers; status moves only.";
/** 1D: write-back is off until an admin turns it on, and a real call offers no times (so books nothing) while it is off. */
export const WRITEBACK_OFF_NOTE =
  'Write-back was off, so a real call would have written none of this to Salesforce (and offered no times). This is what it would write with write-back on.';

/** The dry run's note: each that applies, in order, or null. */
export const notesOf = (notes: ReadonlyArray<string | null>): string | null => notes.filter((n): n is string => n !== null).join(' ') || null;

const EVENT_SUBJECTS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'Phone Consultation', walkthrough: 'Property Consultation' };
const KIND_WORDS: Readonly<Record<BookedAppointment['kind'], string>> = { phone: 'phone consultation', walkthrough: 'walkthrough' };

export const emptyDryRun = (status: RecordTestDryRun['status'], note: string | null): RecordTestDryRun => ({
  status, changes: [], changesText: null, chatterText: null, wouldCreate: [], conversion: null, note,
});

/** What a real call would write as field changes: the plan's, plus the booking's moves (the Event is assumed made). */
export function writtenChanges(plan: WritePlan): Change[] {
  return [...plan.changes, ...(plan.appointment?.onBookedChanges ?? [])];
}

/** Changed, kept (a rep's value over the seller's answer) and not written, as the page groups them (the results page's words). */
export function changeList(plan: WritePlan): WritebackChange[] {
  return [
    ...writtenChanges(plan).map((c): WritebackChange => ({ label: c.label, before: c.before, after: c.after, kind: 'changed' })),
    ...plan.kept.map((k): WritebackChange => ({ label: k.label, before: k.current, after: k.proposed, kind: 'kept' })),
    ...plan.skipped.map((s): WritebackChange => ({ label: s.label, before: null, after: SKIPPED_WORDS[s.why], kind: 'not_written' })),
  ].slice(0, MAX_WRITEBACK_CHANGES);
}

export interface Booking {
  booked: BookedAppointment;
  ownerName: string;
  ownerFirstName: string | null;
  /** A Lead that booked, with conversion on: the Lead Manager the conversion would set. */
  convertsWithLeadManager: string | null;
}

/** The records a real call would create, the Chatter post aside: the Event, or a Lead's calendar hold and its Task. */
export function createdRecords(sfObject: 'Lead' | 'Opportunity', b: Booking | null): string[] {
  if (b === null) return [];
  const when = ptWords(new Date(b.booked.start));
  if (sfObject === 'Lead' && b.convertsWithLeadManager === null) {
    return [`Hold on ${b.ownerName}'s calendar: ${when}`, `Task to ${b.ownerName}: convert the Lead and book it`];
  }
  return [`Event: ${EVENT_SUBJECTS[b.booked.kind]}, ${when}, owner ${b.ownerName}`];
}

export function conversionWords(b: Booking | null): string | null {
  if (b === null || b.convertsWithLeadManager === null) return null;
  return `Would convert this Lead (owner ${b.ownerName}, Lead Manager ${b.convertsWithLeadManager}) and write the rest to the new Opportunity. The field list below is the Lead-side approximation.`;
}

/** The Chatter post's "Booked:" words, as a made Event reads ("phone consultation with Grant, Wed Oct 7, 11:00 AM PT"). */
export function bookedWords(b: Booking | null): string | null {
  if (b === null) return null;
  return `${KIND_WORDS[b.booked.kind]} with ${b.ownerFirstName ?? b.ownerName}, ${ptWords(new Date(b.booked.start))}`;
}
