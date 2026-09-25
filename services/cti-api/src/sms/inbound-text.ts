/**
 * Inbound texts — the pure half: who a text goes to, what the Salesforce Task
 * and the rep's email alert say, and whether the text is an opt-out.
 *
 * Nothing here touches the database, Twilio or Salesforce, so every wording and
 * routing rule is testable on its own. The webhook (routes/inbound-sms.ts) and
 * the worker (sms/inbound-text-worker.ts) are thin shells around these.
 * Design: docs/superpowers/specs/2026-09-25-inbound-texts-design.md.
 */
import type { OutboundNumber } from '@cti/db';
import { ORG_TIMEZONE } from '../dialer/org-day.js';

/**
 * The carrier opt-out keywords. Matched against the WHOLE message only: "stop
 * calling me" is a person talking to the rep, not a keyword, and flagging it
 * would put "asked to STOP" on a live conversation.
 */
export const OPT_OUT_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'] as const;
const OPT_OUT_SET: ReadonlySet<string> = new Set(OPT_OUT_WORDS);

/** Shorter bodies ("ok", "hi") are ordinary words; redacting them would shred
 *  unrelated log text while protecting nothing. */
const REDACT_MIN_LENGTH = 4;

/**
 * Removes the message body from text bound for a log line. Salesforce quotes a
 * rejected value back in its error payload, and we JSON.stringify that payload
 * into error messages — so the body arrives JSON-ESCAPED (quotes, backslashes,
 * newlines, tabs), and once more escaped when such a message is itself
 * stringified. All three forms are removed, longest first so a shorter form
 * never splits a longer one.
 */
export function redactBody(text: string, body: string): string {
  if (body.trim().length < REDACT_MIN_LENGTH) return text;
  const once = JSON.stringify(body).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [twice, once, body].reduce((acc, form) => acc.split(form).join('[message]'), text);
}

/** Salesforce's limit on Task.Subject; a longer one fails the whole create. */
const SUBJECT_MAX = 255;
const STOP_SUFFIX = ' — asked to STOP';

export function isOptOutText(body: string | null | undefined): boolean {
  if (!body) return false;
  return OPT_OUT_SET.has(body.trim().toUpperCase());
}

/** `+16195550100` → `(619) 555-0100`; anything else (international, withheld) as it came. */
export function formatUsNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** The Salesforce name when there is one, else the number a rep can read. */
function senderLabel(name: string | null, fromE164: string): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : formatUsNumber(fromE164);
}

/** Truncates the NAME, never the STOP suffix — the suffix is the part that matters. */
function withStop(prefix: string, optOut: boolean): string {
  const suffix = optOut ? STOP_SUFFIX : '';
  const room = SUBJECT_MAX - suffix.length;
  return `${prefix.length > room ? prefix.slice(0, room) : prefix}${suffix}`;
}

export function textTaskSubject(name: string | null, fromE164: string, optOut: boolean): string {
  return withStop(`Text from ${senderLabel(name, fromE164)}`, optOut);
}

/** Twilio keeps MMS media behind auth; the rep has to open Twilio to see it. */
function attachmentNote(numMedia: number): string | null {
  if (!(numMedia > 0)) return null;
  return `(${numMedia} attachment${numMedia === 1 ? '' : 's'} — open Twilio to view)`;
}

export function textTaskDescription(body: string, numMedia: number): string {
  const note = attachmentNote(numMedia);
  if (!note) return body;
  return body ? `${body}\n\n${note}` : note;
}

/**
 * Who gets the text. Agent numbers belong to one rep. Pool numbers are shared,
 * so they route exactly like a callback to that number: the rep the caller is
 * sticky to (they actually talked), else the rep who last power-dialed them.
 * Null = nobody, and the webhook stores the row as `skipped`.
 */
export function chooseTextRecipient(
  number: Pick<OutboundNumber, 'kind' | 'assignedUserId'>,
  stickyRep: string | null,
  lastDialerRep: string | null,
): string | null {
  if (number.kind === 'agent') return number.assignedUserId ?? null;
  if (number.kind === 'dialer_pool') return stickyRep ?? lastDialerRep ?? null;
  return null;
}

