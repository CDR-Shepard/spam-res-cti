import type { CallPlan, RecordTest, RecordTestCall } from '@cti/contracts';

/** Fixtures for the Test a record page (plan 1E). */
export const TEST_ID = '55555555-5555-4555-8555-555555555555';
export const OTHER_TEST_ID = '66666666-6666-4666-8666-666666666666';
export const CALL_ID = '77777777-7777-4777-8777-777777777777';
export const AI_CALL_ID = '88888888-8888-4888-8888-888888888888';
/** 00Q5e00000AbCdE with its checksum. */
export const LEAD_ID = '00Q5e00000AbCdEEAV';
export const LEAD_URL = 'https://gg.lightning.force.com/lightning/r/Lead/00Q5e00000AbCdE/view';
export const IDENTITY = `aitest_${'a'.repeat(32)}_${'b'.repeat(12)}`;

export const PLAN_TEXT = 'Situation: inherited the house.\nOpener: Ask how the move went.';

export function recordPlan(over: Partial<CallPlan> = {}): CallPlan {
  return {
    situationSummary: 'Inherited the house from her mother.',
    sellingSignals: [{ signal: 'Moving out of state', evidence: 'relocating to Ohio in spring', source: 'note', strength: 'strong' }],
    opener: 'Ask how the move to Ohio is going.',
    goals: [
      { goal: 'still_selling', known: null, approach: 'Ask if selling is still on the table' },
      { goal: 'timeline', known: 'Spring', approach: 'Confirm the spring date' },
      { goal: 'condition', known: null, approach: 'Ask about the roof' },
      { goal: 'price_expectations', known: null, approach: 'Ask what number would work' },
    ],
    talkingPoints: [],
    questions: ['Is the house empty?'],
    avoid: [],
    bestTimeToCall: { window: 'any', reason: '' },
    doNotContact: null,
    reengagement: { lastContact: 'back in February', lastContactAt: null, lastContactKind: 'call', lastTopic: 'the roof' },
    stillToLearn: ['price', 'mortgage'],
    ...over,
  };
}

export function recordTest(over: Partial<RecordTest> = {}): RecordTest {
  return {
    id: TEST_ID,
    sfObject: 'Lead',
    sfRecordId: LEAD_ID,
    recordUrl: `https://gg.my.salesforce.com/${LEAD_ID}`,
    name: 'Jane Seller',
    status: 'ready',
    error: null,
    consent: 'yes',
    plan: recordPlan(),
    planText: PLAN_TEXT,
    planTextWords: [],
    returning: true,
    slots: [
      { id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:30:00.000Z', specialistSfUserId: '005000000000001AAA', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles' },
    ],
    offerNote: null,
    ownerSfUserId: '005000000000001AAA',
    sources: [{ source: 'tasks', status: 'ok', count: 4, truncated: false, note: null }],
    costMicros: 52_000,
    requestedByName: 'Admin',
    createdAt: '2026-10-06T17:00:00.000Z',
    calls: [],
    ...over,
  };
}

export function recordTestCall(over: Partial<RecordTestCall> = {}): RecordTestCall {
  return {
    id: CALL_ID,
    mode: 'phone',
    toE164: '+15125550111',
    createdAt: '2026-10-06T17:05:00.000Z',
    aiCallId: AI_CALL_ID,
    result: { result: 'placed', aiCallId: AI_CALL_ID },
    callStatus: 'completed',
    outcome: 'appointment_set',
    summary: 'She wants a call about the roof.',
    durationSeconds: 125,
    callbackAt: null,
    qualification: {},
    appointment: null,
    appointmentWith: null,
    dryRun: null,
    ...over,
  };
}
