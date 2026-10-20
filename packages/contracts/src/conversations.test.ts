import { describe, expect, it } from 'vitest';
import {
  ConversationHandler,
  ConversationStatus,
  ConversationView,
  EMAIL_BODY_MAX,
  EMAIL_SUBJECT_MAX,
  EmailBlock,
  EmailDraft,
  EmailDraftRequest,
  EmailDraftResponse,
  EmailSendRequest,
  EmailSendResponse,
  EmailStatus,
  FlagReason,
  HandlerChangeRequest,
  SamEmailSettings,
  SamEmailSettingsSave,
  StopReason,
  TimelineItem,
} from './conversations.js';
import * as contracts from './index.js';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const AT = '2026-10-19T12:00:00.000Z';

const callItem = { type: 'call', id: ID, at: AT, outcome: 'voicemail', summary: 'Left a message.', durationSeconds: 42, transcriptAvailable: true };
const emailItem = {
  type: 'email',
  id: ID,
  at: AT,
  direction: 'out',
  actor: 'sam',
  subject: 'Following up',
  body: 'Hello from Sam.',
  status: 'delivered',
  autoReply: false,
  notSentReason: null,
};
const noteItem = { type: 'note', id: ID, at: AT, kind: 'handler', detail: 'A person took over.', byName: 'Pat' };
const view = {
  sfRecordId: '00Q000000000001AAA',
  sfObject: 'Lead',
  name: 'Sample Seller',
  recordUrl: 'https://example.my.salesforce.com/00Q000000000001AAA',
  conversationId: ID,
  handler: 'sam',
  handlerName: null,
  status: 'open',
  stopReason: null,
  flagReason: null,
  emailAddress: 'seller@example.com',
  emailBlock: null,
  mayEmail: true,
  mayChangeHandler: false,
  items: [callItem, emailItem, noteItem],
};

describe('conversation enums', () => {
  it('EmailBlock lists every reason Sam may not email, in order', () => {
    expect(EmailBlock.options).toEqual([
      'not_configured', 'disabled', 'paused', 'no_address', 'suppressed', 'sf_opt_out', 'stopped', 'booked', 'closed',
      'taken_over', 'flagged', 'not_approved', 'daily_cap',
    ]);
  });

  it('pins the other lists the tables and the pages share', () => {
    expect(ConversationHandler.options).toEqual(['sam', 'person']);
    expect(ConversationStatus.options).toEqual(['open', 'booked', 'stopped']);
    expect(StopReason.options).toEqual(['opted_out', 'complained', 'asked_to_stop', 'not_interested']);
    expect(FlagReason.options).toEqual([
      'offer_or_price', 'angry_or_threat', 'legal', 'not_owner', 'wants_appointment', 'unsure', 'other_sender', 'loop_guard',
      'after_close', 'draft_rejected',
    ]);
    expect(EmailStatus.options).toEqual(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'canceled', 'received']);
  });

  it('refuses a value outside the list', () => {
    expect(ConversationHandler.safeParse('robot').success).toBe(false);
    expect(EmailBlock.safeParse('whenever').success).toBe(false);
  });
});

describe('EmailDraft', () => {
  const draft = { subject: 'Hello', body: 'Body text.' };

  it('accepts a subject and a body', () => {
    expect(EmailDraft.parse(draft)).toEqual(draft);
    expect(EMAIL_SUBJECT_MAX).toBe(150);
    expect(EMAIL_BODY_MAX).toBe(3000);
  });

  it('refuses a subject containing a newline (it would become a header)', () => {
    expect(EmailDraft.safeParse({ ...draft, subject: 'Hello\nBcc: someone@example.com' }).success).toBe(false);
    expect(EmailDraft.safeParse({ ...draft, subject: 'Hello\rthere' }).success).toBe(false);
  });

  it('refuses a 3001-character body and accepts 3000', () => {
    expect(EmailDraft.safeParse({ ...draft, body: 'a'.repeat(3001) }).success).toBe(false);
    expect(EmailDraft.safeParse({ ...draft, body: 'a'.repeat(3000) }).success).toBe(true);
  });

  it('refuses an empty subject or body and a 151-character subject', () => {
    expect(EmailDraft.safeParse({ ...draft, subject: '' }).success).toBe(false);
    expect(EmailDraft.safeParse({ ...draft, body: '' }).success).toBe(false);
    expect(EmailDraft.safeParse({ ...draft, subject: 'a'.repeat(151) }).success).toBe(false);
    expect(EmailDraft.safeParse({ ...draft, subject: 'a'.repeat(150) }).success).toBe(true);
  });

  it('keeps newlines in the body', () => {
    expect(EmailDraft.parse({ ...draft, body: 'One.\n\nTwo.' }).body).toBe('One.\n\nTwo.');
  });
});

