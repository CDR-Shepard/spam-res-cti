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
    pickDidForRun: vi.fn(async () => (c.pick === undefined ? { e164: FROM } : c.pick)),
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
    expect(d.pickDidForRun).toHaveBeenCalledWith(db, { orgId: 'O1', userId: 'U1', toE164: FL, runKind: 'pool' });
    const order = [d.blockedTargets, d.dailyDialCount, d.withinCallingHours, d.pickDidForRun].map(
      (f) => f.mock.invocationCallOrder[0]!,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('a blocked call never claims a caller ID', async () => {
    const c: Case = { name: '', target: rec(), inHours: false, want: blockedBy('calling_hours') };
    const d = deps(c);
    await gateAiCall(db, { cfg: baseCfg, orgId: 'O1', userId: 'U1', isAdmin: false, now: NOW, target: c.target }, d);
    expect(d.pickDidForRun).not.toHaveBeenCalled();
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
    expect(d.pickDidForRun).not.toHaveBeenCalled();
  });
});
