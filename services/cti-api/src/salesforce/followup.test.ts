import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  soqlQuery: vi.fn(),
  sfFetch: vi.fn(),
  soqlEscape: (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
}));
vi.mock('./business-calendar.js', () => ({ nextBusinessDayFor: vi.fn(async () => '2026-07-14') }));

import { followUpCopyFields, pickFollowUpTask, rolloverFollowUp, type FollowUpTask } from './followup.js';
import { sfFetch, soqlQuery } from './client.js';

const mockSoql = soqlQuery as unknown as ReturnType<typeof vi.fn>;
const mockFetch = sfFetch as unknown as ReturnType<typeof vi.fn>;
const openTask = { Id: '00T1', Subject: 'Follow-up', Type: 'Call', Priority: 'Normal', OwnerId: '005', WhoId: '00Q1', WhatId: null, ActivityDate: '2026-07-01' };

const t = (o: Partial<FollowUpTask>): FollowUpTask => ({
  Id: 'x', Subject: 'Follow-up', Type: 'Call', Priority: 'Normal',
  OwnerId: '005', WhoId: '00Q1', WhatId: null, ActivityDate: '2026-07-10', ...o,
});

describe('pickFollowUpTask', () => {
  it('ignores non-follow-up subjects', () => {
    expect(pickFollowUpTask([t({ Subject: 'Send contract' })])).toBeNull();
  });
  it('matches the three spellings, case-insensitively', () => {
    for (const s of ['Follow-up', 'Followup', 'follow up call', 'FOLLOW-UP']) {
      expect(pickFollowUpTask([t({ Subject: s })])).not.toBeNull();
    }
  });
  it('returns the earliest-due matching task', () => {
    const picked = pickFollowUpTask([
      t({ Id: 'a', ActivityDate: '2026-07-12' }),
      t({ Id: 'b', ActivityDate: '2026-07-08' }),
      t({ Id: 'c', ActivityDate: null }),
    ]);
    expect(picked?.Id).toBe('b');
  });
});

describe('followUpCopyFields', () => {
  it('copies core fields, drops null Who/What, sets due date + open status', () => {
    const f = followUpCopyFields(t({ WhatId: null, WhoId: '00Q9' }), '2026-07-14');
    expect(f).toMatchObject({
      Subject: 'Follow-up', Type: 'Call', Priority: 'Normal', OwnerId: '005',
      WhoId: '00Q9', Status: 'Not Started', ActivityDate: '2026-07-14',
    });
    expect('WhatId' in f).toBe(false);
  });
});

describe('rolloverFollowUp', () => {
  beforeEach(() => { mockSoql.mockReset(); mockFetch.mockReset(); });

  it('no matching task → nulls, no writes', async () => {
    mockSoql.mockResolvedValue([]);
    const r = await rolloverFollowUp('u', '005', '00Q1', '2026-07-13');
    expect(r).toEqual({ completed: null, created: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('creates the copy BEFORE completing the original', async () => {
    mockSoql.mockResolvedValue([openTask]);
    const calls: string[] = [];
    mockFetch.mockImplementation(async (_u: string, path: string) => {
      calls.push(path);
      return path === '/sobjects/Task' ? { status: 201, json: { id: '00Tnew' } } : { status: 204, json: null };
    });
    const r = await rolloverFollowUp('u', '005', '00Q1', '2026-07-13');
    expect(calls[0]).toBe('/sobjects/Task');       // create first
    expect(calls[1]).toBe('/sobjects/Task/00T1');  // then complete
    expect(r).toEqual({ completed: '00T1', created: '00Tnew' });
  });

  it('does NOT complete the original when the copy create fails', async () => {
    mockSoql.mockResolvedValue([openTask]);
    mockFetch.mockResolvedValue({ status: 500, json: [{ message: 'boom' }] });
    await expect(rolloverFollowUp('u', '005', '00Q1', '2026-07-13')).rejects.toThrow(/create failed for task 00T1/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[1]).toBe('/sobjects/Task');
  });
});
