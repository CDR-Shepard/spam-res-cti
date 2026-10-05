import { describe, expect, it } from 'vitest';
import type { ConsentBlock } from '@cti/firewall';
import { gateWarnings, hasBlockingWarning, WARNING_WORDS, type WarningInput } from './warnings.js';

const TX_A = '+15125550100';
const TX_B = '+15125550101';
/** 14:00 in Austin (CDT, UTC-5). */
const AFTERNOON = new Date('2026-10-05T19:00:00.000Z');
/** 22:00 in Austin. */
const NIGHT = new Date('2026-10-06T03:00:00.000Z');

const input = (over: Partial<Omit<WarningInput, 'record'>> & { record?: Partial<WarningInput['record']> } = {}): WarningInput => ({
  consent: 'yes',
  blocks: new Map(),
  now: AFTERNOON,
  ...over,
  record: { phones: [{ field: 'MobilePhone', e164: TX_A }], sfDoNotCall: false, skipOnDialer: false, isClosed: false, state: 'TX', ...over.record },
});
const codes = (w: ReturnType<typeof gateWarnings>) => w.map((x) => `${x.code}:${x.severity}`);
const blocks = (...entries: Array<[string, ConsentBlock]>) => new Map(entries);

describe('gateWarnings', () => {
  it('3c (P4-1): a plan whose text the voice agent would refuse is a blocking warning that names the fields', () => {
    const w = gateWarnings(input({ planTextProblems: ['the opener: offer wording', 'question 2: a web address'] }));
    expect(codes(w)).toEqual(['plan_text_rejected:block']);
    expect(w[0]!.words).toBe("Can't approve: the voice agent can't be given this text. Edit it first. the opener: offer wording; question 2: a web address.");
    expect(hasBlockingWarning(w)).toBe(true);
    expect(gateWarnings(input({ planTextProblems: [] }))).toEqual([]);
  });

  it('1: a clean record at 14:00 has none', () => {
    expect(gateWarnings(input())).toEqual([]);
  });

  it('2: consent no blocks, in plain words', () => {
    const w = gateWarnings(input({ consent: 'no' }));
    expect(codes(w)).toEqual(['no_ai_consent:block']);
    expect(w[0]!.words).toBe("Can't call: no AI consent in Salesforce.");
  });

  it('3: a missing consent field blocks', () => {
    expect(codes(gateWarnings(input({ consent: 'field_missing' })))).toEqual(['consent_field_missing:block']);
  });

  it("3b: consent that could not be read blocks, and says to research again (CF-5)", () => {
    const w = gateWarnings(input({ consent: 'unknown' }));
    expect(codes(w)).toEqual(['consent_unknown:block']);
    expect(w[0]!.words).toContain('consent could not be read — research again');
  });

  it('4: consent null (not researched yet) has no consent warning', () => {
    expect(gateWarnings(input({ consent: null }))).toEqual([]);
  });

  it('5: no phones blocks', () => {
    expect(codes(gateWarnings(input({ record: { phones: [] } })))).toEqual(['no_phone:block']);
  });

  it('6: every phone opted out blocks; one of two is only info', () => {
    expect(codes(gateWarnings(input({ blocks: blocks([TX_A, 'opted_out']) })))).toEqual(['opted_out:block']);
    const two = { phones: [{ field: 'MobilePhone', e164: TX_A }, { field: 'Phone', e164: TX_B }] };
    const w = gateWarnings(input({ record: two, blocks: blocks([TX_A, 'opted_out']) }));
    expect(codes(w)).toEqual(['opted_out:info']);
    expect(w[0]!.words).toBe(`${WARNING_WORDS.opted_out} (one of the numbers)`);
  });

  it('7: blocked and dnc follow the same rule with their own codes', () => {
    expect(codes(gateWarnings(input({ blocks: blocks([TX_A, 'blocked']) })))).toEqual(['blocked:block']);
    expect(codes(gateWarnings(input({ blocks: blocks([TX_A, 'dnc']) })))).toEqual(['dnc:block']);
    const two = { phones: [{ field: 'MobilePhone', e164: TX_A }, { field: 'Phone', e164: TX_B }] };
    expect(codes(gateWarnings(input({ record: two, blocks: blocks([TX_B, 'dnc']) })))).toEqual(['dnc:info']);
  });

  it('8: Do Not Call in Salesforce blocks', () => {
    expect(codes(gateWarnings(input({ record: { sfDoNotCall: true } })))).toEqual(['sf_do_not_call:block']);
  });

  it('9: Skip on Dialer blocks', () => {
    expect(codes(gateWarnings(input({ record: { skipOnDialer: true } })))).toEqual(['skip_on_dialer:block']);
  });

  it('10: a closed record is info', () => {
    expect(codes(gateWarnings(input({ record: { isClosed: true } })))).toEqual(['closed:info']);
  });

  it('11: a daily-cap state is info', () => {
    expect(codes(gateWarnings(input({ record: { state: 'FL' } })))).toEqual(['state_daily_cap:info']);
  });

  it("12: 22:00 at the first phone's local time is outside calling hours (info)", () => {
    expect(codes(gateWarnings(input({ now: NIGHT })))).toEqual(['outside_calling_hours:info']);
  });

  it('13: blocks first, then info, each in GateWarningCode order', () => {
    const w = gateWarnings(input({ consent: 'no', now: NIGHT, record: { state: 'FL', isClosed: true, skipOnDialer: true } }));
    expect(codes(w)).toEqual(['no_ai_consent:block', 'skip_on_dialer:block', 'closed:info', 'state_daily_cap:info', 'outside_calling_hours:info']);
  });

  it('14 (CF-10): a pending do-not-contact flag, or a flagged plan nobody dismissed, blocks', () => {
    expect(codes(gateWarnings(input({ dnc: { pending: true, flaggedNotDismissed: false } })))).toEqual(['dnc_pending:block']);
    expect(codes(gateWarnings(input({ dnc: { pending: false, flaggedNotDismissed: true } })))).toEqual(['dnc_not_dismissed:block']);
    expect(gateWarnings(input({ dnc: { pending: false, flaggedNotDismissed: false } }))).toEqual([]);
  });
});

describe('hasBlockingWarning', () => {
  it('is true only when some warning blocks', () => {
    expect(hasBlockingWarning([])).toBe(false);
    expect(hasBlockingWarning(gateWarnings(input({ record: { isClosed: true } })))).toBe(false);
    expect(hasBlockingWarning(gateWarnings(input({ consent: 'no' })))).toBe(true);
  });
});
