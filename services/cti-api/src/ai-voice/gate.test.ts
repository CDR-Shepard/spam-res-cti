import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import type { ConsentBlock } from '../dialer/consent-check.js';
import type { PickDidResult } from '../dialer/pick-agent-did.js';
import { gateAiCall, type AiGateBlock, type AiGateResult, type GateDeps } from './gate.js';
import type { AiCallRecord } from './record.js';

const db = {} as Parameters<typeof gateAiCall>[0];
const NOW = new Date('2026-10-05T18:00:00Z');
const CA = '+16195550100'; // San Diego — not a daily-cap state
const FL = '+13055550100'; // Miami — a daily-cap state
const TEST = '+16195550199';
const FROM = '+16195550000';

const baseCfg = {
  OPENAI_API_KEY: 'sk-test',
  AI_VOICE: 'on',
  OUTREACH_KILL_SWITCH: 'off',
  AI_VOICE_TEST_NUMBERS: `(619) 555-0199, +1 212 555 0100`,
  DIALER_CALLING_HOURS_EXEMPT: undefined,
} as unknown as AppConfig;

function record(over: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    objectType: 'Lead',
    recordId: '00Q5e00000AbCdEFGH',
    name: 'Jane Doe',
    firstName: 'Jane',
    phones: [CA, '+16195550101'],
    consentAiCall: true,
    consentFieldMissing: false,
    address: null,
    notes: '',
    ownerSfUserId: null,
    ...over,
  };
}

interface Case {
  name: string;
  cfg?: Partial<AppConfig>;
  isAdmin?: boolean;
  target: Parameters<typeof gateAiCall>[1]['target'];
  blocked?: ConsentBlock;
  dailyCount?: number;
  inHours?: boolean;
  pick?: PickDidResult;
  want: AiGateResult;
}

function deps(c: Case) {
  return {
    blockedTargets: vi.fn(async (_db: unknown, _org: string, nums: readonly string[]) =>
      new Map(c.blocked ? nums.map((n) => [n, c.blocked!] as const) : []),
    ),
    dailyDialCount: vi.fn(async () => c.dailyCount ?? 0),
    withinCallingHours: vi.fn(() => c.inHours ?? true),
    pickAiDid: vi.fn(async () => (c.pick === undefined ? { e164: FROM } : c.pick)),
    peekAiCallerId: vi.fn(async () => FROM),
  } satisfies GateDeps;
}

const blockedBy = (reason: AiGateBlock): AiGateResult => ({ ok: false, reason });
const rec = (over: Partial<AiCallRecord> = {}) => ({ kind: 'record' as const, record: record(over) });
const test = (toRaw: string) => ({ kind: 'test' as const, toRaw });

