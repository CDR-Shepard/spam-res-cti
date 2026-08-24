/**
 * POST /calls/:id/disposition — the `task_updated` branch.
 *
 * The 10-minute sweep auto-logs an abandoned call as "Not dispositioned"; the
 * rep then returns via the pending banner and submits the real disposition.
 * Because the disposition now lives INSIDE Task.Subject (call-subject.ts), that
 * correction has to rewrite Subject too — otherwise the activity timeline keeps
 * showing the wrong disposition on exactly the calls a rep took the trouble to
 * fix.
 *
 * Route-level (Fastify + fake-DB injection) rather than helper-level, following
 * dialer-handoffs.test.ts: the wiring — which fields reach the PATCH — is the
 * thing under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean } | null,
  call: null as Record<string, unknown> | null,
  updateCallTask: vi.fn(
    async (_userId: string, _taskId: string, _fields: Record<string, string | number | null>) => ({ updated: true }),
  ),
  fetchRecordName: vi.fn(async (_userId: string, _recordId: string): Promise<string | null> => null),
  enqueueSyncForCall: vi.fn(async () => {}),
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ TELEPHONY_PROVIDER: 'twilio' }),
}));

vi.mock('../auth/session.js', () => ({
  resolveSession: async () => state.authedUser,
}));

vi.mock('../salesforce/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../salesforce/client.js')>();
  return { ...actual, updateCallTask: state.updateCallTask };
});

// `counterpartyE164` and `AUTO_DISPOSITION` stay REAL — the counterparty
// derivation is part of what this test is proving.
vi.mock('../salesforce/sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../salesforce/sync.js')>();
  return { ...actual, fetchRecordName: state.fetchRecordName, enqueueSyncForCall: state.enqueueSyncForCall };
});

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { registerCallRoutes } from './calls.js';

/**
 * Just enough drizzle for the disposition route: read the fixture call, then
 * `update(...).set(...).where(...).returning()` the fixture merged with the
 * patch. `where` is never introspected (the package-wide fake-DB convention).
 */
function fakeDb() {
  return {
    query: { calls: { findFirst: async () => state.call } },
    update(_table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return { returning: async () => [{ ...state.call, ...values }] };
            },
          };
        },
      };
    },
  } as unknown as ReturnType<typeof import('../db/index.js').getDb>;
}

const CALL = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'call-1',
  userId: 'U1',
  direction: 'outbound',
  status: 'completed',
  fromNumber: '+13235249247',
  toNumber: '619-555-1234',
  normalizedToNumber: '+16195551234',
  // The sweep already logged it as "Not dispositioned" — hence the Task id.
  salesforceTaskId: '00T1',
  disposition: 'Not dispositioned',
  salesforceWhoId: null,
  salesforceWhatId: null,
  notes: null,
  durationSeconds: 12,
  endedAt: new Date(),
  ...over,
});

let app: FastifyInstance;

beforeEach(async () => {
  state.authedUser = { userId: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false };
  state.call = CALL();
  state.updateCallTask.mockClear();
  state.fetchRecordName.mockClear();
  state.fetchRecordName.mockResolvedValue(null);
  state.enqueueSyncForCall.mockClear();
  app = Fastify();
  await registerCallRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function correct(disposition: string, notes?: string) {
  return app.inject({
    method: 'POST',
    url: '/calls/call-1/disposition',
    headers: { authorization: 'Bearer tok' },
    payload: { disposition, ...(notes === undefined ? {} : { notes }) },
  });
}

describe('POST /calls/:id/disposition — correcting an already-logged Task', () => {
  it('rewrites Subject with the corrected disposition and the record name', async () => {
    state.call = CALL({ salesforceWhoId: '00Q1' });
    state.fetchRecordName.mockResolvedValue('Jane Doe');

    const res = await correct('Left voicemail', 'called back tomorrow');

    expect(res.statusCode).toBe(200);
    expect(res.json().salesforceSync).toBe('task_updated');
    expect(state.fetchRecordName).toHaveBeenCalledWith('U1', '00Q1');
    expect(state.updateCallTask).toHaveBeenCalledTimes(1);
    expect(state.updateCallTask.mock.calls[0]).toEqual([
      'U1',
      '00T1',
      {
        Subject: 'Outbound Call | Left voicemail | (619) 555-1234 / Jane Doe',
        CallDisposition: 'Left voicemail',
        Description: 'called back tomorrow',
      },
    ]);
  });

  it('falls back to the WhatId when there is no WhoId', async () => {
    state.call = CALL({ salesforceWhatId: '0061' });
    state.fetchRecordName.mockResolvedValue('Acme — 123 Main St');

    await correct('Connected');

    expect(state.fetchRecordName).toHaveBeenCalledWith('U1', '0061');
    expect(state.updateCallTask.mock.calls[0]?.[2]).toMatchObject({
      Subject: 'Outbound Call | Connected | (619) 555-1234 / Acme — 123 Main St',
    });
  });

  it('writes a number-only Subject when no record is attached (no name lookup at all)', async () => {
    await correct('No answer');

    expect(state.fetchRecordName).not.toHaveBeenCalled();
    expect(state.updateCallTask.mock.calls[0]?.[2]).toEqual({
      Subject: 'Outbound Call | No answer | (619) 555-1234',
      CallDisposition: 'No answer',
      Description: '',
    });
  });

  it('still rewrites Subject when the name lookup fails — a name is cosmetic', async () => {
    state.call = CALL({ salesforceWhoId: '00Q1' });
    state.fetchRecordName.mockRejectedValue(new Error('SOQL 503'));

    const res = await correct('Voicemail');

    expect(res.json().salesforceSync).toBe('task_updated');
    expect(state.updateCallTask.mock.calls[0]?.[2]).toMatchObject({
      Subject: 'Outbound Call | Voicemail | (619) 555-1234',
    });
  });

  it('uses the inbound heading and the caller number for an inbound call', async () => {
    // Inbound never reaches this route today (findPendingDisposition is
    // outbound-scoped), but the derivation must match syncOne's so the two
    // writers can never disagree about what the Subject says.
    state.call = CALL({ direction: 'inbound', fromNumber: '(619) 555-1234', normalizedToNumber: '+13235249247' });

    await correct('Connected');

    expect(state.updateCallTask.mock.calls[0]?.[2]).toMatchObject({
      Subject: 'Inbound Call | Connected | (619) 555-1234',
    });
  });

  it('does not touch the Task when the Open CTI surface owns it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/calls/call-1/disposition',
      headers: { authorization: 'Bearer tok' },
      payload: { disposition: 'Voicemail', skipSalesforceSync: true },
    });

    expect(res.json().salesforceSync).toBe('skipped_client_logged');
    expect(state.updateCallTask).not.toHaveBeenCalled();
  });
});
