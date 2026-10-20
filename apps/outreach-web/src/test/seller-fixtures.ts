import type { ConversationView, SamEmailSettings, TimelineItem } from '@cti/contracts';

/** An 18-character Lead id, as the seller page's route carries it. */
export const SELLER_ID = '00Q5e00000Abc01AAA';
export const RECORD_URL = `https://gghomes.my.salesforce.com/${SELLER_ID}`;

/** A well-formed uuid for the nth timeline row. */
export const rowId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Of<T extends TimelineItem['type']> = Extract<TimelineItem, { type: T }>;

export function callItem(over: Partial<Of<'call'>> = {}): Of<'call'> {
  return { type: 'call', id: rowId(1), at: '2026-10-19T17:00:00.000Z', outcome: 'qualified_callback', summary: 'Wants a call back Thursday evening.', durationSeconds: 192, transcriptAvailable: false, ...over };
}

export function emailItem(over: Partial<Of<'email'>> = {}): Of<'email'> {
  return {
    type: 'email', id: rowId(2), at: '2026-10-19T18:00:00.000Z', direction: 'out', actor: 'sam', subject: 'About your house',
    body: 'Hi Jane,\nI am Sam, an AI assistant.', status: 'delivered', autoReply: false, notSentReason: null, ...over,
  };
}

export function noteItem(over: Partial<Of<'note'>> = {}): Of<'note'> {
  return { type: 'note', id: rowId(3), at: '2026-10-19T19:00:00.000Z', kind: 'handler', detail: 'taken_over', byName: 'Dana', ...over };
}

export function sellerView(over: Partial<ConversationView> = {}): ConversationView {
  return {
    sfRecordId: SELLER_ID,
    sfObject: 'Lead',
    name: 'Jane Seller',
    recordUrl: RECORD_URL,
    conversationId: rowId(90),
    handler: 'sam',
    handlerName: null,
    status: 'open',
    stopReason: null,
    flagReason: null,
    emailAddress: 'jane@example.com',
    emailBlock: null,
    draftBlock: null,
    mayEmail: true,
    mayChangeHandler: true,
    items: [callItem(), emailItem({ direction: 'in', actor: 'seller', status: 'received' }), noteItem()],
    ...over,
  };
}

export function samEmailSettings(over: Partial<SamEmailSettings> = {}): SamEmailSettings {
  return { enabled: false, configured: true, pausedAt: null, pausedReason: null, ...over };
}
