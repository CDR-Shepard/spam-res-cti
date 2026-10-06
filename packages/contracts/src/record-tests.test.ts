import { describe, expect, it } from 'vitest';
import {
  AI_TEST_IDENTITY_RE,
  BrowserTokenResponse,
  CreateRecordTestRequest,
  RECORD_REF_ERROR_WORDS,
  RecordTest,
  RecordTestCallRequest,
  RecordTestsResponse,
  aiTestIdentity,
  aiTestIdentityUser,
  parseSalesforceRecordRef,
  toSalesforceId18,
} from './record-tests.js';

const USER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const USER_HEX = '0f1e2d3c4b5a49688776655443322110';
/** 15 → 18: chunks 00Q8X / 00001 / AbCdE set bits 2+4, none, 0+2+4 → 20 'U', 0 'A', 21 'V'. */
const LEAD_15 = '00Q8X00001AbCdE';
const LEAD_18 = '00Q8X00001AbCdEUAV';
/** 0068X00000AbCdE: chunks 0068X / 00000 / AbCdE → bit 4 = 16 'Q', 'A', 21 'V'. */
const OPP_18 = '0068X00000AbCdEQAV';

describe('parseSalesforceRecordRef', () => {
  it.each([
    ['1: a 15-character Lead Id', LEAD_15, 'Lead', LEAD_18],
    ['2: an 18-character Opportunity Id', OPP_18, 'Opportunity', OPP_18],
    ['3: a Lightning Lead URL', `https://x.lightning.force.com/lightning/r/Lead/${LEAD_18}/view`, 'Lead', LEAD_18],
    [
      '4: a Lightning related-list URL',
      `https://x.lightning.force.com/lightning/r/Opportunity/${OPP_18}/related/OpenActivities/view`,
      'Opportunity',
      OPP_18,
    ],
    ['5: a Classic URL', `https://x.my.salesforce.com/${OPP_18}`, 'Opportunity', OPP_18],
    ['6: spaces and a trailing query', `  ${LEAD_15}?x=1  `, 'Lead', LEAD_18],
  ])('%s', (_label, input, sfObject, sfRecordId) => {
    expect(parseSalesforceRecordRef(input)).toEqual({ ok: true, sfObject, sfRecordId });
  });

  it('7: an Account Id is the wrong object', () => {
    expect(parseSalesforceRecordRef('001D000000IqhSLIAZ')).toEqual({ ok: false, error: 'wrong_object' });
    expect(parseSalesforceRecordRef('https://x.lightning.force.com/lightning/r/Account/001D000000IqhSL/view')).toEqual({
      ok: false,
      error: 'wrong_object',
    });
  });

  it.each([['hello'], [''], ['https://x.lightning.force.com/lightning/page/home'], ['00Q8X00001AbCd'], ['00Q8X00001AbCdEUA']])(
    '8: %j has no Id',
    (input) => {
      expect(parseSalesforceRecordRef(input)).toEqual({ ok: false, error: 'no_id' });
    },
  );

  it('9: an 18-character Id whose last three characters do not match', () => {
    expect(parseSalesforceRecordRef('00Q8X00001AbCdEAAA')).toEqual({ ok: false, error: 'bad_checksum' });
    expect(parseSalesforceRecordRef('0068X00000AbCdEQAZ')).toEqual({ ok: false, error: 'bad_checksum' });
  });

  it('an 18-character Id with a lower-case suffix is accepted and normalised', () => {
    expect(parseSalesforceRecordRef('00Q8X00001AbCdEuav')).toEqual({ ok: true, sfObject: 'Lead', sfRecordId: LEAD_18 });
  });

  it('each refusal has its words', () => {
    expect(RECORD_REF_ERROR_WORDS).toEqual({
      no_id: "That isn't a Salesforce Lead or Opportunity Id or link.",
      wrong_object: 'Only Leads (00Q…) and Opportunities (006…) can be tested.',
      bad_checksum: "That Id's last three characters don't match. Copy it again from Salesforce.",
    });
  });

  it('takes the first Lead or Opportunity Id in the input', () => {
    expect(parseSalesforceRecordRef(`see ${OPP_18} and ${LEAD_18}`)).toEqual({ ok: true, sfObject: 'Opportunity', sfRecordId: OPP_18 });
  });
});

