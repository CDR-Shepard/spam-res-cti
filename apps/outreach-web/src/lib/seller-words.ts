/**
 * Plain words for everything the seller page shows that the server sends as a code: why Sam stopped, why a person is
 * needed, why Sam may not email, where an email stands, a hand-over / status / flag note, when an email goes out, and
 * what went wrong with a draft or a send. Every table is keyed by the contract's enum, so a value added there is a
 * type error here until it has words (and the test walks each enum's options besides, for values that arrive at runtime).
 */
import { ApiRequestError } from './api';
import { EmailBlock, FlagReason, StopReason, type ConversationView, type EmailStatus, type TimelineItem } from '@cti/contracts';
import { errorText, humanize } from './outreach-words';

/** Lower-case: they follow "Stopped (" and "Stopped: ". */
export const STOP_REASON_WORDS: Record<StopReason, string> = {
  opted_out: 'opted out',
  complained: 'spam complaint',
  asked_to_stop: 'asked Sam to stop',
  not_interested: 'not interested',
};

/** The words the Salesforce Task for a flag uses (conversations/sf-log.ts), so the page and the Task agree. */
export const FLAG_REASON_WORDS: Record<FlagReason, string> = {
  offer_or_price: 'asked about an offer or price',
  angry_or_threat: 'upset or threatening',
  legal: 'mentioned an attorney or legal action',
  not_owner: 'says they are not the owner',
  wants_appointment: 'wants to set a time',
  unsure: 'Sam was not sure how to answer',
  other_sender: 'a reply came from another address',
  loop_guard: 'many replies today',
  after_close: 'replied after booking or closing',
  draft_rejected: "Sam's reply did not pass the checks",
};

/** Why Sam may not email right now: shown beside a disabled "Email from Sam", and on a canceled email as "Not sent: …". */
export const EMAIL_BLOCK_WORDS: Record<EmailBlock, string> = {
  not_configured: 'Email is not set up on this server yet',
  disabled: 'Email from Sam is turned off',
  paused: 'Email from Sam is paused after a spam complaint',
  no_address: 'There is no email address on this record',
  suppressed: 'This address is on the do-not-email list',
  sf_opt_out: 'Salesforce says this person opted out of email',
  stopped: 'Sam has stopped reaching out to this seller',
  booked: 'An appointment is already booked',
  closed: 'This record is closed',
  taken_over: 'A person has taken over this seller',
  flagged: 'This seller needs a person first',
  not_approved: 'No approved call plan yet',
  daily_cap: 'Sam already sent 3 emails today',
};

/**
 * The tenant's switch, off or paused: it stops every send but never a draft, so an admin can read what Sam would send before
 * turning email on (owner, 2026-10-20). The server skips it for drafts too (seller-view.ts BlockUse).
 */
const SWITCH_BLOCKS: ReadonlySet<EmailBlock> = new Set<EmailBlock>(['disabled', 'paused']);

export const isSwitchBlock = (block: EmailBlock | null): boolean => block !== null && SWITCH_BLOCKS.has(block);

/**
 * Behind the switch, the seller's own block that also stops a draft (`draftBlock`; absent from an older API reads as
 * none); null when the switch is not the block or nothing stands behind it.
 */
export const blockBehindSwitch = (emailBlock: EmailBlock | null, draftBlock: EmailBlock | null | undefined): EmailBlock | null =>
  isSwitchBlock(emailBlock) ? (draftBlock ?? null) : null;

/** Whether Sam's draft can be read as a preview: the switch is the only block. */
export const mayPreview = (emailBlock: EmailBlock | null, draftBlock: EmailBlock | null | undefined): boolean =>
  isSwitchBlock(emailBlock) && blockBehindSwitch(emailBlock, draftBlock) === null;

/** The switch's words with the seller's block behind it: "Email from Sam is turned off. No approved call plan yet, so there is no preview either." */
export const switchAndSellerWords = (emailBlock: EmailBlock, behind: EmailBlock): string =>
  `${EMAIL_BLOCK_WORDS[emailBlock]}. ${EMAIL_BLOCK_WORDS[behind]}, so there is no preview either.`;

/** Shown with the switch's words when Sam's draft can still be read. */
export const PREVIEW_WORDS = 'Sam can still write a draft for you to read. Nothing is sent while email is off.';

/** The blocks that stop a practice copy too: the server has no email setup, or the tenant's switch is off or paused. */
const PRACTICE_BLOCKS: ReadonlySet<EmailBlock> = new Set<EmailBlock>(['not_configured', 'disabled', 'paused']);

/**
 * Whether the admin's own practice copy may be drafted and sent under this block (null = no block). A practice copy
 * goes only to the admin, so every block about the seller (suppressed, not approved, daily cap, a hand-over...) is
 * ignored by the server for it; only the setup and the switch apply.
 */
export const practiceAllowed = (block: EmailBlock | null): boolean => block === null || !PRACTICE_BLOCKS.has(block);

export const EMAIL_STATUS_WORDS: Record<EmailStatus, string> = {
  queued: 'Waiting to send',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  bounced: 'Bounced',
  complained: 'Marked as spam',
  failed: 'Failed to send',
  canceled: 'Not sent',
  received: 'Received',
};

