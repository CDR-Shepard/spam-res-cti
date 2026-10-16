import { INBOUND_DETAIL_FIELDS, type InboundCallDetails, type InboundDetailField, type InboundTestCall, type TestPhone } from '@cti/contracts';
import type { StatusTone } from '@/components/layout/status-badge';
import { humanize } from './outreach-words';

const US_NUMBER = /^\+1(\d{3})(\d{3})(\d{4})$/;

/** "+16195550123" as people write it, "(619) 555-0123"; anything that is not a US number is shown as it is. */
export function formatPhone(e164: string): string {
  const m = US_NUMBER.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** "(619) 555-0900", "(619) 555-0900 or (619) 555-0901", "A, B or C", for "call this or that". */
export function formatPhoneList(e164s: readonly string[]): string {
  const numbers = e164s.map(formatPhone);
  if (numbers.length <= 1) return numbers.join('');
  return `${numbers.slice(0, -1).join(', ')} or ${numbers[numbers.length - 1]}`;
}

/** What to call a listed phone: its label, or its number when it has none. */
export const phoneName = (phone: Pick<TestPhone, 'e164' | 'label'>): string => phone.label || formatPhone(phone.e164);

/** A listed phone named for a screen reader among many: its label and its number. */
export const phoneWho = (phone: Pick<TestPhone, 'e164' | 'label'>): string => (phone.label ? `${phone.label} ${formatPhone(phone.e164)}` : formatPhone(phone.e164));

/** Who called: the list's label for the number, or the number (a caller whose phone left the list has no label). */
export const callerWords = (call: Pick<InboundTestCall, 'callerE164' | 'callerLabel'>): string => call.callerLabel || formatPhone(call.callerE164);

/** A call's length as m:ss; a dash while it has none (the call is still going). */
export const callDurationWords = (seconds: number | null): string => (seconds === null ? '—' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);

/** ai_calls.status values while the call is not over. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'ringing', 'in_progress', 'transferring']);

const OUTCOME_BADGES: Readonly<Record<string, { tone: StatusTone; words: string }>> = {
  qualified: { tone: 'success', words: 'Qualified' },
  callback: { tone: 'warning', words: 'Callback' },
  disqualified: { tone: 'neutral', words: 'Disqualified' },
  incomplete: { tone: 'outline', words: 'Incomplete' },
};

/**
 * The badge on an inbound call: In progress while it is going; once over, the status the agent saved (its outcome), or
 * Incomplete when it saved none (the caller hung up first); Failed when the call itself failed.
 */
export function inboundBadge(call: Pick<InboundTestCall, 'status' | 'outcome'>): { tone: StatusTone; words: string } {
  if (LIVE_STATUSES.has(call.status)) return { tone: 'live', words: 'In progress' };
  if (call.status === 'failed') return { tone: 'danger', words: 'Failed' };
  if (call.outcome === null) return OUTCOME_BADGES.incomplete!;
  return Object.hasOwn(OUTCOME_BADGES, call.outcome) ? OUTCOME_BADGES[call.outcome]! : { tone: 'neutral', words: humanize(call.outcome) };
}

export const INBOUND_DETAIL_LABELS: Readonly<Record<InboundDetailField, string>> = {
  location: 'Location',
  timeline: 'Timeline',
  price_expectation: 'Price expectation',
  condition: 'Condition',
  decision_maker: 'Decision maker',
  urgency: 'Urgency',
  best_callback_time: 'Best callback time',
  notes: 'Notes',
};

/** The details the agent saved, label and value, in the order the prompt asks for them; empty ones are left out. */
export function inboundDetailRows(details: InboundCallDetails): Array<{ label: string; value: string }> {
  return INBOUND_DETAIL_FIELDS.flatMap((field) => {
    const value = details[field]?.trim();
    return value ? [{ label: INBOUND_DETAIL_LABELS[field], value }] : [];
  });
}
