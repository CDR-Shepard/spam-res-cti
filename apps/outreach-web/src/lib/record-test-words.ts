import type { RecordTestError, RecordTestStatus } from '@cti/contracts';
import { ApiRequestError } from './api';
import { errorText, wordFor } from './outreach-words';

/** Test a record (plan 1E): why a preview failed, in words. */
export const RECORD_TEST_ERROR_WORDS: Record<RecordTestError, string> = {
  not_found: "That record isn't in your Salesforce.",
  not_connected: 'Salesforce is not connected. An admin can connect it in Settings.',
  salesforce_error: "Salesforce didn't answer while the record was read. Try again.",
  plan_failed: "The AI couldn't write a usable plan. Try again.",
  timeout: 'The AI took too long to write the plan. Try again.',
  interrupted: 'The preview stopped part way (the server restarted). Try again.',
  internal_error: 'Something went wrong on our side while writing the preview. Try again.',
};

export const RECORD_TEST_STATUS_WORDS: Record<RecordTestStatus, string> = { running: 'Running', ready: 'Ready', failed: 'Failed' };

/** Why a preview offers no appointment times (outreach-api appointments/offer.ts `OfferNote`). */
const OFFER_NOTE_WORDS: Readonly<Record<string, string>> = {
  booking_off: 'Booking is off, so no times would be offered.',
  no_owner: 'Nobody active is on the appointment list, so no times would be offered.',
  no_free_time: 'No free time in the next 15 days, so no times would be offered.',
  salesforce_error: "Couldn't read the calendar, so no times would be offered.",
  invalid_slots: "Couldn't read the calendar, so no times would be offered.",
};

export function offerNoteWords(note: string | null): string {
  return note ? wordFor(OFFER_NOTE_WORDS, note, 'No times would be offered.') : 'No times would be offered.';
}

/** "This preview cost about $0.05." */
export function costWords(micros: number): string {
  return `This preview cost about $${(micros / 1_000_000).toFixed(2)}.`;
}

/** A time in the viewer's own zone, e.g. "3:42 PM". */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function retryAtOf(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const at = (details as { retryAt?: unknown }).retryAt;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
}

/**
 * A record test route's refusal in words. A 429 keeps the server's reason and says when to try again in the viewer's
 * own zone (the server words it in Pacific time).
 */
export function recordTestErrorText(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 429) {
    const at = retryAtOf(error.details);
    if (at) {
      const reason = error.message.replace(/\s*Try again at .*$/, '');
      return `${reason ? `${reason} ` : ''}Try again at ${localTime(at)}.`;
    }
  }
  return errorText(error);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Test a record page's search: `?id=<record test id>` opens that test; anything else is dropped. */
export function recordTestSearch(search: Record<string, unknown>): { id?: string } {
  return typeof search.id === 'string' && UUID.test(search.id) ? { id: search.id } : {};
}
