import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import { attachCallerParameters, recordTypeForId } from './inbound-caller-params.js';

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

describe('attachCallerParameters', () => {
  /** Build real TwiML (twilio-node) so we assert on actual escaped output, never hand-built XML. */
  function dialClientXml(matched: Parameters<typeof attachCallerParameters>[1]): string {
    const t = new twilio.twiml.VoiceResponse();
    const dial = t.dial({});
    const client = dial.client({}, 'rep_abc');
    attachCallerParameters(client, matched);
    return t.toString();
  }

  it('attaches callerName, recordId, recordType for a Lead match (whoId)', () => {
    const xml = dialClientXml({ whoId: '00Q000000000001AAA', name: 'Jane Doe' });
    expect(xml).toContain('<Parameter name="callerName" value="Jane Doe"/>');
    expect(xml).toContain('<Parameter name="recordId" value="00Q000000000001AAA"/>');
    expect(xml).toContain('<Parameter name="recordType" value="Lead"/>');
  });

  it('falls back to whatId when there is no whoId (Deal-only match) — recordType is the honest "Record" fallback', () => {
    const xml = dialClientXml({ whatId: 'a0X000000000009AAA' });
    expect(xml).not.toContain('callerName');
    expect(xml).toContain('<Parameter name="recordId" value="a0X000000000009AAA"/>');
    expect(xml).toContain('<Parameter name="recordType" value="Record"/>');
  });

  it('emits no <Parameter> at all for an unmatched caller (null) — identical TwiML to before this feature', () => {
    expect(dialClientXml(null)).not.toContain('<Parameter');
    expect(dialClientXml(undefined)).not.toContain('<Parameter');
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
});
