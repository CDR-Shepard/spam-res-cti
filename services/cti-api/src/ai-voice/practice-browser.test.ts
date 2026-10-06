/**
 * Plan 1E Task 7: a practice_browser call through startAiCall (the real gate, no database behind it) and through
 * finalize. It rings `client:<identity>` with AMD off, is is_test + practice like a phone practice call (G-2), and leaves no
 * `calls` row, opt-out or Salesforce Task behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@cti/auth';
import type { AppointmentSlot } from '@cti/contracts';
import type { AppConfig } from '../config.js';
import { gateAiCall, type GateDeps } from './gate.js';
import type { AiCallRecord } from './record.js';
import { clearActiveCalls, getActiveCall } from './registry.js';
import { afterAiCall, finalizeAiCall } from './service-finalize.js';
import { startAiCall, type StartDeps } from './service.js';
import type { AiCallRow } from './store.js';
import { fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const IDENTITY = `aitest_${ADMIN_ID.replace(/-/g, '')}_a1b2c3d4e5f6`;
const LEG = `client:${IDENTITY}`;
const RECORD_PHONE = '+16195550100';
const FROM = '+16195550000';
const NOW = new Date('2026-10-06T10:00:00Z'); // 3 AM for the record: no calling-hours rule applies to a browser leg
const LEAD = '00Q5e00000AbCdEFGH';
const SLOTS: AppointmentSlot[] = [
  {
    id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
    specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
  },
];
const cfg = {
  API_PUBLIC_URL: 'https://api.test', SESSION_SECRET: 's'.repeat(40), AI_VOICE_AGENT_NAME: 'Alex', AI_VOICE_MAX_CALL_SECONDS: 600,
  OPENAI_API_KEY: 'sk-test', AI_VOICE: 'on', OUTREACH_KILL_SWITCH: 'off', AI_VOICE_TEST_NUMBERS: '+15125550100',
} as unknown as AppConfig;
const admin: SessionUser = {
  userId: ADMIN_ID, orgId: 'oooooooo-0000-4000-8000-000000000001', email: 'a@example.com', isAdmin: true, powerDialerEnabled: false,
  kind: 'human', isSuperAdmin: false,
};
const record: AiCallRecord = {
  objectType: 'Lead', recordId: LEAD, name: 'Jane Doe', firstName: 'Jane', phones: [RECORD_PHONE], consentAiCall: false,
  consentFieldMissing: false, address: '12 Oak St, Austin, TX 78701', notes: '', ownerSfUserId: '005OWNER0000001',
};

let store: FakeStore;
let twilio: FakeTwilio;
let gateDeps: GateDeps & { [k: string]: ReturnType<typeof vi.fn> };
let deps: StartDeps;

beforeEach(() => {
  store = fakeStore();
  store.handoff.set('005OWNER0000001', 'owner-user-id');
  twilio = fakeTwilio();
  gateDeps = {
    blockedTargets: vi.fn(async () => new Map()),
    dailyDialCount: vi.fn(async () => 0),
    withinCallingHours: vi.fn(() => false),
    pickAiDid: vi.fn(async () => ({ e164: '+19995550000' })),
    peekAiCallerId: vi.fn(async () => FROM),
  };
  deps = {
    store, twilio, loadRecord: vi.fn(async () => record), now: () => NOW, log: silentLog,
    gate: vi.fn((d, input) => gateAiCall(d, input, gateDeps)),
  };
});
afterEach(() => clearActiveCalls());

const run = (identity = IDENTITY) =>
  startAiCall({
    db: {} as never, cfg, session: admin, plan: 'Opener: hi', slots: SLOTS,
    target: { practiceBrowser: { objectType: 'Lead', recordId: LEAD, identity } }, deps,
  });

describe('startAiCall — practice_browser', () => {
  it('9: rings client:<identity> with AMD off; the row is is_test + practice; the seller\'s prompt and local time', async () => {
    const res = await run();
    if (!res.ok) throw new Error(`not placed: ${res.reason}`);
    expect(store.rows.get(res.aiCallId)).toMatchObject({
      isTest: true, practice: true, toE164: LEG, fromE164: FROM, sfObject: 'Lead', sfRecordId: LEAD, offeredSlots: SLOTS,
      handoffUserId: ADMIN_ID,
    });
    expect(twilio.placed).toHaveLength(1);
    expect(twilio.placed[0]).toMatchObject({ to: LEG, from: FROM, amd: false });
    const entry = getActiveCall(res.aiCallId)!;
    expect(entry.isTest).toBe(true);
    expect(entry.prompt.isTest).toBe(false);
    expect(entry.prompt).toMatchObject({ sellerTimeZone: 'America/Los_Angeles', callbackNumber: FROM, approvedPlan: 'Opener: hi' });
    expect(entry.localTimeE164).toBe(RECORD_PHONE);
    // No phone is dialed: no opt-out, cap, hours or ceiling read, and no DID dial claimed.
    for (const k of ['blockedTargets', 'dailyDialCount', 'withinCallingHours', 'pickAiDid'] as const) expect(gateDeps[k]).not.toHaveBeenCalled();
  });

  it('a phone practice call still runs with AMD on', async () => {
    const res = await startAiCall({
      db: {} as never, cfg: { ...cfg, AI_VOICE_TEST_NUMBERS: '+15125550100' } as AppConfig, session: admin, plan: 'Opener: hi',
      target: { practice: { objectType: 'Lead', recordId: LEAD, to: '+15125550100' } }, deps,
    });
    expect(res.ok).toBe(true);
    expect(twilio.placed[0]).toMatchObject({ to: '+15125550100', amd: true });
  });

  it("another admin's identity is blocked invalid_number and nothing is dialed (G-3)", async () => {
    const res = await run(`aitest_${'b'.repeat(32)}_a1b2c3d4e5f6`);
    expect(res).toMatchObject({ ok: false, reason: 'invalid_number' });
    expect(twilio.placed).toHaveLength(0);
  });

  it('a second browser test while this leg is live is call_in_progress (double click)', async () => {
    expect((await run()).ok).toBe(true);
    expect(await run()).toMatchObject({ ok: false, reason: 'call_in_progress' });
    expect(twilio.placed).toHaveLength(1);
  });
});

describe('finalizeAiCall — a browser leg', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const BOOKED = {
    slotId: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
    specialistSfUserId: '0058X00000Fsx39QAB', addressConfirmed: true, note: '', bookedAt: NOW.toISOString(),
  };

  it('10: an appointment_set leg is finalized with no calls row, no opt-out and no Salesforce Task', async () => {
    await store.insert({
      id: ID, orgId: admin.orgId, startedBy: ADMIN_ID, handoffUserId: ADMIN_ID, toE164: LEG, fromE164: FROM, status: 'in_progress',
      callSid: `CA${'b'.repeat(32)}`, isTest: true, practice: true, sfObject: 'Lead', sfRecordId: LEAD,
    });
    store.rows.set(ID, { ...store.rows.get(ID)!, outcome: 'appointment_set', appointment: BOOKED } as AiCallRow);
    const sf = {
      createCallTask: vi.fn(async () => ({ taskId: '00T1' })),
      fetchOwnership: vi.fn(async () => ({ type: 'Lead' as const, ownerId: 'SF1' })),
      sfUserIdFor: vi.fn(async () => 'SF1'),
    };
    const info = vi.fn();
    const log = { ...silentLog, info };
    const afterCall = (row: AiCallRow) =>
      afterAiCall(row, { store, log, summary: { client: null, model: 'm', log }, sf: { sf, store, log, now: () => NOW } });
    const res = await finalizeAiCall({ store, log, afterCall }, ID, { callStatus: 'completed', durationSeconds: 120, endedAt: NOW });
    if (!res.finalized) throw new Error('not finalized');
    await res.after;
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'appointment_set', endedAt: NOW, ctiCallId: null });
    expect(store.ctiCalls.size).toBe(0);
    expect(store.optOuts).toEqual([]);
    expect(sf.createCallTask).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith({ aiCallId: ID }, 'ai-voice: browser test leg; no calls row');
    expect(store.rows.get(ID)?.summary).toBeTruthy();
  });

  it('10: a do_not_call leg re-asserts no opt-out either', async () => {
    await store.insert({ id: ID, orgId: admin.orgId, startedBy: ADMIN_ID, toE164: LEG, status: 'in_progress', callSid: 'CA1', isTest: true, practice: true });
    await store.update(ID, { outcome: 'do_not_call' });
    await finalizeAiCall({ store, log: silentLog }, ID, { callStatus: 'completed', durationSeconds: 30, endedAt: NOW });
    expect(store.optOuts).toEqual([]);
    expect(store.ctiCalls.size).toBe(0);
  });
});