/** Lead (00Q) and Contact (003) are the only objects a Task's WhoId accepts. */
const WHO_PREFIXES: ReadonlySet<string> = new Set(['00Q', '003']);

export interface SenderMatch {
  whoId?: string;
  whatId?: string;
  name?: string;
}

/**
 * The Task's WhoId/WhatId for a `findByPhone` match. A Lead or Contact is the
 * Who; anything else (Deal__c, and defensively an Account that ever arrives as
 * a "who") is the What — an Account in WhoId is rejected by Salesforce and
 * would cost the rep the task. A Lead never carries a WhatId: Salesforce does
 * not allow a Task to relate a Lead to another record.
 */
export function textTaskLinks(match: SenderMatch | null): { WhoId?: string; WhatId?: string } {
  if (!match) return {};
  const who = match.whoId && WHO_PREFIXES.has(match.whoId.slice(0, 3)) ? match.whoId : undefined;
  const what = match.whatId ?? (match.whoId && !who ? match.whoId : undefined);
  if (who?.startsWith('00Q')) return { WhoId: who };
  return { ...(who ? { WhoId: who } : {}), ...(what ? { WhatId: what } : {}) };
}

/** A Lightning link to any record on the rep's Salesforce instance. */
export function salesforceRecordUrl(instanceUrl: string, recordId: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/lightning/r/${recordId}/view`;
}

/** The rep's Salesforce home — the link when there is no record to point at
 *  (nobody matched AND the Task could not be created). */
export function salesforceHomeUrl(instanceUrl: string): string {
  return `${instanceUrl.replace(/\/+$/, '')}/lightning/page/home`;
}

/**
 * Which record the email's link opens. The Opportunity first — for a Contact,
 * texts link like inbound calls (findByPhone's `preferOpenOpportunity`), and
 * the open deal is what the team actually works. Then the Lead or Contact,
 * never an Account; then a What-only match (Deal__c); then the Task itself
 * when nobody matched. Null = nothing to open (no match, no Task): the caller
 * links the Salesforce home page instead.
 */
export function textEmailLinkTarget(links: { WhoId?: string; WhatId?: string }, taskId: string | null): string | null {
  if (links.WhatId?.startsWith('006')) return links.WhatId;
  if (links.WhoId) return links.WhoId;
  if (links.WhatId && !links.WhatId.startsWith('001')) return links.WhatId;
  return taskId;
}

/** Salesforce error codes that clear on their own: row-lock contention and the org's API limit. */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set(['UNABLE_TO_LOCK_ROW', 'REQUEST_LIMIT_EXCEEDED', 'SERVER_UNAVAILABLE']);

/**
 * Is a failed Task create worth another try? A 400 or 403 is Salesforce looking
 * at the Task and saying no (a validation rule, a required field, no access):
 * it will say no again, so the worker stops retrying and alerts the rep at once
 * instead of three retries (about 12 minutes) later. Server errors,
 * throttling, timeouts and the codes in TRANSIENT_ERROR_CODES do clear.
 * A 401 never gets here — auth is terminal before this is asked.
 */
export function taskFailureIsRetryable(status: number, json: unknown): boolean {
  const entries = Array.isArray(json) ? json : [json];
  const transientCode = entries.some((e) => {
    const code = (e as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code);
  });
  if (transientCode) return true;
  return !(status >= 400 && status < 500) || status === 408 || status === 409 || status === 429;
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: ORG_TIMEZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** "Fri, Sep 25, 2026, 2:05 PM PDT". ICU puts a narrow no-break space before
 *  AM/PM; a plain space survives every mail client. */
export function pacificTime(at: Date): string {
  return PACIFIC.format(at).replace(/[  ]/g, ' ');
}

export interface TextEmailInput {
  name: string | null;
  fromE164: string;
  toE164: string;
  receivedAt: Date;
  body: string;
  numMedia: number;
  /** The matched record (or the Task) in Salesforce; null leaves the line out. */
  recordUrl: string | null;
  optOut: boolean;
  /** The Task could not be created — the email is the only trace of the text. */
  notLogged?: boolean;
}

/**
 * The texter's words, every line prefixed "> ". A text is written by a stranger:
 * quoting it keeps anything it says — including a line that reads exactly like
 * our own "Open in Salesforce: <link>" — visibly theirs, never ours. Exported
 * for `textDigestEmail`, which quotes each of its entries the same way.
 */
export function quotedMessage(body: string): string[] {
  if (!body.trim()) return ['> (no text)'];
  return body.split(/\r\n|\r|\n/).map((line) => (line ? `> ${line}` : '>'));
}

/** The rep's alert. Plain text on purpose: emailSimple sends it as-is, and a
 *  text message is plain text anyway. Our own lines (the header, the attachment
 *  note, the link) are never quoted; the texter's always are. */
export function textEmail(input: TextEmailInput): { subject: string; body: string } {
  const name = input.name?.trim() || null;
  const number = formatUsNumber(input.fromE164);
  const note = attachmentNote(input.numMedia);
  const lines = [
    `From: ${name ? `${name} ${number}` : number}`,
    `To your number: ${formatUsNumber(input.toE164)}`,
    `Received: ${pacificTime(input.receivedAt)}`,
    ...(input.optOut ? ['They asked to STOP.'] : []),
    ...(input.notLogged ? ['This text could not be logged to Salesforce — there is no Task for it.'] : []),
    '',
    'Message:',
    ...quotedMessage(input.body),
    ...(note ? [note] : []),
    ...(input.recordUrl ? ['', `Open in Salesforce: ${input.recordUrl}`] : []),
  ];
  return {
    subject: withStop(`New text from ${senderLabel(name, input.fromE164)}`, input.optOut),
    body: lines.join('\n'),
  };
}

const PACIFIC_DATE_ONLY = new Intl.DateTimeFormat('en-US', {
  timeZone: ORG_TIMEZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "Sep 25, 2026" — the digest subject's "since" anchor (the batch's earliest text). */
export function pacificDateOnly(at: Date): string {
  return PACIFIC_DATE_ONLY.format(at);
}

export interface DigestEntry {
  /** The Salesforce name when the sender matched (a Lead/Contact); null shows the formatted number instead. */
  name: string | null;
  fromE164: string;
  receivedAt: Date;
  body: string;
  numMedia: number;
  /** The rep's Task (or matched record) for THIS text; null leaves the link line out entirely. */
  recordUrl: string | null;
}

/** One digest entry: sender, Pacific time, the quoted message, the attachment
 *  note when there is one, then the record link — mirrors `textEmail`'s single-
 *  text layout, minus the "To your number" line (a digest spans many numbers). */
function digestEntryBlock(entry: DigestEntry): string {
  const note = attachmentNote(entry.numMedia);
  const name = entry.name?.trim() || null;
  const number = formatUsNumber(entry.fromE164);
  const lines = [
    // Same "Name (number)" / bare-number convention as textEmail's From: line.
    `From: ${name ? `${name} ${number}` : number}`,
    `Received: ${pacificTime(entry.receivedAt)}`,
    'Message:',
    ...quotedMessage(entry.body),
    ...(note ? [note] : []),
    ...(entry.recordUrl ? [`Open in Salesforce: ${entry.recordUrl}`] : []),
  ];
  return lines.join('\n');
}

/**
 * The ONE email a rep gets for a whole backfill batch (design task 6), instead
 * of an individual alert per text — see inbound-text-worker.ts's digest step.
 * Entries must already be oldest-first (the worker's SQL orders by
 * `received_at`); this function does not re-sort them.
 */
export function textDigestEmail(entries: readonly DigestEntry[]): { subject: string; body: string } {
  const n = entries.length;
  const since = entries.length > 0 ? pacificDateOnly(entries[0]!.receivedAt) : pacificDateOnly(new Date());
  return {
    subject: `${n} texts you missed (${since} – today)`,
    body: entries.map(digestEntryBlock).join('\n\n'),
  };
}
