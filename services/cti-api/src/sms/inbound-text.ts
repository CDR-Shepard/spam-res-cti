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
}

/** The rep's alert. Plain text on purpose: emailSimple sends it as-is, and a
 *  text message is plain text anyway. */
export function textEmail(input: TextEmailInput): { subject: string; body: string } {
  const name = input.name?.trim() || null;
  const number = formatUsNumber(input.fromE164);
  const lines = [
    `From: ${name ? `${name} ${number}` : number}`,
    `To your number: ${formatUsNumber(input.toE164)}`,
    `Received: ${pacificTime(input.receivedAt)}`,
    ...(input.optOut ? ['They asked to STOP.'] : []),
    '',
    textTaskDescription(input.body, input.numMedia),
    ...(input.recordUrl ? ['', `Open in Salesforce: ${input.recordUrl}`] : []),
  ];
  return {
    subject: withStop(`New text from ${senderLabel(name, input.fromE164)}`, input.optOut),
    body: lines.join('\n'),
  };
}
