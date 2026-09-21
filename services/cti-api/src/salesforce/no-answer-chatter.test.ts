import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTCOMES,
  gateIdsFor,
  noAnswerText,
  selectNoAnswerRecords,
  type SweepItem,
} from './no-answer-chatter.js';

const LEAD = '00Q8X00000AbCdEUAV';
const LEAD_2 = '00Q8X00000AbCdFUAV';
const CONTACT = '0038X00000AbCdEQAV';
const OPP = '0068X00000AbCdEQAV';
const TASK = '00T8X00000AbCdEUAV';
const TASK_2 = '00T8X00000AbCdFUAV';

let seq = 0;
function item(o: Partial<SweepItem> = {}): SweepItem {
  seq += 1;
  return {
    id: `I${seq}`, recordId: LEAD, objectType: 'Lead', status: 'no_connect', outcome: 'voicemail',
    attempt: 1, ordinal: seq, taskId: null, noAnswerFeedItemId: null, noAnswerSkipReason: null,
    ...o,
  };
}

describe('noAnswerText', () => {
  it('one attempt — the exact format, singular, with an em dash', () => {
    expect(noAnswerText(['voicemail'])).toBe('No answer (Power Dialer) — 1 attempt: voicemail');
  });

  it('two attempts — plural, reasons in order', () => {
    expect(noAnswerText(['no_answer', 'voicemail'])).toBe('No answer (Power Dialer) — 2 attempts: no answer, voicemail');
  });

  it('does NOT de-duplicate reasons: two voicemails are two attempts', () => {
    expect(noAnswerText(['voicemail', 'voicemail'])).toBe('No answer (Power Dialer) — 2 attempts: voicemail, voicemail');
  });

  it('labels every attempt outcome', () => {
    expect(noAnswerText([...ATTEMPT_OUTCOMES])).toBe(
      'No answer (Power Dialer) — 6 attempts: no answer, voicemail, busy, fax machine, hung up, call failed',
    );
  });

  it('the dash is U+2014, not a hyphen or an en dash', () => {
    expect(noAnswerText(['busy']).charCodeAt('No answer (Power Dialer) '.length)).toBe(0x2014);
  });
});