const cases: Case[] = [
  { name: 'record happy path', target: rec(), want: { ok: true, toE164: CA, fromE164: FROM } },
  { name: 'test-number happy path (normalized, admin, outside calling hours)', isAdmin: true, target: test('619-555-0199'), inHours: false, want: { ok: true, toE164: TEST, fromE164: FROM } },
  { name: 'no OpenAI key', cfg: { OPENAI_API_KEY: undefined }, target: rec(), want: blockedBy('ai_voice_unavailable') },
  { name: 'AI_VOICE off', cfg: { AI_VOICE: 'off' }, target: rec(), want: blockedBy('ai_voice_unavailable') },
  { name: 'outreach kill switch', cfg: { OUTREACH_KILL_SWITCH: 'on' }, isAdmin: true, target: test(TEST), want: blockedBy('ai_voice_unavailable') },
  { name: 'consent field missing', target: rec({ consentFieldMissing: true, consentAiCall: false }), want: blockedBy('consent_field_missing') },
  { name: 'no consent', target: rec({ consentAiCall: false }), want: blockedBy('no_consent') },
  { name: 'test number, not admin', isAdmin: false, target: test(TEST), want: blockedBy('not_admin_for_test') },
  { name: 'admin, number not in the test list', isAdmin: true, target: test('+16195550123'), want: blockedBy('not_admin_for_test') },
  { name: 'admin, unparseable number', isAdmin: true, target: test('call me'), want: blockedBy('invalid_number') },
  { name: 'record with no phone', target: rec({ phones: [] }), want: blockedBy('no_phone') },
  { name: 'opted out', target: rec(), blocked: 'opted_out', want: blockedBy('opted_out') },
  { name: 'block list', target: rec(), blocked: 'blocked', want: blockedBy('blocked') },
  { name: 'federal DNC', target: rec(), blocked: 'dnc', want: blockedBy('dnc') },
  { name: 'test number still honours opt-out', isAdmin: true, target: test(TEST), blocked: 'opted_out', want: blockedBy('opted_out') },
  { name: 'daily cap in a capped state', target: rec({ phones: [FL] }), dailyCount: 3, want: blockedBy('daily_cap') },
  { name: 'under the daily cap in a capped state', target: rec({ phones: [FL] }), dailyCount: 2, want: { ok: true, toE164: FL, fromE164: FROM } },
  { name: 'uncapped state ignores the count', target: rec(), dailyCount: 99, want: { ok: true, toE164: CA, fromE164: FROM } },
  { name: 'outside calling hours', target: rec(), inHours: false, want: blockedBy('calling_hours') },
  { name: 'calling-hours exempt number', cfg: { DIALER_CALLING_HOURS_EXEMPT: ` ${CA} ,+15555550000` }, target: rec(), inHours: false, want: { ok: true, toE164: CA, fromE164: FROM } },
  { name: 'per-customer ceiling', target: rec(), pick: { skip: 'customer_ceiling' }, want: blockedBy('customer_ceiling') },
  { name: 'no caller id', target: rec(), pick: null, want: blockedBy('no_caller_id') },
  { name: 'record call with no AI number ignores the default caller ID', cfg: { TWILIO_DEFAULT_CALLER_ID: '+16195550002' }, target: rec(), pick: null, want: blockedBy('no_caller_id') },
  { name: 'test call with no AI number NEVER falls back to the default caller ID', cfg: { TWILIO_DEFAULT_CALLER_ID: '(619) 555-0002' }, isAdmin: true, target: test(TEST), pick: null, want: blockedBy('no_caller_id') },
  { name: 'test call with no AI number and no default caller ID', isAdmin: true, target: test(TEST), pick: null, want: blockedBy('no_caller_id') },
  { name: 'test call still honours the per-customer ceiling', cfg: { TWILIO_DEFAULT_CALLER_ID: '+16195550002' }, isAdmin: true, target: test(TEST), pick: { skip: 'customer_ceiling' }, want: blockedBy('customer_ceiling') },
];

