import { describe, expect, it, vi } from 'vitest';
import { workedTodayNumbers, workedTodaySafe } from './already-worked.js';

function fakeDb(rows: Array<{ toNumber: string }>, fail = false) {
  const where = vi.fn();
  return {
    _where: where,
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (cond: unknown) => { where(cond); if (fail) throw new Error('pg down'); return rows; }),
      })),
    })),
  } as never;
}

describe('workedTodayNumbers', () => {
  it('returns the distinct numbers the team dialed today', async () => {
    const db = fakeDb([{ toNumber: '+16195550100' }, { toNumber: '+12135550200' }]);
    const got = await workedTodayNumbers(db, 'O1', ['+16195550100', '+12135550200', '+19995550300']);
    expect(got).toEqual(new Set(['+16195550100', '+12135550200']));
  });
  it('short-circuits to an empty set with no candidate numbers (no query)', async () => {
    const db = fakeDb([]);
    expect(await workedTodayNumbers(db, 'O1', [])).toEqual(new Set());
    expect((db as { selectDistinct: ReturnType<typeof vi.fn> }).selectDistinct).not.toHaveBeenCalled();
  });
});

describe('workedTodaySafe — the one deliberate fail-open', () => {
  it('a query error yields an empty set and a warn, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await workedTodaySafe(fakeDb([], true), 'O1', ['+16195550100']);
      expect(got).toEqual(new Set());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('already-worked');
    } finally {
      warn.mockRestore();
    }
  });
});