describe('email request and response shapes', () => {
  it('EmailDraftRequest takes the practice flag', () => {
    expect(EmailDraftRequest.parse({ practice: false })).toEqual({ practice: false });
    expect(EmailDraftRequest.safeParse({}).success).toBe(false);
  });

  it('EmailDraftResponse is a draft plus the address it goes to', () => {
    expect(EmailDraftResponse.parse({ subject: 'Hi', body: 'Body.', to: 'delivered@resend.dev' }).to).toBe('delivered@resend.dev');
    expect(EmailDraftResponse.safeParse({ subject: 'Hi', body: 'Body.' }).success).toBe(false);
    expect(EmailDraftResponse.safeParse({ subject: 'Hi\n', body: 'Body.', to: 'delivered@resend.dev' }).success).toBe(false);
  });

  it('EmailSendRequest is a draft plus the practice flag', () => {
    expect(EmailSendRequest.parse({ subject: 'Hi', body: 'Body.', practice: true }).practice).toBe(true);
    expect(EmailSendRequest.safeParse({ subject: 'Hi', body: 'Body.' }).success).toBe(false);
  });

  it('EmailSendResponse names the queued email, when it goes and where', () => {
    const ok = { emailId: ID, sendAfter: AT, to: 'delivered@resend.dev' };
    expect(EmailSendResponse.parse(ok)).toEqual(ok);
    expect(EmailSendResponse.safeParse({ ...ok, emailId: 'nope' }).success).toBe(false);
  });

  it('HandlerChangeRequest takes sam or person', () => {
    expect(HandlerChangeRequest.parse({ handler: 'person' })).toEqual({ handler: 'person' });
    expect(HandlerChangeRequest.safeParse({ handler: 'robot' }).success).toBe(false);
  });

  it('SamEmailSettings and its save shape', () => {
    const settings = { enabled: true, configured: true, pausedAt: AT, pausedReason: 'complaint' };
    expect(SamEmailSettings.parse(settings)).toEqual(settings);
    expect(SamEmailSettings.parse({ ...settings, pausedAt: null, pausedReason: null }).pausedAt).toBeNull();
    expect(SamEmailSettingsSave.parse({ enabled: false })).toEqual({ enabled: false });
    expect(SamEmailSettingsSave.safeParse({}).success).toBe(false);
  });
});

describe('TimelineItem', () => {
  it('parses one item of each type', () => {
    expect(TimelineItem.parse(callItem)).toEqual(callItem);
    expect(TimelineItem.parse(emailItem)).toEqual(emailItem);
    expect(TimelineItem.parse(noteItem)).toEqual(noteItem);
  });

  it('a call may have no outcome yet; a note may have no author', () => {
    expect(TimelineItem.parse({ ...callItem, outcome: null }).type).toBe('call');
    expect(TimelineItem.parse({ ...noteItem, byName: null }).type).toBe('note');
  });

  it('a call outcome is an AiCallOutcome', () => {
    expect(TimelineItem.safeParse({ ...callItem, outcome: 'appointment_set' }).success).toBe(true);
    expect(TimelineItem.safeParse({ ...callItem, outcome: 'made_up' }).success).toBe(false);
  });

  it('an email carries its status and why it was not sent', () => {
    expect(TimelineItem.parse({ ...emailItem, direction: 'in', actor: 'seller', status: 'received', autoReply: true }).type).toBe('email');
    expect(TimelineItem.parse({ ...emailItem, status: 'canceled', notSentReason: 'suppressed' }).type).toBe('email');
    expect(TimelineItem.safeParse({ ...emailItem, actor: 'system' }).success).toBe(false);
    expect(TimelineItem.safeParse({ ...emailItem, notSentReason: 'whenever' }).success).toBe(false);
  });

  it('a note is a hand-over, a status change or a flag', () => {
    for (const kind of ['handler', 'status', 'flag']) expect(TimelineItem.safeParse({ ...noteItem, kind }).success).toBe(true);
    expect(TimelineItem.safeParse({ ...noteItem, kind: 'email' }).success).toBe(false);
  });

  it('refuses an unknown type', () => {
    expect(TimelineItem.safeParse({ ...noteItem, type: 'text' }).success).toBe(false);
  });
});

describe('ConversationView', () => {
  it('parses a seller page with every kind of item', () => {
    expect(ConversationView.parse(view)).toEqual(view);
  });

  it('a seller who has no conversation yet has a null conversationId and no items', () => {
    expect(ConversationView.parse({ ...view, conversationId: null, items: [] }).items).toEqual([]);
  });

  it('carries a stop reason, a flag reason and the reason Sam may not email', () => {
    const parsed = ConversationView.parse({
      ...view, status: 'stopped', stopReason: 'opted_out', flagReason: 'legal', emailBlock: 'stopped', mayEmail: false,
      handler: 'person', handlerName: 'Pat',
    });
    expect(parsed.stopReason).toBe('opted_out');
    expect(parsed.handlerName).toBe('Pat');
  });

  it('refuses an item that is not a timeline item', () => {
    expect(ConversationView.safeParse({ ...view, items: [{ type: 'call' }] }).success).toBe(false);
  });
});

describe('index', () => {
  it('re-exports the conversation contracts', () => {
    expect(contracts.TimelineItem).toBe(TimelineItem);
    expect(contracts.EMAIL_SUBJECT_MAX).toBe(150);
  });
});
