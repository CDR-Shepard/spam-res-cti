import { describe, expect, it } from 'vitest';
import { addPlacement, AI_CALLS, AI_CALLS_LABEL, groupNumbers, placementOf, placementPatch, RESERVE } from './admin-numbers';

const rep = { id: 'rep-1' };
const agent = { id: 'n1', kind: 'agent' as const, assignedUserId: 'rep-1' };
const reserve = { id: 'n2', kind: 'agent' as const, assignedUserId: null };
const pool = { id: 'n3', kind: 'dialer_pool' as const, assignedUserId: null };
const ai = { id: 'n4', kind: 'ai_pool' as const, assignedUserId: null };

describe('the AI calls placement', () => {
  it('is labelled "AI calls"', () => {
    expect(AI_CALLS_LABEL).toBe('AI calls');
  });

  it('a row shows AI calls, its rep, or Reserve', () => {
    expect(placementOf(ai)).toBe(AI_CALLS);
    expect(placementOf(agent)).toBe('rep-1');
    expect(placementOf(reserve)).toBe(RESERVE);
    expect(placementOf(pool)).toBe(RESERVE);
    // A stray assignee on an AI number still reads as AI calls.
    expect(placementOf({ ...ai, assignedUserId: 'rep-1' })).toBe(AI_CALLS);
  });

  it('choosing AI calls files the number as ai_pool, unassigned', () => {
    expect(placementPatch(agent, AI_CALLS)).toEqual({ kind: 'ai_pool', assignedUserId: null });
  });

  it('moving an AI number to a rep or the reserve makes it an agent number in the same edit', () => {
    expect(placementPatch(ai, 'rep-1')).toEqual({ kind: 'agent', assignedUserId: 'rep-1' });
    expect(placementPatch(ai, RESERVE)).toEqual({ kind: 'agent', assignedUserId: null });
  });

  it("a rep number's assignment changes leave its kind alone", () => {
    expect(placementPatch(agent, RESERVE)).toEqual({ assignedUserId: null });
    expect(placementPatch(pool, 'rep-1')).toEqual({ assignedUserId: 'rep-1' });
  });

  it('the Add form sends the AI kind, or the assignee', () => {
    expect(addPlacement(AI_CALLS)).toEqual({ kind: 'ai_pool', assignedUserId: null });
    expect(addPlacement(RESERVE)).toEqual({ assignedUserId: null });
    expect(addPlacement('rep-1')).toEqual({ assignedUserId: 'rep-1' });
  });
});

describe('groupNumbers', () => {
  it('reps, then the reserve, then AI calls; an AI number is only ever in AI calls', () => {
    const groups = groupNumbers([agent, reserve, pool, ai, { ...ai, id: 'n5', assignedUserId: 'rep-1' }], [rep], () => 'Rep One');
    expect(groups.map((g) => [g.key, g.title, g.icon, g.rows.map((r) => r.id)])).toEqual([
      ['rep-1', 'Rep One', 'rep', ['n1']],
      [RESERVE, 'Reserve pool', 'reserve', ['n2', 'n3']],
      [AI_CALLS, 'AI calls', 'ai', ['n4', 'n5']],
    ]);
  });

  it('rows without a kind (an older API) group as before', () => {
    const groups = groupNumbers([{ id: 'x', assignedUserId: null }], [], () => '');
    expect(groups.find((g) => g.key === RESERVE)!.rows).toHaveLength(1);
  });
});
