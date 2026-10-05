/**
 * AI voice calls (services/cti-api/src/ai-voice/routes.ts): the API calls the
 * softphone makes, and every piece of plain wording the UI shows for them —
 * statuses, outcomes, block reasons, errors, and the transfer reason on the
 * ring screen. One place, so the words never drift between screens.
 */
import { api, ApiError } from './api';

export type AiCallObject = 'Lead' | 'Opportunity' | 'Contact';

export type AiCallStatus =
  | 'queued' | 'ringing' | 'in_progress' | 'transferring'
  | 'transferred' | 'completed' | 'failed' | 'blocked';

export interface AiTranscriptEntry { role: 'agent' | 'caller' | 'system' | string; text: string; at?: string }

/** The `ai_calls` row as the API serves it (camelCase; dates are ISO strings). */
export interface AiCallRow {
  id: string;
  sfObject: string | null;
  sfRecordId: string | null;
  toE164: string;
  isTest: boolean;
  status: AiCallStatus | string;
  outcome: string | null;
  blockReason: string | null;
  summary: string | null;
  transcript: AiTranscriptEntry[] | null;
  durationSeconds: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiAvailability { available: boolean; testNumbers: string[] }

export type AiCallTarget = { objectType: AiCallObject; recordId: string };

export async function getAiAvailability(): Promise<AiAvailability> {
  const data = await api<Partial<AiAvailability> | null>('/ai-calls/availability');
  return {
    available: data?.available === true,
    testNumbers: Array.isArray(data?.testNumbers) ? data.testNumbers.filter((n): n is string => typeof n === 'string') : [],
  };
}

export async function startAiCall(body: AiCallTarget | { testTo: string }): Promise<{ aiCallId: string; status: string }> {
  return api('/ai-calls', { method: 'POST', body });
}

export async function listAiCalls(limit = 20): Promise<AiCallRow[]> {
  const data = await api<{ aiCalls?: AiCallRow[] } | null>(`/ai-calls?limit=${limit}`);
  return Array.isArray(data?.aiCalls) ? data.aiCalls : [];
}

export async function getAiCall(id: string): Promise<AiCallRow> {
  return api(`/ai-calls/${encodeURIComponent(id)}`);
}

// ---- Which click-to-dial record can take an AI call ------------------------

const SUPPORTED: readonly AiCallObject[] = ['Lead', 'Opportunity', 'Contact'];
const PREFIX_OBJECT: Readonly<Record<string, AiCallObject>> = { '00Q': 'Lead', '006': 'Opportunity', '003': 'Contact' };
const RECORD_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/**
 * The AI call target for a click-to-dial context, or null when there is none.
 * Salesforce's `objectType` wins when it is one we call; with no object type,
 * the record id's key prefix decides (00Q Lead, 006 Opportunity, 003 Contact).
 */
export function aiCallTargetFor(ctx: { recordId?: string; objectType?: string } | null | undefined): AiCallTarget | null {
  const recordId = ctx?.recordId?.trim();
  if (!recordId || !RECORD_ID_RE.test(recordId)) return null;
  if (ctx?.objectType) {
    const named = SUPPORTED.find((o) => o.toLowerCase() === ctx.objectType!.trim().toLowerCase());
    return named ? { objectType: named, recordId } : null;
  }
  const derived = PREFIX_OBJECT[recordId.slice(0, 3)];
  return derived ? { objectType: derived, recordId } : null;
}

// ---- Statuses and outcomes -------------------------------------------------

const TERMINAL: ReadonlySet<string> = new Set(['transferred', 'completed', 'failed', 'blocked']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/** Keep polling a row this long after it ends: the summary is rewritten, and
 *  `completed` can still become `transferred`, a few seconds after `endedAt`. */
export const AFTER_END_GRACE_MS = 20_000;

/** Still worth fast polling: not terminal yet, or only just ended. */
export function isLiveRow(row: Pick<AiCallRow, 'status' | 'endedAt'>, now: number): boolean {
  if (!isTerminalStatus(row.status)) return true;
  if (!row.endedAt) return false;
  return now - new Date(row.endedAt).getTime() < AFTER_END_GRACE_MS;
}

export const STATUS_WORDS: Readonly<Record<AiCallStatus, string>> = {
  queued: 'Calling…',
  ringing: 'Calling…',
  in_progress: 'In progress',
  transferring: 'Transferring',
  transferred: 'Transferred',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
};

export function statusWords(status: string): string {
  return (STATUS_WORDS as Record<string, string>)[status] ?? status;
}

/** Copied from services/cti-api/src/ai-voice/outcomes.ts OUTCOME_WORDS. */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  qualified_transferred: 'Transferred to rep',
  qualified_callback: 'Callback requested',
  not_interested: 'Not interested',
  do_not_call: 'Do not call',
  voicemail: 'Left voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  wrong_number: 'Wrong number',
  hung_up: 'Hung up',
  transfer_failed: 'Transfer missed — callback promised',
  blocked: 'Blocked',
  other: 'Other',
};

/** Outcome words, or '' while the call has no outcome yet. */
export function outcomeWords(outcome: string | null | undefined): string {
  if (!outcome) return '';
  return Object.prototype.hasOwnProperty.call(OUTCOME_WORDS, outcome) ? OUTCOME_WORDS[outcome]! : outcome;
}

// ---- Why a call was not placed ---------------------------------------------

/** The 409 block reasons (the gate's 13 + `call_in_progress`), in plain words. */
export const BLOCK_WORDS: Readonly<Record<string, string>> = {
  ai_voice_unavailable: 'AI calling is turned off.',
  no_consent: "This record hasn't agreed to AI calls — AI Call Consent is unticked in Salesforce.",
  consent_field_missing:
    "Your Salesforce user can't see the AI Call Consent field — ask an admin to assign the AI Call Consent Access permission set.",
  no_phone: 'This record has no phone number to call.',
  opted_out: 'This number asked not to be called (it is on the opt-out list).',
  blocked: 'This number is blocked.',
  dnc: 'This number is on the Do Not Call registry.',
  daily_cap: "This number has reached today's call limit for its state.",
  customer_ceiling: 'This person has been called the most times allowed for now — try again later.',
  calling_hours: "It's outside calling hours (8am–9pm) where this person lives.",
  no_caller_id: "There's no caller ID number free to call from right now.",
  not_admin_for_test: 'Test AI calls are for admins, and only to the configured test numbers.',
  invalid_number: "That isn't a valid phone number.",
  call_in_progress: 'An AI call to this number is already in progress.',
};

export function blockWords(reason: string | null | undefined): string {
  if (!reason) return '';
  return BLOCK_WORDS[reason] ?? reason;
}

const ERROR_WORDS: Readonly<Record<string, string>> = {
  record_not_found: "Salesforce couldn't find this record — it may have been deleted, or you can't see it.",
  salesforce_error: "Couldn't read the record from Salesforce — try again in a moment.",
  twilio_error: "The phone system couldn't place the call — try again in a moment.",
  gate_error: "Couldn't run the safety checks just now, so the call wasn't placed — try again in a moment.",
  invalid_body: "That number or record doesn't look right.",
  unauthorized: 'Your session has expired — sign in again.',
};

export const RATE_LIMIT_WORDS = 'Too many AI calls started in the last minute — wait a minute and try again.';
export const GENERIC_START_ERROR = "Couldn't start the AI call.";

/** Plain words for a failed POST /ai-calls. */
export function aiCallErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return GENERIC_START_ERROR;
  if (err.status === 429) return RATE_LIMIT_WORDS;
  const code = (err.data as { error?: unknown } | null)?.error;
  if (typeof code === 'string') {
    if (err.status === 409) return blockWords(code);
    if (ERROR_WORDS[code]) return ERROR_WORDS[code]!;
  }
  if (err.status === 401) return ERROR_WORDS.unauthorized!;
  return GENERIC_START_ERROR;
}

// ---- The AI transfer on the ring screen -------------------------------------

/** services/cti-api/src/ai-voice/prompt-tools.ts TRANSFER_REASONS, in words. */
export const TRANSFER_REASON_WORDS: Readonly<Record<string, string>> = {
  interested: 'interested',
  wants_offer: 'wants an offer',
  wants_human: 'asked for a person',
  legal_or_complex: 'legal or complex question',
  question: 'has a question',
};

/** "AI transfer — wants an offer" for the `aiTransfer` call parameter, else undefined. */
export function aiTransferLabel(reason: string | null | undefined): string | undefined {
  if (reason == null) return undefined;
  const words = TRANSFER_REASON_WORDS[reason] ?? reason.replace(/_/g, ' ').trim();
  return words ? `AI transfer — ${words}` : 'AI transfer';
}
