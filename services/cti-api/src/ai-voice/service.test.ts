import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@cti/auth';
import type { AppConfig } from '../config.js';
import type { AppointmentSlot } from '@cti/contracts';
import { gateAiCall, type AiGateResult, type GateDeps } from './gate.js';
import type { AiCallRecord } from './record.js';
import { aiGateDeps, localTimeFor, startAiCall, type StartDeps } from './service.js';
import { clearActiveCalls, getActiveCall } from './registry.js';
import { CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';
import { verifyStreamToken } from './twilio.js';

const SECRET = 's'.repeat(40);
const cfg = {
  API_PUBLIC_URL: 'https://api.test',
  SESSION_SECRET: SECRET,
  AI_VOICE_AGENT_NAME: 'Alex',
  AI_VOICE_MAX_CALL_SECONDS: 600,
} as AppConfig;
const session: SessionUser = {
  userId: 'aaaaaaaa-0000-4000-8000-000000000001',
  orgId: 'oooooooo-0000-4000-8000-000000000001',
  email: 'rep@example.com',
  isAdmin: false,
  powerDialerEnabled: false,
  kind: 'human',
  isSuperAdmin: false,
};
const db = {} as never;
const TO = '+16195550100';
const FROM = '+16195550000';
const NOW = new Date('2026-10-05T18:00:00Z');

const record = (over: Partial<AiCallRecord> = {}): AiCallRecord => ({
  objectType: 'Lead',
  recordId: '00Q5e00000AbCdEFGH',
  name: 'Jane Doe',
  firstName: 'Jane',
  phones: [TO],
  consentAiCall: true,
  consentFieldMissing: false,
  address: '12 Oak St, Austin, TX 78701',
  notes: 'Inherited the house.',
  ownerSfUserId: '005OWNER0000001',
  ...over,
});

let store: FakeStore;
let twilio: FakeTwilio;
let gateResult: AiGateResult;
let deps: StartDeps & { gate: ReturnType<typeof vi.fn>; loadRecord: ReturnType<typeof vi.fn> };

beforeEach(() => {
  store = fakeStore();
  store.orgNames.set(session.orgId, 'GG Homes');
  twilio = fakeTwilio();
  gateResult = { ok: true, toE164: TO, fromE164: FROM };
  deps = {
    store,
    twilio,
    loadRecord: vi.fn(async () => record()),
    gate: vi.fn(async () => gateResult),
    now: () => NOW,
    log: silentLog,
  };
});
afterEach(() => clearActiveCalls());

const start = (target: Parameters<typeof startAiCall>[0]['target'], s: SessionUser = session) =>
  startAiCall({ db, cfg, session: s, target, deps });

describe('startAiCall — a record', () => {
  it('gates, writes the row, places the call with stream TwiML, and caches the context', async () => {
    store.handoff.set('005OWNER0000001', 'owner-user-id');
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res).toMatchObject({ ok: true, status: 'ringing' });
    if (!res.ok) throw new Error('unreachable');

    expect(deps.loadRecord).toHaveBeenCalledWith(session.userId, 'Lead', '00Q5e00000AbCdEFGH');
    const gateInput = deps.gate.mock.calls[0]![1];
    expect(gateInput).toMatchObject({ orgId: session.orgId, userId: session.userId, isAdmin: false, target: { kind: 'record' } });

    const row = store.rows.get(res.aiCallId)!;
    expect(row).toMatchObject({
      orgId: session.orgId,
      startedBy: session.userId,
      handoffUserId: 'owner-user-id',
      sfObject: 'Lead',
      sfRecordId: '00Q5e00000AbCdEFGH',
      toE164: TO,
      fromE164: FROM,
      isTest: false,
      status: 'ringing',
      callSid: CALL_SID,
    });

    const placed = twilio.placed[0]!;
    expect(placed).toMatchObject({
      to: TO,
      from: FROM,
      statusCallback: `https://api.test/telephony/twilio/ai-voice/status?aiCallId=${res.aiCallId}`,
      amdCallback: `https://api.test/telephony/twilio/ai-voice/amd?aiCallId=${res.aiCallId}`,
    });
    expect(placed.twiml).toContain('<Stream url="wss://api.test/telephony/twilio/ai-voice/stream">');
    const token = /name="token" value="([0-9a-f]{64})"/.exec(placed.twiml)?.[1] ?? '';
    expect(verifyStreamToken(res.aiCallId, token, SECRET)).toBe(true);

    const entry = getActiveCall(res.aiCallId)!;
    expect(entry).toMatchObject({ callSid: CALL_SID, handoffUserId: 'owner-user-id', toE164: TO, closing: false });
    expect(entry.prompt).toEqual({
      agentName: 'Alex',
      companyName: 'GG Homes',
      firstName: 'Jane',
      address: '12 Oak St, Austin, TX 78701',
      notes: 'Inherited the house.',
      isTest: false,
      callbackNumber: FROM,
    });
  });

  it('hands off to the starter when the record owner is not mapped in this org', async () => {
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    if (!res.ok) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId)?.handoffUserId).toBe(session.userId);
  });

  it('a blocked call writes a blocked row and places nothing', async () => {
    gateResult = { ok: false, reason: 'no_consent' };
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res).toMatchObject({ ok: false, reason: 'no_consent' });
    if (res.ok || !('aiCallId' in res)) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId!)).toMatchObject({ status: 'blocked', outcome: 'blocked', blockReason: 'no_consent', toE164: TO });
    expect(twilio.placed).toHaveLength(0);
    expect(getActiveCall(res.aiCallId!)).toBeNull();
  });

  it('a record with no phone is blocked with an empty to number', async () => {
    deps.loadRecord.mockResolvedValueOnce(record({ phones: [] }));
    gateResult = { ok: false, reason: 'no_phone' };
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    if (res.ok || !('aiCallId' in res)) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId!)?.toE164).toBe('');
  });

  it('a record that is not visible is record_not_found (no row)', async () => {
    deps.loadRecord.mockResolvedValueOnce(null);
    expect(await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' })).toEqual({ ok: false, reason: 'record_not_found' });
    expect(store.rows.size).toBe(0);
  });

  it('a Salesforce failure is salesforce_error (no row, no call)', async () => {
    deps.loadRecord.mockRejectedValueOnce(new Error('SF 500'));
    expect(await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' })).toEqual({ ok: false, reason: 'salesforce_error' });
    expect(store.rows.size).toBe(0);
    expect(deps.gate).not.toHaveBeenCalled();
  });

  it('a gate read failure refuses the call (gate_error, no row)', async () => {
    deps.gate.mockRejectedValueOnce(new Error('db'));
    expect(await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' })).toEqual({ ok: false, reason: 'gate_error' });
    expect(twilio.placed).toHaveLength(0);
  });

  it('a second AI call to a number already on an AI call is refused before the gate', async () => {
    const first = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(first.ok).toBe(true);
    const second = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(second).toMatchObject({ ok: false, reason: 'call_in_progress' });
    expect(deps.gate).toHaveBeenCalledTimes(1);
    expect(twilio.placed).toHaveLength(1);
  });

  it('a Twilio error marks the row failed and ended, and drops the registry entry', async () => {
    twilio.failPlace = true;
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res).toMatchObject({ ok: false, reason: 'twilio_error' });
    if (res.ok || !('aiCallId' in res)) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId!)).toMatchObject({ status: 'failed', outcome: 'failed', endedAt: NOW });
    expect(getActiveCall(res.aiCallId!)).toBeNull();
  });

  it('S-6: when Twilio refuses and the row cannot be marked failed, the answer is still twilio_error (never an exception that frees the idempotency key)', async () => {
    twilio.failPlace = true;
    const update = vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('db down'));
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res).toMatchObject({ ok: false, reason: 'twilio_error', aiCallId: expect.any(String) });
    expect(update).toHaveBeenCalled();
  });
});