describe('selectNoAnswerRecords', () => {
  it('groups a record\'s attempts into ONE post, ordered by attempt then ordinal', () => {
    // Inserted out of order on purpose: attempt 2 first, and a lower ordinal
    // later, so a selector that trusted input order would get the text wrong.
    const a2 = item({ id: 'A2', attempt: 2, ordinal: 9, outcome: 'voicemail' });
    const a1 = item({ id: 'A1', attempt: 1, ordinal: 0, outcome: 'no_answer' });
    expect(selectNoAnswerRecords([a2, a1])).toEqual([
      { recordId: LEAD, itemIds: ['A1', 'A2'], reasons: ['no_answer', 'voicemail'], taskIds: [] },
    ]);
  });

  it('orders same-attempt items by ordinal (a Task run dialing one person off two tasks)', () => {
    const late = item({ id: 'L', attempt: 1, ordinal: 7, outcome: 'busy', taskId: TASK_2 });
    const early = item({ id: 'E', attempt: 1, ordinal: 2, outcome: 'fax', taskId: TASK });
    expect(selectNoAnswerRecords([late, early])).toEqual([
      { recordId: LEAD, itemIds: ['E', 'L'], reasons: ['fax', 'busy'], taskIds: [TASK, TASK_2] },
    ]);
  });

  it('every real-attempt outcome qualifies; `canceled` does not (a rep\'s own Stop/Skip must never manufacture activity)', () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(selectNoAnswerRecords([item({ outcome })])).toHaveLength(1);
    }
    expect(selectNoAnswerRecords([item({ outcome: 'canceled' })])).toEqual([]);
    expect(selectNoAnswerRecords([item({ outcome: null })])).toEqual([]);
    expect(selectNoAnswerRecords([item({ outcome: 'connected' })])).toEqual([]);
  });

  it('a canceled attempt beside a real one is left out of the count, and never stamped', () => {
    const real = item({ id: 'R', attempt: 1, outcome: 'voicemail' });
    const canceled = item({ id: 'C', attempt: 2, outcome: 'canceled' });
    expect(selectNoAnswerRecords([real, canceled])).toEqual([
      { recordId: LEAD, itemIds: ['R'], reasons: ['voicemail'], taskIds: [] },
    ]);
  });

  it('skipped / unreachable / pending / dialing are simply not attempts', () => {
    const rows = (['skipped', 'unreachable', 'pending', 'dialing'] as const).map((status) =>
      item({ status, outcome: status === 'skipped' ? 'out_of_hours' : null }));
    expect(selectNoAnswerRecords(rows)).toEqual([]);
  });

  it('a skipped row whose outcome happens to read like an attempt still does not count — status decides', () => {
    expect(selectNoAnswerRecords([item({ status: 'skipped', outcome: 'voicemail' })])).toEqual([]);
  });

  it('the rep TALKED to them on another attempt (connected or done) → no post at all', () => {
    const miss = item({ attempt: 1, outcome: 'voicemail' });
    expect(selectNoAnswerRecords([miss, item({ attempt: 2, status: 'connected', outcome: 'connected' })])).toEqual([]);
    expect(selectNoAnswerRecords([miss, item({ attempt: 2, status: 'done', outcome: 'connected' })])).toEqual([]);
  });

  it('a connect on ANOTHER record does not excuse this one', () => {
    const got = selectNoAnswerRecords([
      item({ id: 'M', recordId: LEAD, outcome: 'voicemail' }),
      item({ recordId: LEAD_2, status: 'done', outcome: 'connected' }),
    ]);
    expect(got.map((r) => r.recordId)).toEqual([LEAD]);
  });

  it('idempotency: a record with ANY qualifying item already stamped (posted or skipped) is not selected again', () => {
    const posted = [item({ attempt: 1, noAnswerFeedItemId: '0D5POSTED' }), item({ attempt: 2 })];
    const skipped = [item({ recordId: LEAD_2, noAnswerSkipReason: 'not-owner' })];
    expect(selectNoAnswerRecords([...posted, ...skipped])).toEqual([]);
  });

  it('only Lead / Contact / Opportunity ids are postable — a Task-id or custom-object row is guarded out', () => {
    const got = selectNoAnswerRecords([
      item({ recordId: LEAD }), item({ recordId: CONTACT, objectType: 'Contact' }), item({ recordId: OPP, objectType: 'Opportunity' }),
      item({ recordId: TASK, objectType: 'Task' }), item({ recordId: 'a0B8X00000AbCdEUAV', objectType: 'Deal__c' }),
    ]);
    expect(got.map((r) => r.recordId)).toEqual([LEAD, CONTACT, OPP]);
  });

  it('keeps records in run order (first qualifying ordinal), so chunking is deterministic across retries', () => {
    const got = selectNoAnswerRecords([
      item({ recordId: OPP, ordinal: 5 }), item({ recordId: LEAD, ordinal: 1 }), item({ recordId: CONTACT, ordinal: 3 }),
    ]);
    expect(got.map((r) => r.recordId)).toEqual([LEAD, CONTACT, OPP]);
  });

  it('carries the Task id forward from BOTH attempts without repeating it', () => {
    const got = selectNoAnswerRecords([
      item({ attempt: 1, taskId: TASK }), item({ attempt: 2, taskId: TASK }),
    ]);
    expect(got[0]!.taskIds).toEqual([TASK]);
  });

  it('does not mutate its input', () => {
    const rows = [item({ attempt: 2, ordinal: 4 }), item({ attempt: 1, ordinal: 1 })];
    const before = JSON.stringify(rows);
    selectNoAnswerRecords(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('an empty run selects nothing', () => {
    expect(selectNoAnswerRecords([])).toEqual([]);
  });
});

describe('gateIdsFor', () => {
  it('Lead/Opp run: the record alone', () => {
    expect(gateIdsFor({ recordId: LEAD, itemIds: ['x'], reasons: ['busy'], taskIds: [] })).toEqual([LEAD]);
  });
  it('Task run: the record AND the Task(s) — mayCreateTaskOn([recordId, taskId]) semantics', () => {
    expect(gateIdsFor({ recordId: LEAD, itemIds: ['x'], reasons: ['busy'], taskIds: [TASK, TASK_2] })).toEqual([LEAD, TASK, TASK_2]);
  });
});
