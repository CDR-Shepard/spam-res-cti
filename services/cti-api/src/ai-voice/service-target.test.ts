/**
 * The four AI call target kinds, each function of service-target.ts against each kind (plan 1E Task 7, D-2).
 * practice_browser rings `client:<identity>` with a real record's context, is gated by the browser branch, and its row is
 * is_test + practice (G-2).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@cti/auth';
import type { AiCallRecord } from './record.js';
import type { StartInput } from './service.js';
import { gateTarget, handoffUser, loadTarget, rowTarget, targetKind, typedNumber, type StartTarget } from './service-target.js';
import { fakeStore, silentLog } from './testing.js';

const LEAD = '00Q5e00000AbCdEFGH';
const TEST_NUMBER = '+15125550100';
const RECORD_PHONE = '+16195550100';
const STARTER = 'aaaaaaaa-0000-4000-8000-000000000001';
const IDENTITY = `aitest_${STARTER.replace(/-/g, '')}_a1b2c3d4e5f6`;

const record: AiCallRecord = {
  objectType: 'Lead', recordId: LEAD, name: 'Jane Doe', firstName: 'Jane', phones: [RECORD_PHONE], consentAiCall: false,
  consentFieldMissing: false, address: null, notes: '', ownerSfUserId: '005OWNER0000001',
};

const targets: Record<'record' | 'test' | 'practice' | 'practice_browser', StartTarget> = {
  record: { objectType: 'Lead', recordId: LEAD },
  test: { testTo: '(512) 555-0100' },
  practice: { practice: { objectType: 'Lead', recordId: LEAD, to: TEST_NUMBER } },
  practice_browser: { practiceBrowser: { objectType: 'Lead', recordId: LEAD, identity: IDENTITY } },
};

const session: SessionUser = { userId: STARTER, orgId: 'o1', email: 'a@example.com', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };

function input(target: StartTarget, loaded: AiCallRecord | null = record): StartInput {
  const store = fakeStore();
  store.handoff.set('005OWNER0000001', 'owner-user-id');
  return {
    db: {} as never, cfg: {} as never, session, target,
    deps: { store, twilio: {} as never, gate: vi.fn() as never, loadRecord: vi.fn(async () => loaded), now: () => new Date(), log: silentLog },
  };
}

describe('service-target, every function against every kind', () => {
  it.each([
    ['record', 'record', null, { kind: 'record', record }, { sfObject: 'Lead', sfRecordId: LEAD, isTest: false, practice: false }],
    ['test', 'test', '(512) 555-0100', { kind: 'test', toRaw: '(512) 555-0100' }, { sfObject: null, sfRecordId: null, isTest: true, practice: false }],
    ['practice', 'practice', TEST_NUMBER, { kind: 'test', toRaw: TEST_NUMBER }, { sfObject: 'Lead', sfRecordId: LEAD, isTest: true, practice: true }],
    [
      'practice_browser', 'practice_browser', `client:${IDENTITY}`, { kind: 'browser', identity: IDENTITY },
      { sfObject: 'Lead', sfRecordId: LEAD, isTest: true, practice: true },
    ],
  ] as const)('%s: kind, typed number, gate target and row', (key, kind, typed, gate, row) => {
    const t = targets[key];
    expect(targetKind(t)).toBe(kind);
    expect(typedNumber(t)).toBe(typed);
    expect(gateTarget(t, record)).toEqual(gate);
    expect(rowTarget(t)).toEqual(row);
  });

  it.each([
    ['record', record, RECORD_PHONE],
    ['test', null, TEST_NUMBER],
    ['practice', record, TEST_NUMBER],
    ['practice_browser', record, `client:${IDENTITY}`],
  ] as const)('%s: loadTarget gives the record and the leg it would ring', async (key, wantRecord, candidate) => {
    const i = input(targets[key]);
    expect(await loadTarget(i)).toEqual({ record: wantRecord, candidate });
    if (key !== 'test') expect(i.deps.loadRecord).toHaveBeenCalledWith(STARTER, 'Lead', LEAD);
  });

  it('practice_browser: a record that cannot be loaded fails like a practice call', async () => {
    expect(await loadTarget(input(targets.practice_browser, null))).toEqual({ fail: 'record_not_found' });
  });

  it.each([
    ['record', 'owner-user-id'],
    ['test', STARTER],
    ['practice', STARTER],
    ['practice_browser', STARTER],
  ] as const)('%s: a transfer rings %s', async (key, want) => {
    expect(await handoffUser(input(targets[key]), record)).toBe(want);
  });
});