describe('gateAiCall', () => {
  it.each(cases)('$name', async (c) => {
    const d = deps(c);
    const got = await gateAiCall(
      db,
      { cfg: { ...baseCfg, ...c.cfg } as AppConfig, orgId: 'O1', userId: 'U1', isAdmin: c.isAdmin ?? false, now: NOW, target: c.target },
      d,
    );
    expect(got).toEqual(c.want);
  });

  it('runs the checks in order and claims a caller ID only after every other gate passed', async () => {
    const d = deps({ name: '', target: rec({ phones: [FL] }), want: { ok: true, toE164: FL, fromE164: FROM } });
    await gateAiCall(db, { cfg: baseCfg, orgId: 'O1', userId: 'U1', isAdmin: false, now: NOW, target: rec({ phones: [FL] }) }, d);
    expect(d.blockedTargets).toHaveBeenCalledWith(db, 'O1', [FL]);
    expect(d.dailyDialCount).toHaveBeenCalledWith(db, 'O1', FL, NOW);
    expect(d.withinCallingHours).toHaveBeenCalledWith(FL, NOW);
    expect(d.pickAiDid).toHaveBeenCalledWith(db, { orgId: 'O1', userId: 'U1', toE164: FL });
    const order = [d.blockedTargets, d.dailyDialCount, d.withinCallingHours, d.pickAiDid].map(
      (f) => f.mock.invocationCallOrder[0]!,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('a blocked call never claims a caller ID', async () => {
    const c: Case = { name: '', target: rec(), inHours: false, want: blockedBy('calling_hours') };
    const d = deps(c);
    await gateAiCall(db, { cfg: baseCfg, orgId: 'O1', userId: 'U1', isAdmin: false, now: NOW, target: c.target }, d);
    expect(d.pickAiDid).not.toHaveBeenCalled();
  });

  it('does not count dials for an uncapped or unknown-state number', async () => {
    for (const to of [CA, '+442071838750']) {
      const c: Case = { name: '', isAdmin: true, target: test(to), want: { ok: true, toE164: to, fromE164: FROM } };
      const d = deps(c);
      const got = await gateAiCall(
        db,
        { cfg: { ...baseCfg, AI_VOICE_TEST_NUMBERS: to } as AppConfig, orgId: 'O1', userId: 'U1', isAdmin: true, now: NOW, target: c.target },
        d,
      );
      expect(got.ok).toBe(true);
      expect(d.dailyDialCount).not.toHaveBeenCalled();
    }
  });

  it('a test call skips the calling-hours check entirely', async () => {
    const c: Case = { name: '', isAdmin: true, target: test(TEST), want: blockedBy('calling_hours') };
    const d = deps(c);
    await gateAiCall(db, { cfg: baseCfg, orgId: 'O1', userId: 'U1', isAdmin: true, now: NOW, target: c.target }, d);
    expect(d.withinCallingHours).not.toHaveBeenCalled();
  });

  it('a failing consent read fails closed (throws)', async () => {
    const c: Case = { name: '', target: rec(), want: blockedBy('opted_out') };
    const d = { ...deps(c), blockedTargets: vi.fn(async () => { throw new Error('pg down'); }) };
    await expect(
      gateAiCall(db, { cfg: baseCfg, orgId: 'O1', userId: 'U1', isAdmin: false, now: NOW, target: c.target }, d),
    ).rejects.toThrow('pg down');
    expect(d.pickAiDid).not.toHaveBeenCalled();
  });
});

describe('gateAiCall — practice_browser (plan 1E): the browser branch', () => {
  const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
  const own = `aitest_${ADMIN.replace(/-/g, '')}_a1b2c3d4e5f6`;
  const browser = (identity: string) => ({ kind: 'browser' as const, identity });
  const gate = (over: { cfg?: Partial<AppConfig>; isAdmin?: boolean; identity?: string; now?: Date; peek?: string | null } = {}) => {
    const d = { ...deps({ name: '', target: browser(own), want: blockedBy('invalid_number') }), peekAiCallerId: vi.fn(async () => (over.peek === undefined ? FROM : over.peek)) };
    const got = gateAiCall(
      db,
      { cfg: { ...baseCfg, ...over.cfg } as AppConfig, orgId: 'O1', userId: ADMIN, isAdmin: over.isAdmin ?? true, now: over.now ?? NOW, target: browser(over.identity ?? own) },
      d,
    );
    return { got, d };
  };

  it('2: an admin ringing their own browser identity, with a pool number: ok, to client:<identity>, from the peeked number, nothing else read or claimed', async () => {
    const { got, d } = gate();
    expect(await got).toEqual({ ok: true, toE164: `client:${own}`, fromE164: FROM });
    expect(d.peekAiCallerId).toHaveBeenCalledWith(db, 'O1');
    for (const f of [d.blockedTargets, d.dailyDialCount, d.withinCallingHours, d.pickAiDid]) expect(f).not.toHaveBeenCalled();
  });

  it('3: at 3 AM for the record it is still ok: nobody\'s phone rings, so no calling-hours rule', async () => {
    const { got, d } = gate({ now: new Date('2026-10-06T10:00:00Z') }); // 3 AM in San Diego
    expect((await got).ok).toBe(true);
    expect(d.withinCallingHours).not.toHaveBeenCalled();
  });

  it('4: AI voice off -> ai_voice_unavailable, before anything is read', async () => {
    const { got, d } = gate({ cfg: { AI_VOICE: 'off' } as Partial<AppConfig> });
    expect(await got).toEqual(blockedBy('ai_voice_unavailable'));
    expect(d.peekAiCallerId).not.toHaveBeenCalled();
  });

  it('5: not an admin -> not_admin_for_test', async () => {
    const { got, d } = gate({ isAdmin: false });
    expect(await got).toEqual(blockedBy('not_admin_for_test'));
    expect(d.peekAiCallerId).not.toHaveBeenCalled();
  });

  it("6: another admin's identity -> invalid_number (G-3)", async () => {
    const { got, d } = gate({ identity: `aitest_${OTHER.replace(/-/g, '')}_a1b2c3d4e5f6` });
    expect(await got).toEqual(blockedBy('invalid_number'));
    expect(d.peekAiCallerId).not.toHaveBeenCalled();
  });

  it.each([
    ['a rep softphone identity', `rep_${ADMIN.replace(/-/g, '')}`],
    ['a phone number', '+16195550199'],
    ['an identity with a trailing extra', `${'x'}${own}`],
  ])('7: %s forced through -> invalid_number (G-3)', async (_label, identity) => {
    const { got } = gate({ identity });
    expect(await got).toEqual(blockedBy('invalid_number'));
  });

  it('no usable ai_pool number -> no_caller_id; nothing falls back to the default caller ID', async () => {
    const { got } = gate({ peek: null, cfg: { TWILIO_DEFAULT_CALLER_ID: '+16195550002' } as Partial<AppConfig> });
    expect(await got).toEqual(blockedBy('no_caller_id'));
  });
});