describe('startAiCall — a test number', () => {
  it('passes the raw number to the gate as a test target and marks the row is_test', async () => {
    const admin = { ...session, isAdmin: true };
    const res = await start({ testTo: '(619) 555-0100' }, admin);
    if (!res.ok) throw new Error('unreachable');
    expect(deps.loadRecord).not.toHaveBeenCalled();
    expect(deps.gate.mock.calls[0]![1]).toMatchObject({ isAdmin: true, target: { kind: 'test', toRaw: '(619) 555-0100' } });
    expect(store.rows.get(res.aiCallId)).toMatchObject({ isTest: true, sfObject: null, sfRecordId: null, handoffUserId: session.userId });
    expect(getActiveCall(res.aiCallId)?.prompt).toMatchObject({ isTest: true, firstName: null, address: null, notes: '' });
  });
});

describe('aiGateDeps', () => {
  it('adds placed-but-uncounted AI calls to the daily dial count', async () => {
    const base: GateDeps = {
      blockedTargets: vi.fn(),
      dailyDialCount: vi.fn(async () => 1),
      withinCallingHours: vi.fn(),
      pickAiDid: vi.fn(),
    };
    store.uncounted = 2;
    const wrapped = aiGateDeps(store, base);
    expect(await wrapped.dailyDialCount(db, 'o1', TO, NOW)).toBe(3);
    expect(wrapped.blockedTargets).toBe(base.blockedTargets);
  });
});

