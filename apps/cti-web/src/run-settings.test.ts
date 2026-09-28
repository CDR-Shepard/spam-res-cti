import { describe, expect, it } from 'vitest';
import {
  digitsOnly,
  draftFromDefaults,
  parseHowMany,
  recordPositionLine,
  runDefaultsFromMe,
  runSettingsFor,
  runSettingsLine,
} from './run-settings';

describe('run settings on Ready to dial (spec 2026-09-28)', () => {
  it('a fresh draft is the saved choices plus All when no limit was saved', () => {
    expect(draftFromDefaults({ passes: 1, maxRecords: null, rolloverBusinessDays: 2 })).toEqual({ passes: 1, rolloverBusinessDays: 2, howMany: '' });
  });

  // Controller ruling S2 (spec 2026-09-28): How many is remembered too —
  // /auth/me's dialerRunDefaults.maxRecords prefills the box, null means All.
  it('a fresh draft prefills How many from a saved limit (ruling S2)', () => {
    expect(draftFromDefaults({ passes: 2, maxRecords: 100, rolloverBusinessDays: 1 })).toEqual({ passes: 2, rolloverBusinessDays: 1, howMany: '100' });
  });

  it("runDefaultsFromMe: the server's saved choices, including a saved limit (ruling S2); an older API (none) or junk is today's run", () => {
    expect(runDefaultsFromMe({ dialerRunDefaults: { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 } })).toEqual({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
    expect(runDefaultsFromMe({ dialerRunDefaults: { passes: 1, maxRecords: null, rolloverBusinessDays: 2 } })).toEqual({ passes: 1, maxRecords: null, rolloverBusinessDays: 2 });
    expect(runDefaultsFromMe({})).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(runDefaultsFromMe({ dialerRunDefaults: null })).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(runDefaultsFromMe({ dialerRunDefaults: { passes: 'once', maxRecords: 'lots', rolloverBusinessDays: 7 } })).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
  });

  it('the box keeps digits only', () => {
    expect(digitsOnly('1,000')).toBe('1000');
    expect(digitsOnly('50 people')).toBe('50');
    expect(digitsOnly('-3')).toBe('3');
    expect(digitsOnly('abc')).toBe('');
  });

  // Review fix (Important 1): the box's bound is the SERVER's maximum
  // (MAX_RUN_RECORDS), never the current list size — a remembered or typed
  // number bigger than today's list is fine; the list itself is what actually
  // caps what dials (see confirmLine's "— the whole list" copy).
  it('parseHowMany: blank is All; 1 to the server maximum is a number; anything else is refused', () => {
    expect(parseHowMany('')).toEqual({ ok: true, maxRecords: null });
    expect(parseHowMany('  ')).toEqual({ ok: true, maxRecords: null });
    expect(parseHowMany('1')).toEqual({ ok: true, maxRecords: 1 });
    expect(parseHowMany('500')).toEqual({ ok: true, maxRecords: 500 });
    for (const bad of ['0', '501', '1.5', '-1', 'abc', '99999999999999999999']) {
      expect(parseHowMany(bad)).toEqual({ ok: false, error: 'Enter a whole number from 1 to 500, or leave it blank for all.' });
    }
  });

  it('accepts a number above the current list size — the list caps what dials, not the box (review fix)', () => {
    // The exact repro: a saved 100 on what is today a 60-person list.
    expect(parseHowMany('100')).toEqual({ ok: true, maxRecords: 100 });
  });

  it('runSettingsFor: the Start body, or null while the box is invalid', () => {
    expect(runSettingsFor({ passes: 2, rolloverBusinessDays: 1, howMany: '' })).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(runSettingsFor({ passes: 1, rolloverBusinessDays: 2, howMany: '100' })).toEqual({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
    expect(runSettingsFor({ passes: 1, rolloverBusinessDays: 2, howMany: '0' })).toBeNull();
  });

  it('runSettingsLine reads like the spec, and is absent for an older server', () => {
    expect(runSettingsLine({ passes: 1, maxRecords: 100, rolloverBusinessDays: 1 })).toBe('Once · first 100 · missed → next business day');
    expect(runSettingsLine({ passes: 2, maxRecords: null, rolloverBusinessDays: 2 })).toBe('Twice · all · missed → in 2 business days');
    expect(runSettingsLine({})).toBeNull();
  });

  // Review fix (Minor, item 3a): a chosen limit (maxRecords) can be bigger
  // than what the list actually gave (runSize) — a saved 100 on a 45-person
  // list. Show what's true of THIS run, matching the confirm screen's own
  // "— the whole list" framing (Important 1), not the number once typed.
  it('runSettingsLine shows what the list actually gave when it is less than the chosen limit (review fix)', () => {
    expect(runSettingsLine({ passes: 1, maxRecords: 100, runSize: 45, rolloverBusinessDays: 1 })).toBe('Once · first 45 · missed → next business day');
    // runSize >= maxRecords: the chosen limit is what shows, as before.
    expect(runSettingsLine({ passes: 1, maxRecords: 100, runSize: 100, rolloverBusinessDays: 1 })).toBe('Once · first 100 · missed → next business day');
    // No limit (All): runSize is ignored — the whole list, always "all".
    expect(runSettingsLine({ passes: 2, maxRecords: null, runSize: 45, rolloverBusinessDays: 2 })).toBe('Twice · all · missed → in 2 business days');
    // An older server that omits runSize: unchanged, uses maxRecords as-is.
    expect(runSettingsLine({ passes: 1, maxRecords: 100, rolloverBusinessDays: 1 })).toBe('Once · first 100 · missed → next business day');
  });

  it('recordPositionLine: a limited run counts its own queue; a retry has no place in it; a full run keeps the list position', () => {
    expect(recordPositionLine({ ordinal: 2, attempt: 1, listPosition: 150 }, { runSize: 100, listTotal: 100 })).toBe('record 3 of 100');
    expect(recordPositionLine({ ordinal: 100, attempt: 2, listPosition: null }, { runSize: 100, listTotal: 100 })).toBeNull();
    expect(recordPositionLine({ attempt: 1, listPosition: 86 }, { runSize: 100, listTotal: 100 })).toBeNull(); // older server: no ordinal
    expect(recordPositionLine({ ordinal: 2, attempt: 1, listPosition: 86 }, { runSize: null, listTotal: 220 })).toBe('record 87 of 220');
    expect(recordPositionLine({ ordinal: 2, attempt: 1, listPosition: null }, { runSize: null, listTotal: 220 })).toBeNull();
  });

  // Review fix (Minor, item 3b): the ordinal-based FALLBACK (no runPosition —
  // an older server) never showed X > N either, unlike the runPosition
  // branch's own clamp. Same clamp here.
  it('recordPositionLine: the ordinal fallback also never shows X > N', () => {
    expect(recordPositionLine({ ordinal: 150, attempt: 1 }, { runSize: 100, listTotal: null })).toBe('record 100 of 100');
  });

  // Minor fix 1 (spec 2026-09-28 review): the server now sends its own
  // authoritative rank (`currentItem.runPosition`, already 1-based) for a
  // limited run — preferred over the client's ordinal estimate whenever it's
  // present. Never client-computed; an older server that omits it falls back
  // to the existing ordinal-based estimate above.
  it('recordPositionLine: prefers the server\'s own runPosition when present', () => {
    expect(recordPositionLine({ runPosition: 3, ordinal: 2, attempt: 1, listPosition: 150 }, { runSize: 100, listTotal: 100 })).toBe('record 3 of 100');
    // Never shows X > N, even if the server sent something inconsistent.
    expect(recordPositionLine({ runPosition: 105, ordinal: 2, attempt: 1, listPosition: 150 }, { runSize: 100, listTotal: 100 })).toBe('record 100 of 100');
    // No runSize (unlimited run): runPosition is ignored, list position rules as before.
    expect(recordPositionLine({ runPosition: 3, listPosition: 86 }, { runSize: null, listTotal: 220 })).toBe('record 87 of 220');
  });

  // Coordinator update to Minor fix 1: runPosition counts PEOPLE and is null
  // on a retry (attempt 2) — a limited run must never show "N of N" then. The
  // AttemptBadge ("Attempt 2 of 2") is the retry label; recordPositionLine
  // shows nothing, exactly like today's ordinal-based attempt-2 case.
  it('recordPositionLine: never "N of N" for a retry — a limited run\'s runPosition is null on attempt 2', () => {
    expect(recordPositionLine({ runPosition: null, ordinal: 5, attempt: 2 }, { runSize: 100, listTotal: 100 })).toBeNull();
  });
});
