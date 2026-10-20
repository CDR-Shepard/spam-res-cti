/** Task 11 (pure part): the Salesforce Task a timeline event becomes. No database, no Salesforce. */
import { describe, expect, it } from 'vitest';
import { FlagReason } from '@cti/contracts';
import { backoffMinutes, sfTaskForEvent, SF_LOG_MAX_ATTEMPTS, type SfLogEvent, type SfTaskTarget } from './sf-log.js';

const LEAD = '00Q8X00000AbCdEUAV';
const OPP = '0068X00000Oppt1QAA';
const OWNER = '0058X00000Fsx39QAB';
const APP = 'https://app.example.com';
const SELLER_PAGE = `${APP}/sellers/${LEAD}`;
const EVENT_ID = '6f0c2a9e-1b2c-4d5e-8f90-123456789abc';
/** The link as the Description carries it: the seller's page, tagged with the event that made the Task. */
const LINK = `Conversation: ${SELLER_PAGE}#event-${EVENT_ID}`;

const target = (over: Partial<SfTaskTarget> = {}): SfTaskTarget => ({
  sfObject: 'Lead',
  targetId: LEAD,
  ownerId: OWNER,
  orgTimeZone: 'America/Los_Angeles',
  appPublicUrl: APP,
  conversationUrl: SELLER_PAGE,
  ...over,
});

const event = (over: Partial<SfLogEvent> = {}): SfLogEvent => ({
  id: EVENT_ID,
  kind: 'email',
  direction: 'in',
  actor: 'seller',
  occurredAt: new Date('2026-10-20T17:00:00.000Z'),
  subject: 'Re: Your home',
  body: 'Yes, still for sale.',
  detail: null,
  ...over,
});