describe('localTimeFor', () => {
  it('formats the recipient-local weekday and time from the area code', () => {
    expect(localTimeFor('+16195550100', NOW)).toBe('Monday 11:00 AM'); // San Diego, PDT
    expect(localTimeFor('+12125550100', NOW)).toBe('Monday 2:00 PM'); // New York, EDT
  });

  it('falls back to Central time for an unmapped number', () => {
    expect(localTimeFor('+442071234567', NOW)).toBe('Monday 1:00 PM');
  });
});

describe('startAiCall — the call is live before its row is updated', () => {
  it('a failed CallSid write is retried once, and the call still returns ringing', async () => {
    const update = store.update.bind(store);
    let failures = 1;
    store.update = vi.fn(async (id, patch) => {
      if ('callSid' in patch && failures-- > 0) throw new Error('db blip');
      return update(id, patch);
    });
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res).toMatchObject({ ok: true, status: 'ringing' });
    if (!res.ok) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId)).toMatchObject({ callSid: CALL_SID, status: 'ringing' });
  });

  it('if the database stays down, it logs loudly and still answers ringing (never a 500 for a live call)', async () => {
    const error = vi.fn();
    deps.log = { ...silentLog, error };
    store.update = vi.fn(async () => Promise.reject(new Error('db down')));
    store.updateWhereStatus = vi.fn(async () => Promise.reject(new Error('db down')));
    const res = await start({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res).toMatchObject({ ok: true, status: 'ringing' });
    expect(error).toHaveBeenCalled();
    if (res.ok) expect(getActiveCall(res.aiCallId)?.callSid).toBe(CALL_SID);
  });
});

