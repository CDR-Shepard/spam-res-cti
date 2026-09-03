import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { attachCallerParameters, dialClientWithCallerParams, recordTypeForId } from './inbound-caller-params.js';

describe('recordTypeForId', () => {
  it.each([
    ['00Q000000000001AAA', 'Lead'],
    ['003000000000001AAA', 'Contact'],
    ['006000000000001AAA', 'Opportunity'],
  ])('%s -> %s', (id, label) => {
    expect(recordTypeForId(id)).toBe(label);
  });

  it('falls back to the honest "Record" label for an unrecognized prefix (custom Deal__c-style ids vary per org)', () => {
    expect(recordTypeForId('a0X000000000009AAA')).toBe('Record');
  });
});

const IDENTITY = 'rep_rep1';

/** Build real TwiML (twilio-node) via the exported ring-time helper, so we
 *  assert on the actual documented `<Client>` shape Twilio ends up receiving
 *  — never hand-built XML, and never the two call sites' own inline logic
 *  (both inbound.ts ring sites call this same helper). */
function dialClientXml(matched: Parameters<typeof attachCallerParameters>[1]): string {
  const t = new twilio.twiml.VoiceResponse();
  const dial = t.dial({});
  dialClientWithCallerParams(dial, IDENTITY, matched);
  return t.toString();
}

describe('dialClientWithCallerParams — the documented <Client> shape', () => {
  it('matched caller (Lead, whoId): pins the exact <Client><Identity>...</Identity><Parameter .../></Client> shape', () => {
    const xml = dialClientXml({ whoId: '00Q000000000001AAA', name: 'Jane Doe' });
    expect(xml).toContain(
      '<Client><Identity>rep_rep1</Identity>' +
        '<Parameter name="callerName" value="Jane Doe"/>' +
        '<Parameter name="recordId" value="00Q000000000001AAA"/>' +
        '<Parameter name="recordType" value="Lead"/></Client>',
    );
  });

  it('unmatched caller (null/undefined): pins the exact byte-identical <Client>rep_rep1</Client> — no <Identity>, no <Parameter>', () => {
    for (const matched of [null, undefined] as const) {
      const xml = dialClientXml(matched);
      expect(xml).toContain('<Client>rep_rep1</Client>');
      expect(xml).not.toContain('<Identity');
      expect(xml).not.toContain('<Parameter');
    }
  });
});

describe('attachCallerParameters', () => {
  it('falls back to whatId when there is no whoId (Deal-only match) — recordType is the honest "Record" fallback', () => {
    const xml = dialClientXml({ whatId: 'a0X000000000009AAA' });
    expect(xml).not.toContain('callerName');
    expect(xml).toContain('<Parameter name="recordId" value="a0X000000000009AAA"/>');
    expect(xml).toContain('<Parameter name="recordType" value="Record"/>');
  });

  it('attaches only callerName (no recordId/recordType) for a matched caller with neither id', () => {
    const xml = dialClientXml({ name: 'Ghost' });
    expect(xml).toContain('<Parameter name="callerName" value="Ghost"/>');
    expect(xml).not.toContain('recordId');
    expect(xml).not.toContain('recordType');
  });

  it('escapes a user-controlled Salesforce name via twilio-node — never hand-built XML', () => {
    const xml = dialClientXml({ whoId: '00Q000000000001AAA', name: 'Bob "Q" O&Co <Ltd>' });
    // A raw string-concat implementation would inject an unescaped quote/amp/angle-bracket
    // and corrupt the XML; twilio-node escapes attribute values.
    expect(xml).toContain('value="Bob &quot;Q&quot; O&amp;Co &lt;Ltd>"');
  });

  it('strips XML-illegal control characters from a parameter value (FIX-4)', () => {
    const xml = dialClientXml({ whoId: '00Q000000000001AAA', name: 'Jane\x00Doe' });
    expect(xml).toContain('<Parameter name="callerName" value="JaneDoe"/>');
  });

  it('caps a parameter value at 200 characters (FIX-4)', () => {
    const long = 'x'.repeat(250);
    const xml = dialClientXml({ whoId: '00Q000000000001AAA', name: long });
    expect(xml).toContain(`<Parameter name="callerName" value="${'x'.repeat(200)}"/>`);
    expect(xml).not.toContain('x'.repeat(201));
  });
});