describe('sfTaskForEvent: email', () => {
  it('an inbound email on a Lead is a completed Email Task on the Lead (WhoId)', () => {
    const f = sfTaskForEvent(event(), target());
    expect(f).toMatchObject({
      Subject: 'Email reply from seller: Re: Your home',
      Status: 'Completed',
      TaskSubtype: 'Email',
      WhoId: LEAD,
      OwnerId: OWNER,
      CTI_Origin__c: 'AI Outreach',
    });
    expect(f).not.toHaveProperty('WhatId');
    expect(f).not.toHaveProperty('Priority');
    expect(f.Description).toBe(`Yes, still for sale.\n\n${LINK}`);
  });

  it('an email from an address other than the seller\'s says so in the Subject (M8)', () => {
    expect(sfTaskForEvent(event({ otherSender: true }), target()).Subject).toBe('Email from another address: Re: Your home');
    expect(sfTaskForEvent(event({ otherSender: true, subject: '  ' }), target()).Subject).toBe('Email from another address: (no subject)');
    expect(sfTaskForEvent(event({ otherSender: false }), target()).Subject).toBe('Email reply from seller: Re: Your home');
  });

  it('an outbound email from Sam says so in the Subject', () => {
    const f = sfTaskForEvent(event({ direction: 'out', actor: 'sam', subject: 'Your home on Oak Street' }), target());
    expect(f.Subject).toBe('Email from Sam (AI): Your home on Oak Street');
    expect(f.TaskSubtype).toBe('Email');
    expect(f.Status).toBe('Completed');
  });

  it('on an Opportunity the Task hangs from WhatId, never WhoId', () => {
    const f = sfTaskForEvent(event(), target({ sfObject: 'Opportunity', targetId: OPP, conversationUrl: `${APP}/sellers/${OPP}` }));
    expect(f).toMatchObject({ WhatId: OPP });
    expect(f).not.toHaveProperty('WhoId');
  });

  it('a blank subject reads (no subject), and a subject with line breaks becomes one line within 255 characters', () => {
    expect(sfTaskForEvent(event({ subject: '   ' }), target()).Subject).toBe('Email reply from seller: (no subject)');
    expect(sfTaskForEvent(event({ subject: null }), target()).Subject).toBe('Email reply from seller: (no subject)');
    const long = sfTaskForEvent(event({ subject: `Line one\r\nBcc: x\n${'y'.repeat(400)}` }), target());
    expect(String(long.Subject)).not.toMatch(/[\r\n]/);
    expect(String(long.Subject).length).toBeLessThanOrEqual(255);
  });

  it('caps a 40,000-character body at 30,000 and still ends with the conversation link', () => {
    const f = sfTaskForEvent(event({ body: 'a'.repeat(40_000) }), target());
    const description = String(f.Description);
    expect(description).toBe(`${'a'.repeat(30_000)}\n\n${LINK}`);
    expect(description.length).toBeLessThan(32_000);
  });

  it('tags the link with the event, whatever the kind and however long the body: the tag is how a retry finds its own Task', () => {
    const marker = `#event-${EVENT_ID}`;
    const kinds = [
      event({ body: 'a'.repeat(40_000) }),
      event({ kind: 'flag', direction: 'none', actor: 'system', subject: null, body: null, detail: 'legal' }),
      event({ kind: 'status', direction: 'none', actor: 'system', subject: null, body: null, detail: 'opted_out' }),
    ];
    for (const e of kinds) {
      const description = String(sfTaskForEvent(e, target()).Description);
      expect(description.endsWith(`${SELLER_PAGE}${marker}`)).toBe(true);
      expect(description.length).toBeLessThan(32_000);
    }
    // Two events of one seller differ only in the tag.
    const other = String(sfTaskForEvent(event({ id: '00000000-0000-4000-8000-000000000000' }), target()).Description);
    expect(other).not.toContain(marker);
  });

  it('never cuts a surrogate pair in half at the cap', () => {
    const f = sfTaskForEvent(event({ body: `${'a'.repeat(29_999)}😀tail` }), target());
    expect(String(f.Description).startsWith('a'.repeat(29_999))).toBe(true);
    expect(String(f.Description)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('a blank body falls back to the detail, and with neither the Description is the link alone', () => {
    expect(sfTaskForEvent(event({ body: '  ', detail: 'a note' }), target()).Description).toBe(`a note\n\n${LINK}`);
    expect(sfTaskForEvent(event({ body: null }), target()).Description).toBe(LINK);
  });
});

describe('sfTaskForEvent: flags', () => {
  it('offer_or_price is an open, high-priority Task a person must pick up', () => {
    const f = sfTaskForEvent(event({ kind: 'flag', direction: 'none', actor: 'system', subject: null, body: null, detail: 'offer_or_price' }), target());
    expect(f).toMatchObject({ Subject: 'Sam (AI) needs a person: asked about an offer or price', Status: 'Open', Priority: 'High', WhoId: LEAD });
    expect(f).not.toHaveProperty('TaskSubtype');
    expect(f.Description).toBe(`offer_or_price\n\n${LINK}`);
  });

  it.each<[FlagReason, string]>([
    ['offer_or_price', 'asked about an offer or price'],
    ['angry_or_threat', 'upset or threatening'],
    ['legal', 'mentioned an attorney or legal action'],
    ['not_owner', 'says they are not the owner'],
    ['wants_appointment', 'wants to set a time'],
    ['unsure', 'Sam was not sure how to answer'],
    ['other_sender', 'a reply came from another address'],
    ['loop_guard', 'many replies today'],
    ['after_close', 'replied after booking or closing'],
    ['draft_rejected', "Sam's reply did not pass the checks"],
  ])('%s → %s', (reason, words) => {
    const f = sfTaskForEvent(event({ kind: 'flag', direction: 'none', actor: 'system', subject: null, body: null, detail: reason }), target());
    expect(f.Subject).toBe(`Sam (AI) needs a person: ${words}`);
  });

  it('every FlagReason has words', () => {
    for (const reason of FlagReason.options) {
      const f = sfTaskForEvent(event({ kind: 'flag', direction: 'none', actor: 'system', detail: reason }), target());
      expect(f.Subject).not.toBe(`Sam (AI) needs a person: ${reason}`);
    }
  });

  it('a reason this build does not know is shown as stored; none at all still reads sensibly', () => {
    const base = { kind: 'flag' as const, direction: 'none' as const, actor: 'system' as const, subject: null, body: null };
    expect(sfTaskForEvent(event({ ...base, detail: 'brand_new' }), target()).Subject).toBe('Sam (AI) needs a person: brand_new');
    expect(sfTaskForEvent(event({ ...base, detail: null }), target()).Subject).toBe('Sam (AI) needs a person');
  });
});

describe('sfTaskForEvent: status', () => {
  const status = (detail: string | null) => event({ kind: 'status', direction: 'none', actor: 'system', subject: null, body: null, detail });

  it.each<[string, string]>([
    ['opted_out', 'Opted out of Sam (AI)'],
    ['complained', "Spam complaint about Sam's email"],
    ['asked_to_stop', 'Asked Sam (AI) to stop'],
    ['not_interested', 'Not interested (Sam AI)'],
    ['something_else', 'Sam (AI) conversation: something_else'],
  ])('%s → %s (completed, no Email subtype)', (detail, subject) => {
    const f = sfTaskForEvent(status(detail), target());
    expect(f).toMatchObject({ Subject: subject, Status: 'Completed' });
    expect(f).not.toHaveProperty('TaskSubtype');
    expect(f).not.toHaveProperty('Priority');
  });

  it('a detail named like an inherited object member is just text', () => {
    expect(sfTaskForEvent(status('constructor'), target()).Subject).toBe('Sam (AI) conversation: constructor');
    expect(sfTaskForEvent(event({ kind: 'flag', direction: 'none', actor: 'system', detail: 'constructor' }), target()).Subject).toBe('Sam (AI) needs a person: constructor');
  });

  it('any other kind that somehow reached pending is still logged, by its kind', () => {
    expect(sfTaskForEvent(event({ kind: 'note', direction: 'none', actor: 'person', subject: null, body: 'Called the seller', detail: null }), target())).toMatchObject({
      Subject: 'Sam (AI): note',
      Status: 'Completed',
    });
  });
});

describe('sfTaskForEvent: ActivityDate (the org-time-zone date of occurred_at)', () => {
  // 2026-10-21T02:30Z is still the 20th in Los Angeles (19:30 PDT) and already the 21st in Auckland (15:30 NZDT).
  const late = event({ occurredAt: new Date('2026-10-21T02:30:00.000Z') });

  it('uses the organization zone', () => {
    expect(sfTaskForEvent(late, target({ orgTimeZone: 'America/Los_Angeles' })).ActivityDate).toBe('2026-10-20');
    expect(sfTaskForEvent(late, target({ orgTimeZone: 'Pacific/Auckland' })).ActivityDate).toBe('2026-10-21');
  });

  it('reads Pacific when the zone is blank or not a zone', () => {
    expect(sfTaskForEvent(late, target({ orgTimeZone: '' })).ActivityDate).toBe('2026-10-20');
    expect(sfTaskForEvent(late, target({ orgTimeZone: 'Not/AZone' })).ActivityDate).toBe('2026-10-20');
  });
});

describe('backoff', () => {
  it('waits 1, 5, 30, 120 and 720 minutes after the 1st to 5th failure, and there is no 6th wait', () => {
    expect([1, 2, 3, 4, 5].map(backoffMinutes)).toEqual([1, 5, 30, 120, 720]);
    expect(SF_LOG_MAX_ATTEMPTS).toBe(6);
  });
});