describe('toSalesforceId18', () => {
  it.each([
    // From the Salesforce REST API Developer Guide's examples.
    ['001D000000IqhSL', '001D000000IqhSLIAZ'],
    ['005D0000001KyEI', '005D0000001KyEIIA0'],
    // All digits and lower case: no bit set in any chunk.
    ['005000000000001', '005000000000001AAA'],
  ])('10: %s → %s', (id15, id18) => {
    expect(toSalesforceId18(id15)).toBe(id18);
  });

  it('refuses anything that is not 15 letters and digits', () => {
    expect(() => toSalesforceId18('00Q8X00001AbCd')).toThrow();
    expect(() => toSalesforceId18("00Q8X00001AbCd'")).toThrow();
  });
});

describe('the browser test identity', () => {
  it('11: aitest_<user hex>_<nonce>, matching the regex', () => {
    const identity = aiTestIdentity(USER, 'a1b2c3d4e5f6');
    expect(identity).toBe(`aitest_${USER_HEX}_a1b2c3d4e5f6`);
    expect(AI_TEST_IDENTITY_RE.test(identity)).toBe(true);
  });

  it('12: aiTestIdentityUser gives the uuid back with its dashes', () => {
    expect(aiTestIdentityUser(aiTestIdentity(USER, 'a1b2c3d4e5f6'))).toBe(USER);
  });

  it.each([
    ['a rep softphone identity', `rep_${USER_HEX}`],
    ['31 hex', `aitest_${USER_HEX.slice(1)}_a1b2c3d4e5f6`],
    ['upper-case hex', `aitest_${USER_HEX.toUpperCase()}_a1b2c3d4e5f6`],
    ['an extra suffix', `aitest_${USER_HEX}_a1b2c3d4e5f6_x`],
    ['a short nonce', `aitest_${USER_HEX}_a1b2c3`],
  ])('13: %s reads as no user', (_label, identity) => {
    expect(aiTestIdentityUser(identity)).toBeNull();
    expect(AI_TEST_IDENTITY_RE.test(identity)).toBe(false);
  });

  it('refuses to build an identity from a bad user id or nonce', () => {
    expect(() => aiTestIdentity('not-a-uuid', 'a1b2c3d4e5f6')).toThrow();
    expect(() => aiTestIdentity(USER, 'A1B2C3D4E5F6')).toThrow();
  });
});

describe('Test a record API types', () => {
  it('create and call requests', () => {
    expect(CreateRecordTestRequest.parse({ record: `  ${LEAD_15}  ` })).toEqual({ record: LEAD_15 });
    expect(CreateRecordTestRequest.safeParse({ record: 'short' }).success).toBe(false);
    expect(CreateRecordTestRequest.safeParse({ record: LEAD_15, extra: 1 }).success).toBe(false);
    expect(RecordTestCallRequest.safeParse({ mode: 'phone', to: '+15125550100' }).success).toBe(true);
    expect(RecordTestCallRequest.safeParse({ mode: 'browser', identity: aiTestIdentity(USER, 'a1b2c3d4e5f6') }).success).toBe(true);
    expect(RecordTestCallRequest.safeParse({ mode: 'browser', identity: `rep_${USER_HEX}` }).success).toBe(false);
    expect(RecordTestCallRequest.safeParse({ mode: 'phone', to: '+15125550100', identity: 'x' }).success).toBe(false);
  });

  it('a ready test and the list', () => {
    const test = {
      id: USER, sfObject: 'Lead', sfRecordId: LEAD_18, recordUrl: `https://x.my.salesforce.com/${LEAD_18}`, name: 'Pat Seller',
      status: 'ready', error: null, consent: 'yes', plan: null, planText: 'Opener: hi', planTextWords: [], returning: false,
      slots: [], offerNote: 'booking_off', ownerSfUserId: null, sources: [], costMicros: 41_000,
      requestedByName: 'Ada Admin', createdAt: '2026-10-06T18:00:00.000Z', calls: [],
    };
    expect(RecordTest.parse(test)).toEqual(test);
    expect(RecordTest.safeParse({ ...test, error: 'nope' }).success).toBe(false);
    const item = { id: USER, sfObject: 'Lead', sfRecordId: LEAD_18, name: null, status: 'running', createdAt: test.createdAt, requestedByName: null };
    expect(RecordTestsResponse.parse({ items: [item] })).toEqual({ items: [item] });
  });

  it('the browser token answer carries an aitest identity', () => {
    const ok = { token: 'jwt', identity: aiTestIdentity(USER, 'a1b2c3d4e5f6'), expiresAt: '2026-10-06T18:20:00.000Z' };
    expect(BrowserTokenResponse.parse(ok)).toEqual(ok);
    expect(BrowserTokenResponse.safeParse({ ...ok, identity: `rep_${USER_HEX}` }).success).toBe(false);
  });
});
