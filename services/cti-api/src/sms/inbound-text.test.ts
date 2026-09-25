import { describe, expect, it } from 'vitest';
import {
  OPT_OUT_WORDS,
  chooseTextRecipient,
  formatUsNumber,
  isOptOutText,
  pacificTime,
  redactBody,
  salesforceHomeUrl,
  salesforceRecordUrl,
  taskFailureIsRetryable,
  textEmail,
  textEmailLinkTarget,
  textTaskDescription,
  textTaskLinks,
  textTaskSubject,
} from './inbound-text.js';

describe('isOptOutText', () => {
  it.each(OPT_OUT_WORDS.map((w) => [w]))('%s is an opt-out, in any case and with surrounding whitespace', (word) => {
    expect(isOptOutText(word)).toBe(true);
    expect(isOptOutText(word.toLowerCase())).toBe(true);
    expect(isOptOutText(`  ${word[0]}${word.slice(1).toLowerCase()} \n`)).toBe(true);
  });

  it('covers exactly the six carrier opt-out words', () => {
    expect([...OPT_OUT_WORDS]).toEqual(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
  });

  it.each([
    ['stop calling me'],
    ['Stopped'],
    ['please stop'],
    ['STOP STOP'],
    ['unsubscribed'],
    ['the END of the month works'],
    ['cancel my appointment'],
    [''],
    ['   '],
  ])('%j is NOT an opt-out — only the whole message counts', (body) => {
    expect(isOptOutText(body)).toBe(false);
  });

  it('is false for a missing body (an MMS with no text)', () => {
    expect(isOptOutText(null)).toBe(false);
    expect(isOptOutText(undefined)).toBe(false);
  });
});

describe('formatUsNumber', () => {
  it('formats a US E.164 number the way a rep reads it', () => {
    expect(formatUsNumber('+16195550100')).toBe('(619) 555-0100');
  });

  it('leaves anything that is not a +1 ten-digit number as it came', () => {
    expect(formatUsNumber('+442071838750')).toBe('+442071838750');
    expect(formatUsNumber('anonymous')).toBe('anonymous');
    expect(formatUsNumber('+1619555010')).toBe('+1619555010');
  });
});

describe('textTaskSubject', () => {
  it('names the sender when Salesforce knows them', () => {
    expect(textTaskSubject('Jane Doe', '+16195550100', false)).toBe('Text from Jane Doe');
  });

  it('falls back to the formatted number when nobody matched', () => {
    expect(textTaskSubject(null, '+16195550100', false)).toBe('Text from (619) 555-0100');
    expect(textTaskSubject('   ', '+16195550100', false)).toBe('Text from (619) 555-0100');
  });

  it('says they asked to STOP when the text is an opt-out', () => {
    expect(textTaskSubject('Jane Doe', '+16195550100', true)).toBe('Text from Jane Doe — asked to STOP');
    expect(textTaskSubject(null, '+16195550100', true)).toBe('Text from (619) 555-0100 — asked to STOP');
  });

  it('never exceeds the 255 characters Salesforce allows in Task.Subject', () => {
    expect(textTaskSubject('x'.repeat(400), '+16195550100', true).length).toBeLessThanOrEqual(255);
  });
});

describe('textTaskDescription', () => {
  it('is the message itself', () => {
    expect(textTaskDescription('Is the house still available?', 0)).toBe('Is the house still available?');
  });

  it('notes attachments, which only Twilio can show', () => {
    expect(textTaskDescription('Here is the photo', 1)).toBe('Here is the photo\n\n(1 attachment — open Twilio to view)');
    expect(textTaskDescription('Pics', 3)).toBe('Pics\n\n(3 attachments — open Twilio to view)');
  });

  it('is just the note for a picture with no words', () => {
    expect(textTaskDescription('', 2)).toBe('(2 attachments — open Twilio to view)');
  });
});

describe('chooseTextRecipient', () => {
  it("routes an agent number to the rep it's assigned to — never to the pool rules", () => {
    expect(chooseTextRecipient({ kind: 'agent', assignedUserId: 'rep-1' }, 'sticky', 'dialer')).toBe('rep-1');
  });

  it('routes nothing for an unassigned agent (reserve) number', () => {
    expect(chooseTextRecipient({ kind: 'agent', assignedUserId: null }, 'sticky', 'dialer')).toBeNull();
  });

  it('routes a pool number like a callback: sticky rep first, then the last rep to dial them', () => {
    expect(chooseTextRecipient({ kind: 'dialer_pool', assignedUserId: null }, 'sticky', 'dialer')).toBe('sticky');
    expect(chooseTextRecipient({ kind: 'dialer_pool', assignedUserId: null }, null, 'dialer')).toBe('dialer');
    expect(chooseTextRecipient({ kind: 'dialer_pool', assignedUserId: null }, null, null)).toBeNull();
  });
});

describe('textTaskLinks', () => {
  it('puts a Lead in WhoId and nothing in WhatId (Salesforce refuses a WhatId beside a Lead)', () => {
    expect(textTaskLinks({ whoId: '00Q000000000001', name: 'L' })).toEqual({ WhoId: '00Q000000000001' });
  });

  it('puts a Contact in WhoId and its Account in WhatId', () => {
    expect(textTaskLinks({ whoId: '003000000000001', whatId: '001000000000001' })).toEqual({
      WhoId: '003000000000001',
      WhatId: '001000000000001',
    });
  });

  it('puts any other record (Deal__c) in WhatId only', () => {
    expect(textTaskLinks({ whatId: 'a0X000000000001' })).toEqual({ WhatId: 'a0X000000000001' });
  });

  it('never uses an Account (or anything not a Lead/Contact) as WhoId', () => {
    expect(textTaskLinks({ whoId: '001000000000001' })).toEqual({ WhatId: '001000000000001' });
  });

  it('is empty when nothing matched', () => {
    expect(textTaskLinks(null)).toEqual({});
    expect(textTaskLinks({})).toEqual({});
  });
});

describe('salesforceRecordUrl', () => {
  it('builds a Lightning record link on the connection instance', () => {
    expect(salesforceRecordUrl('https://gghomes.my.salesforce.com', '00Q000000000001')).toBe(
      'https://gghomes.my.salesforce.com/lightning/r/00Q000000000001/view',
    );
    expect(salesforceRecordUrl('https://gghomes.my.salesforce.com/', '00T000000000001')).toBe(
      'https://gghomes.my.salesforce.com/lightning/r/00T000000000001/view',
    );
  });
});

describe('salesforceHomeUrl', () => {
  it('is the Lightning home page — the link when there is no record to point at', () => {
    expect(salesforceHomeUrl('https://gghomes.my.salesforce.com/')).toBe('https://gghomes.my.salesforce.com/lightning/page/home');
  });
});

describe('textEmailLinkTarget', () => {
  const OPP = '006000000000001AAA';
  const CONTACT = '003000000000001AAA';
  const ACCOUNT = '001000000000001AAA';
  const LEAD = '00Q000000000001AAA';
  const DEAL = 'a0X000000000001AAA';
  const TASK = '00T000000000001AAA';

  it("points at the Contact's open Opportunity when the text linked one", () => {
    expect(textEmailLinkTarget({ WhoId: CONTACT, WhatId: OPP }, TASK)).toBe(OPP);
  });

  it('otherwise at the Lead or Contact — never at the Account', () => {
    expect(textEmailLinkTarget({ WhoId: CONTACT, WhatId: ACCOUNT }, TASK)).toBe(CONTACT);
    expect(textEmailLinkTarget({ WhoId: LEAD }, TASK)).toBe(LEAD);
  });

  it('at a What-only match (Deal__c)', () => {
    expect(textEmailLinkTarget({ WhatId: DEAL }, TASK)).toBe(DEAL);
  });

  it('at the Task when nobody matched, and at nothing (home) when there is no Task either', () => {
    expect(textEmailLinkTarget({}, TASK)).toBe(TASK);
    expect(textEmailLinkTarget({}, null)).toBeNull();
  });
});

describe('taskFailureIsRetryable', () => {
  it('a 400 (validation rule, required field, too long, bad field) is permanent — retrying fails the same way', () => {
    for (const errorCode of ['FIELD_CUSTOM_VALIDATION_EXCEPTION', 'REQUIRED_FIELD_MISSING', 'STRING_TOO_LONG', 'INVALID_FIELD']) {
      expect(taskFailureIsRetryable(400, [{ errorCode }])).toBe(false);
    }
  });

  it('a 403 is permanent (no access) unless it is the API limit, which resets', () => {
    expect(taskFailureIsRetryable(403, [{ errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }])).toBe(false);
    expect(taskFailureIsRetryable(403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED' }])).toBe(true);
  });

  it('server errors, throttling, timeouts and lock contention are worth retrying', () => {
    expect(taskFailureIsRetryable(500, null)).toBe(true);
    expect(taskFailureIsRetryable(503, { message: 'busy' })).toBe(true);
    expect(taskFailureIsRetryable(429, null)).toBe(true);
    expect(taskFailureIsRetryable(408, null)).toBe(true);
    expect(taskFailureIsRetryable(400, [{ errorCode: 'UNABLE_TO_LOCK_ROW' }])).toBe(true);
  });
});

describe('redactBody', () => {
  const tricky = 'He said "call me"\nat C:\\office\\desk\ttonight';

  it('removes the body as-is', () => {
    expect(redactBody(`boom: ${tricky} (end)`, tricky)).toBe('boom: [message] (end)');
  });

  it('removes the JSON-escaped body — what Salesforce quotes back inside an error payload we stringify', () => {
    const echoed = JSON.stringify([{ errorCode: 'STRING_TOO_LONG', message: `too large: ${tricky}` }]);
    expect(echoed).not.toContain(tricky); // escaped: \" \\n \\\\ \\t
    const out = redactBody(`task create failed (400): ${echoed}`, tricky);
    expect(out).not.toContain(JSON.stringify(tricky).slice(1, -1));
    expect(out).toContain('too large: [message]');
  });

  it('removes the DOUBLE-escaped body too (a stringified error message that already held the escaped form)', () => {
    const twice = JSON.stringify(JSON.stringify({ message: tricky }));
    const out = redactBody(twice, tricky);
    expect(out).toContain('[message]');
    expect(out).not.toContain('call me');
  });

  it('leaves text alone when the body is too short to be told from ordinary words', () => {
    expect(redactBody('ok: yes', 'ok')).toBe('ok: yes');
  });
});

describe('pacificTime', () => {
  it('renders the instant in Pacific time with the zone named', () => {
    // 21:05 UTC on 2026-09-25 is 2:05 PM PDT.
    expect(pacificTime(new Date('2026-09-25T21:05:00Z'))).toBe('Fri, Sep 25, 2026, 2:05 PM PDT');
    // Winter: PST.
    expect(pacificTime(new Date('2026-12-01T17:30:00Z'))).toBe('Tue, Dec 1, 2026, 9:30 AM PST');
  });
});

describe('textEmail', () => {
  const base = {
    name: 'Jane Doe',
    fromE164: '+16195550100',
    toE164: '+18585550199',
    receivedAt: new Date('2026-09-25T21:05:00Z'),
    body: 'Is the house still available?',
    numMedia: 0,
    recordUrl: 'https://gghomes.my.salesforce.com/lightning/r/00Q000000000001/view',
    optOut: false,
  };

  it('subject names the sender', () => {
    expect(textEmail(base).subject).toBe('New text from Jane Doe');
    expect(textEmail({ ...base, name: null }).subject).toBe('New text from (619) 555-0100');
  });

  it('subject carries the STOP suffix for an opt-out', () => {
    expect(textEmail({ ...base, optOut: true, body: 'STOP' }).subject).toBe('New text from Jane Doe — asked to STOP');
  });

  it('body says who, which of the rep numbers, when (Pacific), the QUOTED message, and where in Salesforce', () => {
    expect(textEmail(base).body).toBe(
      [
        'From: Jane Doe (619) 555-0100',
        'To your number: (858) 555-0199',
        'Received: Fri, Sep 25, 2026, 2:05 PM PDT',
        '',
        'Message:',
        '> Is the house still available?',
        '',
        'Open in Salesforce: https://gghomes.my.salesforce.com/lightning/r/00Q000000000001/view',
      ].join('\n'),
    );
  });

  it('quotes EVERY line of the text, so a link line inside a text cannot pass for ours', () => {
    const out = textEmail({
      ...base,
      body: 'call me back\r\nOpen in Salesforce: https://evil.example/phish\n\nthanks',
    });
    expect(out.body).toBe(
      [
        'From: Jane Doe (619) 555-0100',
        'To your number: (858) 555-0199',
        'Received: Fri, Sep 25, 2026, 2:05 PM PDT',
        '',
        'Message:',
        '> call me back',
        '> Open in Salesforce: https://evil.example/phish',
        '>',
        '> thanks',
        '',
        'Open in Salesforce: https://gghomes.my.salesforce.com/lightning/r/00Q000000000001/view',
      ].join('\n'),
    );
    // Our link is the only UNQUOTED "Open in Salesforce:" line, and it is last.
    const ours = out.body.split('\n').filter((l) => l.startsWith('Open in Salesforce:'));
    expect(ours).toEqual(['Open in Salesforce: https://gghomes.my.salesforce.com/lightning/r/00Q000000000001/view']);
  });

  it('says so when the text could not be logged to Salesforce', () => {
    const out = textEmail({ ...base, notLogged: true, recordUrl: 'https://gghomes.my.salesforce.com/lightning/page/home' });
    expect(out.subject).toBe('New text from Jane Doe');
    expect(out.body).toBe(
      [
        'From: Jane Doe (619) 555-0100',
        'To your number: (858) 555-0199',
        'Received: Fri, Sep 25, 2026, 2:05 PM PDT',
        'This text could not be logged to Salesforce — there is no Task for it.',
        '',
        'Message:',
        '> Is the house still available?',
        '',
        'Open in Salesforce: https://gghomes.my.salesforce.com/lightning/page/home',
      ].join('\n'),
    );
  });

  it('body for an unmatched sender, an attachment, an opt-out, and no link — the attachment note is ours, not quoted', () => {
    const out = textEmail({ ...base, name: null, body: 'STOP', numMedia: 1, optOut: true, recordUrl: null });
    expect(out.body).toBe(
      [
        'From: (619) 555-0100',
        'To your number: (858) 555-0199',
        'Received: Fri, Sep 25, 2026, 2:05 PM PDT',
        'They asked to STOP.',
        '',
        'Message:',
        '> STOP',
        '(1 attachment — open Twilio to view)',
      ].join('\n'),
    );
  });

  it('a picture with no words says so under Message:', () => {
    const out = textEmail({ ...base, body: '', numMedia: 2, recordUrl: null });
    expect(out.body.split('\n').slice(4)).toEqual(['Message:', '> (no text)', '(2 attachments — open Twilio to view)']);
  });
});
