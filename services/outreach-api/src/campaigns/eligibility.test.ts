import { describe, expect, it } from 'vitest';
import type { SkipReason } from '@cti/contracts';
import type { ConsentBlock } from '@cti/firewall';
import { availableChannels, contactKeys, skipReasonFor } from './eligibility.js';
import type { SfRecordSnapshot } from './records.js';

const MOBILE = '+13058142231';
const LANDLINE = '+17862014455';

function snap(over: Partial<SfRecordSnapshot> = {}): SfRecordSnapshot {
  return {
    sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', name: 'Ann', ownerSfUserId: null, ownerName: null, leadManagerSfUserId: null,
    phones: [{ field: 'MobilePhone', e164: MOBILE }, { field: 'Phone', e164: LANDLINE }], email: 'Ann@Example.com', state: 'FL', webFormSource: null,
    consentAiCall: false, sfDoNotCall: false, sfEmailOptOut: false, skipOnDialer: false, isClosed: false, lastModifiedAt: null, ...over,
  };
}
const blocks = (entries: Array<[string, ConsentBlock]> = []) => new Map<string, ConsentBlock>(entries);

describe('contactKeys', () => {
  it('every E.164 plus the lowercased email, each once', () => {
    expect(contactKeys(snap())).toEqual([MOBILE, LANDLINE, 'ann@example.com']);
    expect(contactKeys(snap({ phones: [], email: null }))).toEqual([]);
  });
});

describe('availableChannels', () => {
  it.each([
    ['mobile, landline, and email', snap(), blocks(), ['call', 'sms', 'email']],
    ['landline only', snap({ phones: [{ field: 'Phone', e164: LANDLINE }], email: null }), blocks(), ['call']],
    ["a contact role's mobile counts for sms", snap({ phones: [{ field: 'Contact.MobilePhone', e164: MOBILE }] }), blocks(), ['call', 'sms', 'email']],
    ['Opportunity custom mobile field', snap({ phones: [{ field: 'Mobile_Phone__c', e164: MOBILE }], email: null }), blocks(), ['call', 'sms']],
    ['the mobile blocked: call stays on the landline, no sms', snap(), blocks([[MOBILE, 'opted_out']]), ['call', 'email']],
    ['every number blocked', snap({ email: null }), blocks([[MOBILE, 'dnc'], [LANDLINE, 'blocked']]), []],
    ['Salesforce Do Not Call', snap({ sfDoNotCall: true }), blocks(), ['email']],
    ['Salesforce Email Opt Out', snap({ sfEmailOptOut: true }), blocks(), ['call', 'sms']],
    ['nothing at all', snap({ phones: [], email: null }), blocks(), []],
  ] as const)('%s', (_label, s, b, expected) => {
    expect(availableChannels(s, b)).toEqual(expected);
  });
});

describe('skipReasonFor', () => {
  const cases: Array<[string, SfRecordSnapshot, Map<string, ConsentBlock>, boolean, SkipReason | null]> = [
    ['eligible', snap(), blocks(), false, null],
    ['closed beats everything', snap({ isClosed: true, skipOnDialer: true }), blocks([[MOBILE, 'opted_out']]), true, 'closed'],
    ['in another campaign beats skip on dialer', snap({ skipOnDialer: true }), blocks(), true, 'in_other_campaign'],
    ['skip on dialer', snap({ skipOnDialer: true }), blocks(), false, 'skip_on_dialer'],
    ['one number blocked, another usable', snap({ email: null }), blocks([[MOBILE, 'opted_out']]), false, null],
    ['opted out is the strongest reason', snap({ email: null }), blocks([[MOBILE, 'dnc'], [LANDLINE, 'opted_out']]), false, 'opted_out'],
    ['blocked over dnc', snap({ email: null }), blocks([[MOBILE, 'dnc'], [LANDLINE, 'blocked']]), false, 'blocked'],
    ['dnc', snap({ email: null }), blocks([[MOBILE, 'dnc'], [LANDLINE, 'dnc']]), false, 'dnc'],
    ['dnc over a Salesforce flag', snap({ sfEmailOptOut: true }), blocks([[MOBILE, 'dnc'], [LANDLINE, 'dnc']]), false, 'dnc'],
    ['Salesforce Do Not Call', snap({ email: null, sfDoNotCall: true }), blocks(), false, 'sf_do_not_call'],
    ['Salesforce Do Not Call over Email Opt Out', snap({ sfDoNotCall: true, sfEmailOptOut: true }), blocks(), false, 'sf_do_not_call'],
    ['Salesforce Email Opt Out', snap({ phones: [], sfEmailOptOut: true }), blocks(), false, 'sf_email_opt_out'],
    ['a Do Not Call flag on a record with no number is not the reason', snap({ phones: [], email: null, sfDoNotCall: true }), blocks(), false, 'no_contact_point'],
    ['no phone and no email', snap({ phones: [], email: null }), blocks(), false, 'no_contact_point'],
  ];
  it.each(cases)('%s', (_label, s, b, inOther, expected) => {
    expect(skipReasonFor(s, b, inOther)).toBe(expected);
  });
});