export type SellerTone = 'success' | 'warning' | 'danger' | 'neutral';

type StatusFacts = Pick<ConversationView, 'status' | 'stopReason' | 'flagReason' | 'handler' | 'handlerName'>;

/**
 * The page's status badge. A stopped or booked seller says so whoever has them; after that, a person who has taken
 * over outranks a flag (someone is on it); then a flag; otherwise Sam is talking with the seller.
 */
export function sellerStatus(view: StatusFacts): { tone: SellerTone; label: string } {
  if (view.status === 'stopped') {
    return { tone: 'danger', label: view.stopReason ? `Stopped (${STOP_REASON_WORDS[view.stopReason]})` : 'Stopped' };
  }
  if (view.status === 'booked') return { tone: 'success', label: 'Booked' };
  if (view.handler === 'person') return { tone: 'neutral', label: `Taken over by ${view.handlerName ?? 'a person'}` };
  if (view.flagReason) return { tone: 'warning', label: `Needs a person (${FLAG_REASON_WORDS[view.flagReason]})` };
  return { tone: 'success', label: 'Talking with Sam' };
}

type NoteFacts = Pick<Extract<TimelineItem, { type: 'note' }>, 'kind' | 'detail' | 'byName'>;

const NOTE_KIND_WORDS: Record<NoteFacts['kind'], string> = { handler: 'Handler changed', status: 'Status changed', flag: 'Needs a person' };

/**
 * A timeline note as one line. The server stores the code (taken_over, given_back, a flag or stop reason, booked);
 * the contract calls `detail` "in words", so a detail that is already a sentence is shown as it is, and a code this
 * page does not know yet is humanized rather than hidden.
 */
export function noteWords({ kind, detail, byName }: NoteFacts): string {
  if (kind === 'handler') {
    if (detail === 'taken_over') return `Taken over by ${byName ?? 'a person'}`;
    if (detail === 'given_back') return byName ? `Given back to Sam by ${byName}` : 'Given back to Sam';
  }
  if (kind === 'flag') {
    const reason = FlagReason.safeParse(detail);
    if (reason.success) return `Needs a person: ${FLAG_REASON_WORDS[reason.data]}`;
  }
  if (kind === 'status') {
    if (detail === 'booked') return 'Booked';
    const reason = StopReason.safeParse(detail);
    if (reason.success) return `Stopped: ${STOP_REASON_WORDS[reason.data]}`;
  }
  const text = detail.trim();
  if (text === '') return NOTE_KIND_WORDS[kind];
  return /^[a-z0-9_]+$/.test(text) ? humanize(text) : text;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** 12-hour clock; newer ICU puts a narrow no-break space before AM/PM, which reads (and compares) as a plain space here. */
const clockWords = (d: Date): string => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ');

/**
 * When a queued email goes out, in the viewer's own time: "now" within a minute (or already due), then "today at
 * 9:00 AM", "tomorrow at 8:00 AM", or the weekday and date.
 */
export function sendAfterWords(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  if (at.getTime() - now.getTime() < MINUTE_MS) return 'now';
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  const clock = clockWords(at);
  if (days <= 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  return `${at.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${clock}`;
}

/** A call's length as minutes and seconds ("3:12"). */
export function durationWords(seconds: number): string {
  const whole = Math.max(0, Math.trunc(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const EVENT_HASH = /^#?event-(.+)$/;

/** The timeline row a Salesforce Task links to: `#event-<id>` → `<id>`; null for no hash, another hash, or an empty id. */
export function eventIdFromHash(hash: string | null | undefined): string | null {
  return EVENT_HASH.exec(hash ?? '')?.[1] ?? null;
}

const SEND_ERROR_WORDS: Readonly<Record<string, string>> = {
  EMAIL_ALREADY_QUEUED: 'An email to this seller is already waiting to go out.',
  AI_BUDGET: "Sam's AI budget for today is used up",
  MODEL_ERROR: 'Sam could not write a draft right now. Try again.',
  DRAFT_REFUSED: 'Sam would not write this email',
};

export interface ErrorWords { message: string; details: readonly string[] }

/**
 * What went wrong drafting or sending, in plain words: the server's codes for this page, any email block it answers
 * a 409 with, and for a refused draft the list of problems it found. Anything else is the server's own sentence.
 */
export function emailErrorWords(error: unknown): ErrorWords {
  if (error instanceof ApiRequestError) {
    const known = SEND_ERROR_WORDS[error.code];
    if (known) return { message: known, details: [] };
    if (error.code === 'DRAFT_INVALID') {
      const details = Array.isArray(error.details) ? error.details.filter((d): d is string => typeof d === 'string') : [];
      return { message: 'Fix the draft before it is sent.', details };
    }
    const block = error.status === 409 ? EmailBlock.safeParse(error.code) : null;
    if (block?.success) return { message: EMAIL_BLOCK_WORDS[block.data], details: [] };
  }
  return { message: errorText(error), details: [] };
}
