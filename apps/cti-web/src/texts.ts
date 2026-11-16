/**
 * The Texts tab's data: the rep's texts from the API, the wording each row
 * uses, and the "seen up to" time behind the tab's badge.
 *
 * The seen time lives in this browser's storage, one key per rep, so every
 * Salesforce tab the rep has open shares it. It only ever moves forward.
 */
import { api } from './api';
import { formatE164 } from './format';

/** Where a text stands in Salesforce (GET /texts `salesforce`). */
export type TextSalesforceState = 'logged' | 'pending' | 'reconnect' | 'failed';

/** One row of GET /texts. */
export interface TextItem {
  id: string;
  fromE164: string;
  toE164: string;
  body: string;
  numMedia: number;
  receivedAt: string;
  optOut: boolean;
  salesforce: TextSalesforceState;
  senderName: string | null;
  /** What a tap opens in Salesforce; null = nothing to open. */
  openRecordId: string | null;
}

export const TEXTS_LIST_LIMIT = 50;
/** A rep who never opened the tab sees a badge for the past week's texts. */
export const TEXTS_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const SEEN_KEY_PREFIX = 'cti.texts.seenAt.v1:';

export function textsSeenKey(userId: string): string {
  return `${SEEN_KEY_PREFIX}${userId}`;
}

function storedSeenAt(userId: string): number | null {
  try {
    const raw = localStorage.getItem(textsSeenKey(userId));
    const at = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The time the badge counts from: the newest text the rep has seen, else a week ago. */
export function readTextsSeenAt(userId: string, now: number = Date.now()): string {
  return new Date(storedSeenAt(userId) ?? now - TEXTS_LOOKBACK_MS).toISOString();
}

/** Record that the rep has seen every text up to `receivedAt`. Never moves back. */
export function markTextsSeen(userId: string, receivedAt: string): void {
  const at = Date.parse(receivedAt);
  if (!Number.isFinite(at)) return;
  const prev = storedSeenAt(userId);
  if (prev !== null && prev >= at) return;
  try {
    localStorage.setItem(textsSeenKey(userId), new Date(at).toISOString());
  } catch {
    // Storage blocked: the badge just counts from a week back again.
  }
}

/** The badge text: nothing for none, 1–9, then "9+". */
export function badgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** Who the row is from: the Salesforce name, else the number. */
export function senderHeadline(item: Pick<TextItem, 'senderName' | 'fromE164'>): string {
  return item.senderName ?? formatE164(item.fromE164);
}

/** The Salesforce note under a text. Nothing when it is logged, which is the norm. */
export function textStatusLabel(item: Pick<TextItem, 'salesforce'>): string | null {
  switch (item.salesforce) {
    case 'logged': return null;
    case 'pending': return 'Logging to Salesforce…';
    case 'reconnect': return 'Not in Salesforce · sign-in expired';
    case 'failed': return 'Not in Salesforce';
  }
}

/** Pictures and files stay with Twilio, so the tab can only count them. */
export function attachmentLabel(numMedia: number): string | null {
  if (!(numMedia > 0)) return null;
  return `${numMedia} attachment${numMedia === 1 ? '' : 's'} (not shown)`;
}

export async function fetchTexts(): Promise<TextItem[]> {
  const data = await api<{ texts: TextItem[] }>(`/texts?limit=${TEXTS_LIST_LIMIT}`);
  return data.texts;
}

/** How many of the rep's texts arrived after `since` (ISO). */
export async function fetchNewTextCount(since: string): Promise<number> {
  const data = await api<{ count?: unknown }>(`/texts/new?since=${encodeURIComponent(since)}`);
  return typeof data?.count === 'number' && Number.isFinite(data.count) ? data.count : 0;
}