describe('startAiCall — the approved plan (plan 1C)', () => {
  it('registers the active call with the plan as prompt.approvedPlan', async () => {
    const res = await startAiCall({ db, cfg, session, target: { objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, plan: 'PLAN', deps });
    if (!res.ok) throw new Error('unreachable');
    expect(getActiveCall(res.aiCallId)?.prompt.approvedPlan).toBe('PLAN');
  });

  it('without a plan the prompt carries none (the instructions stay as they were)', async () => {
    for (const plan of [undefined, null, '']) {
      const res = await startAiCall({ db, cfg, session, target: { objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, plan, deps });
      if (!res.ok) throw new Error('unreachable');
      expect(getActiveCall(res.aiCallId)?.prompt.approvedPlan ?? null).toBeNull();
      expect('approvedPlan' in getActiveCall(res.aiCallId)!.prompt).toBe(false);
      clearActiveCalls();
      store.rows.clear();
    }
  });
});

describe('startAiCall — appointment times and practice calls (plan 1D)', () => {
  const TEST_NUMBER = '+15125550100';
  const SLOTS: AppointmentSlot[] = [
    {
      id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
      specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
    },
  ];
  const admin: SessionUser = { ...session, isAdmin: true };
  const practice = { practice: { objectType: 'Lead' as const, recordId: '00Q5e00000AbCdEFGH', to: TEST_NUMBER } };
  const gateCfg = {
    ...cfg,
    OPENAI_API_KEY: 'sk-test',
    AI_VOICE: 'on',
    OUTREACH_KILL_SWITCH: 'off',
    AI_VOICE_TEST_NUMBERS: `${TEST_NUMBER}, +12125550100`,
  } as unknown as AppConfig;
  const fakeGateDeps: GateDeps = {
    blockedTargets: async () => new Map(),
    dailyDialCount: async () => 0,
    withinCallingHours: () => false, // outside calling hours: a test-number call is exempt, a seller's is not
    pickAiDid: async () => ({ e164: FROM }),
  };
  /** The real gate, with no database behind it. */
  const realGate = () => {
    deps.gate = vi.fn((d, input) => gateAiCall(d, input, fakeGateDeps));
  };
  const run = (target: Parameters<typeof startAiCall>[0]['target'], s: SessionUser, extra: { slots?: AppointmentSlot[]; returning?: boolean } = {}) =>
    startAiCall({ db, cfg: gateCfg, session: s, target, plan: 'Opener: hi', ...extra, deps });

  it('1: a practice call by an admin to a listed number is placed, even with consent false on the record', async () => {
    realGate();
    deps.loadRecord.mockResolvedValue(record({ consentAiCall: false }));
    const res = await run(practice, admin);
    expect(res).toMatchObject({ ok: true, status: 'ringing' });
    expect(deps.gate.mock.calls[0]![1]).toMatchObject({ isAdmin: true, target: { kind: 'test', toRaw: TEST_NUMBER } });
    expect(twilio.placed[0]).toMatchObject({ to: TEST_NUMBER, from: FROM });
  });

  it('2: the practice row and prompt: is_test + practice, the record ids, offered slots, the seller version of the prompt, hand-off to the starter', async () => {
    realGate();
    store.handoff.set('005OWNER0000001', 'owner-user-id');
    const res = await run(practice, admin, { slots: SLOTS, returning: true });
    if (!res.ok) throw new Error(`not placed: ${res.reason}`);
    expect(deps.loadRecord).toHaveBeenCalledWith(admin.userId, 'Lead', '00Q5e00000AbCdEFGH');
    expect(store.rows.get(res.aiCallId)).toMatchObject({
      isTest: true, practice: true, sfObject: 'Lead', sfRecordId: '00Q5e00000AbCdEFGH', offeredSlots: SLOTS,
      toE164: TEST_NUMBER, handoffUserId: admin.userId,
    });
    const entry = getActiveCall(res.aiCallId)!;
    expect(entry.isTest).toBe(true);
    expect(entry.handoffUserId).toBe(admin.userId);
    expect(entry.prompt).toMatchObject({
      isTest: false, firstName: 'Jane', address: '12 Oak St, Austin, TX 78701', notes: 'Inherited the house.',
      returning: true, slots: SLOTS, sellerTimeZone: 'America/Chicago', approvedPlan: 'Opener: hi',
    });
  });

  it('3: a practice call by a non-admin is blocked not_admin_for_test, and the row says practice', async () => {
    realGate();
    const res = await run(practice, session);
    expect(res).toMatchObject({ ok: false, reason: 'not_admin_for_test' });
    expect(twilio.placed).toHaveLength(0);
    if ('aiCallId' in res) expect(store.rows.get(res.aiCallId)).toMatchObject({ isTest: true, practice: true, status: 'blocked', offeredSlots: [] });
  });

  it('4: a practice call to a number not on the test list is blocked not_admin_for_test', async () => {
    realGate();
    const res = await run({ practice: { ...practice.practice, to: '+16195550123' } }, admin);
    expect(res).toMatchObject({ ok: false, reason: 'not_admin_for_test' });
    expect(twilio.placed).toHaveLength(0);
  });

  it('4b: a practice record that cannot be loaded fails like a record call, before any gate', async () => {
    deps.loadRecord.mockResolvedValueOnce(null);
    expect(await run(practice, admin)).toEqual({ ok: false, reason: 'record_not_found' });
    deps.loadRecord.mockRejectedValueOnce(new Error('sf down'));
    expect(await run(practice, admin)).toEqual({ ok: false, reason: 'salesforce_error' });
    expect(deps.gate).not.toHaveBeenCalled();
  });

  it('5: a record call with slots stores them as offered and gives them to the prompt, in the seller zone', async () => {
    const res = await run({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, session, { slots: SLOTS, returning: true });
    if (!res.ok) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId)).toMatchObject({ isTest: false, practice: false, offeredSlots: SLOTS });
    expect(getActiveCall(res.aiCallId)!.prompt).toMatchObject({ isTest: false, returning: true, slots: SLOTS, sellerTimeZone: 'America/Los_Angeles' });
  });

  it('6: a record call without slots stores [] and its prompt is unchanged', async () => {
    const res = await run({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, session);
    if (!res.ok) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId)).toMatchObject({ practice: false, offeredSlots: [] });
    expect(getActiveCall(res.aiCallId)!.prompt).toEqual({
      agentName: 'Alex', companyName: 'GG Homes', firstName: 'Jane', address: '12 Oak St, Austin, TX 78701',
      notes: 'Inherited the house.', isTest: false, callbackNumber: FROM, approvedPlan: 'Opener: hi',
    });
  });

  it('a test-number call stays a plain test call: no record, practice false', async () => {
    const res = await run({ testTo: TEST_NUMBER }, admin);
    if (!res.ok) throw new Error('unreachable');
    expect(store.rows.get(res.aiCallId)).toMatchObject({ isTest: true, practice: false, sfRecordId: null, offeredSlots: [] });
  });
});
