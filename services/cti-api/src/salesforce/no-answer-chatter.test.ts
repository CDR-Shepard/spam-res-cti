import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTCOMES,
  SWEEP_WINDOW_MS,
  attemptedWithinWindow,
  gateIdsFor,
  noAnswerText,
  selectNoAnswerRecords,
  verdictFor,
  type NoAnswerRecord,
  type SweepItem,
} from './no-answer-chatter.js';
import type { OwnershipSnapshot } from './ownership.js';

const NOW = new Date('2026-09-21T18:00:00.000Z');
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
    updatedAt: new Date(NOW.getTime() - 60_000),
    ...o,
  };
}
const select = (items: SweepItem[]): NoAnswerRecord[] => selectNoAnswerRecords(items, NOW);

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
    expect(select([a2, a1])).toEqual([
      { recordId: LEAD, itemIds: ['A1', 'A2'], reasons: ['no_answer', 'voicemail'], taskIds: [] },
    ]);
  });

  it('orders same-attempt items by ordinal (a Task run dialing one person off two tasks)', () => {
    const late = item({ id: 'L', attempt: 1, ordinal: 7, outcome: 'busy', taskId: TASK_2 });
    const early = item({ id: 'E', attempt: 1, ordinal: 2, outcome: 'fax', taskId: TASK });
    expect(select([late, early])).toEqual([
      { recordId: LEAD, itemIds: ['E', 'L'], reasons: ['fax', 'busy'], taskIds: [TASK, TASK_2] },
    ]);
  });

  it('every real-attempt outcome qualifies; `canceled` does not (a rep\'s own Stop/Skip must never manufacture activity)', () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(select([item({ outcome })])).toHaveLength(1);
    }
    expect(select([item({ outcome: 'canceled' })])).toEqual([]);
    expect(select([item({ outcome: null })])).toEqual([]);
    expect(select([item({ outcome: 'connected' })])).toEqual([]);
  });

  it('a canceled attempt beside a real one is left out of the count, and never stamped', () => {
    const real = item({ id: 'R', attempt: 1, outcome: 'voicemail' });
    const canceled = item({ id: 'C', attempt: 2, outcome: 'canceled' });
    expect(select([real, canceled])).toEqual([
      { recordId: LEAD, itemIds: ['R'], reasons: ['voicemail'], taskIds: [] },
    ]);
  });

  it('skipped / unreachable / pending / dialing are simply not attempts', () => {
    const rows = (['skipped', 'unreachable', 'pending', 'dialing'] as const).map((status) =>
      item({ status, outcome: status === 'skipped' ? 'out_of_hours' : null }));
    expect(select(rows)).toEqual([]);
  });

  it('a skipped row whose outcome happens to read like an attempt still does not count — status decides', () => {
    expect(select([item({ status: 'skipped', outcome: 'voicemail' })])).toEqual([]);
  });

  it('the rep TALKED to them on another attempt (connected or done) → no post at all', () => {
    const miss = item({ attempt: 1, outcome: 'voicemail' });
    expect(select([miss, item({ attempt: 2, status: 'connected', outcome: 'connected' })])).toEqual([]);
    expect(select([miss, item({ attempt: 2, status: 'done', outcome: 'connected' })])).toEqual([]);
  });

  it('a connect on ANOTHER record does not excuse this one', () => {
    const got = select([
      item({ id: 'M', recordId: LEAD, outcome: 'voicemail' }),
      item({ recordId: LEAD_2, status: 'done', outcome: 'connected' }),
    ]);
    expect(got.map((r) => r.recordId)).toEqual([LEAD]);
  });

  it('idempotency: a record with ANY qualifying item already stamped (posted or skipped) is not selected again', () => {
    const posted = [item({ attempt: 1, noAnswerFeedItemId: '0D5POSTED' }), item({ attempt: 2 })];
    const skipped = [item({ recordId: LEAD_2, noAnswerSkipReason: 'not-owner' })];
    expect(select([...posted, ...skipped])).toEqual([]);
  });

  it('only Lead / Contact / Opportunity ids are postable — a Task-id or custom-object row is guarded out', () => {
    const got = select([
      item({ recordId: LEAD }), item({ recordId: CONTACT, objectType: 'Contact' }), item({ recordId: OPP, objectType: 'Opportunity' }),
      item({ recordId: TASK, objectType: 'Task' }), item({ recordId: 'a0B8X00000AbCdEUAV', objectType: 'Deal__c' }),
    ]);
    expect(got.map((r) => r.recordId)).toEqual([LEAD, CONTACT, OPP]);
  });

  it('keeps records in run order (first qualifying ordinal), so chunking is deterministic across retries', () => {
    const got = select([
      item({ recordId: OPP, ordinal: 5 }), item({ recordId: LEAD, ordinal: 1 }), item({ recordId: CONTACT, ordinal: 3 }),
    ]);
    expect(got.map((r) => r.recordId)).toEqual([LEAD, CONTACT, OPP]);
  });

  it('carries the Task id forward from BOTH attempts without repeating it', () => {
    const got = select([
      item({ attempt: 1, taskId: TASK }), item({ attempt: 2, taskId: TASK }),
    ]);
    expect(got[0]!.taskIds).toEqual([TASK]);
  });

  it('does not mutate its input', () => {
    const rows = [item({ attempt: 2, ordinal: 4 }), item({ attempt: 1, ordinal: 1 })];
    const before = JSON.stringify(rows);
    select(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('an empty run selects nothing', () => {
    expect(select([])).toEqual([]);
  });

  describe('the 24h window is on the ATTEMPT (item.updatedAt), not the session', () => {
    // `stopSession` stamps the session's updated_at whenever it is called — on a
    // run paused on Sept 1 and stopped on Sept 20 too. The attempt's own settle
    // time is the only clock that says when the dial actually happened.
    const stale = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000);

    it('attemptedWithinWindow: NOW-24h+1s counts, NOW-24h does not', () => {
      expect(SWEEP_WINDOW_MS).toBe(24 * 60 * 60_000);
      expect(attemptedWithinWindow(item({ updatedAt: new Date(NOW.getTime() - SWEEP_WINDOW_MS + 1000) }), NOW)).toBe(true);
      expect(attemptedWithinWindow(item({ updatedAt: new Date(NOW.getTime() - SWEEP_WINDOW_MS + 1) }), NOW)).toBe(true);
      expect(attemptedWithinWindow(item({ updatedAt: new Date(NOW.getTime() - SWEEP_WINDOW_MS) }), NOW)).toBe(false);
      expect(attemptedWithinWindow(item({ updatedAt: stale }), NOW)).toBe(false);
    });

    it('a record whose only misses settled 3 days ago is simply not owed a post', () => {
      expect(select([item({ updatedAt: stale }), item({ attempt: 2, updatedAt: stale })])).toEqual([]);
    });

    it('a stale attempt beside a fresh one is not an attempt: the post counts only what happened inside the window', () => {
      const old = item({ id: 'OLD', attempt: 1, outcome: 'no_answer', updatedAt: stale });
      const fresh = item({ id: 'NEW', attempt: 2, outcome: 'voicemail' });
      expect(select([old, fresh])).toEqual([
        { recordId: LEAD, itemIds: ['NEW'], reasons: ['voicemail'], taskIds: [] },
      ]);
    });
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

describe('verdictFor', () => {
  const ME = '0058X00000RepMeQAV';
  const OTHER = '0058X00000OtherQAV';
  const mine: OwnershipSnapshot = { type: 'Lead', ownerId: ME, ownerName: 'Me' };
  const theirs: OwnershipSnapshot = { type: 'Lead', ownerId: OTHER, ownerName: 'Matt Penrod' };
  const rec = (o: Partial<NoAnswerRecord> = {}): NoAnswerRecord => ({ recordId: LEAD, itemIds: ['x'], reasons: ['busy'], taskIds: [], ...o });

  it('post — the rep owns the record', () => {
    expect(verdictFor(rec(), new Map([[LEAD, mine]]), ME)).toBe('post');
  });

  it('not-owner — someone else\'s record', () => {
    expect(verdictFor(rec(), new Map([[LEAD, theirs]]), ME)).toBe('not-owner');
  });

  it('not-found — Salesforce did not return the record (deleted / no read access): never post unverified', () => {
    expect(verdictFor(rec(), new Map(), ME)).toBe('not-found');
  });

  it('uses the ONE shared rule: queue-owned is postable, and an Opportunity lead manager is an owner', () => {
    const queue: OwnershipSnapshot = { type: 'Lead', ownerId: '00G8X000006aRkGUAU', ownerName: 'LA Hunt Queue' };
    const pseudoQueue: OwnershipSnapshot = { type: 'Opportunity', ownerId: '0058X00000FsyjzQAB', ownerName: 'Opportunity Hunt Queue', leadManagerId: null };
    const managed: OwnershipSnapshot = { type: 'Opportunity', ownerId: OTHER, ownerName: 'Matt Penrod', leadManagerId: ME };
    expect(verdictFor(rec(), new Map([[LEAD, queue]]), ME)).toBe('post');
    expect(verdictFor(rec({ recordId: OPP }), new Map([[OPP, pseudoQueue]]), ME)).toBe('post');
    expect(verdictFor(rec({ recordId: OPP }), new Map([[OPP, managed]]), ME)).toBe('post');
  });

  it('Task run: BOTH the record and the Task must pass', () => {
    const myTask: OwnershipSnapshot = { type: 'Task', ownerId: ME, ownerName: 'Me' };
    const theirTask: OwnershipSnapshot = { type: 'Task', ownerId: OTHER, ownerName: 'Matt Penrod' };
    const r = rec({ taskIds: [TASK] });
    expect(verdictFor(r, new Map([[LEAD, mine], [TASK, myTask]]), ME)).toBe('post');
    expect(verdictFor(r, new Map([[LEAD, mine], [TASK, theirTask]]), ME)).toBe('not-owner');
    expect(verdictFor(r, new Map([[LEAD, theirs], [TASK, myTask]]), ME)).toBe('not-owner');
    expect(verdictFor(r, new Map([[LEAD, mine]]), ME)).toBe('not-found'); // the Task is gone
  });

  it('one person dialed off two Tasks: every Task must pass', () => {
    const myTask: OwnershipSnapshot = { type: 'Task', ownerId: ME };
    const theirTask: OwnershipSnapshot = { type: 'Task', ownerId: OTHER };
    const r = rec({ taskIds: [TASK, TASK_2] });
    expect(verdictFor(r, new Map([[LEAD, mine], [TASK, myTask], [TASK_2, theirTask]]), ME)).toBe('not-owner');
    expect(verdictFor(r, new Map([[LEAD, mine], [TASK, myTask], [TASK_2, myTask]]), ME)).toBe('post');
  });
});
