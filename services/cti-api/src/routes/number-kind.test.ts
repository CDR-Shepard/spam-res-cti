import { describe, expect, it } from 'vitest';
import { kindForImportedNumber, numberKindChange } from './number-kind.js';

describe('kindForImportedNumber — a Twilio FriendlyName containing "(ai_pool)" imports as an AI number', () => {
  it.each([
    ['AI calls (ai_pool)', 'ai_pool'],
    ['ai calls (AI_POOL)', 'ai_pool'],
    ['(Ai_Pool) spare', 'ai_pool'],
    ['(619) 724-4374', 'agent'],
    ['ai_pool', 'agent'], // the parentheses are part of the marker
    ['', 'agent'],
    [undefined, 'agent'],
  ] as const)('%s → %s', (name, kind) => {
    expect(kindForImportedNumber(name)).toBe(kind);
  });
});

describe('numberKindChange — an AI number is never a rep\'s', () => {
  const agent = { kind: 'agent' as const, assignedUserId: 'rep-1' };
  const ai = { kind: 'ai_pool' as const, assignedUserId: null };

  it('moving a number into AI calls un-assigns it', () => {
    expect(numberKindChange(agent, { kind: 'ai_pool' })).toEqual({ ok: true, set: { kind: 'ai_pool', assignedUserId: null } });
  });

  it('refuses AI calls together with a rep', () => {
    expect(numberKindChange(agent, { kind: 'ai_pool', assignedUserId: 'rep-2' })).toEqual({
      ok: false,
      error: 'An AI calls number cannot be assigned to a rep',
    });
  });

  it('refuses assigning a rep to an AI number unless it moves out of AI calls in the same change', () => {
    expect(numberKindChange(ai, { assignedUserId: 'rep-2' }).ok).toBe(false);
    expect(numberKindChange(ai, { kind: 'agent', assignedUserId: 'rep-2' })).toEqual({
      ok: true,
      set: { kind: 'agent', assignedUserId: 'rep-2' },
    });
  });

  it('leaves everything else as it was', () => {
    expect(numberKindChange(agent, {})).toEqual({ ok: true, set: {} });
    expect(numberKindChange(agent, { assignedUserId: null })).toEqual({ ok: true, set: { assignedUserId: null } });
    expect(numberKindChange(ai, { assignedUserId: null })).toEqual({ ok: true, set: { assignedUserId: null } });
    expect(numberKindChange(agent, { kind: 'dialer_pool' })).toEqual({ ok: true, set: { kind: 'dialer_pool' } });
  });
});
