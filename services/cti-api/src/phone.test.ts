import { describe, expect, it } from 'vitest';
import { normalize, toE164 } from './phone.js';

describe('normalize', () => {
  it('accepts a US number with default region', () => {
    const r = normalize('(415) 555-2671');
    expect(r.ok).toBe(true);
    expect(r.value?.e164).toBe('+14155552671');
    expect(r.value?.country).toBe('US');
  });

  it('accepts a fully-qualified E.164 number', () => {
    const r = normalize('+442071838750');
    expect(r.ok).toBe(true);
    expect(r.value?.country).toBe('GB');
  });

  it('rejects an empty string', () => {
    expect(normalize('').ok).toBe(false);
  });

  it('rejects something with no digits', () => {
    expect(normalize('abc').ok).toBe(false);
  });

  it('rejects an invalid number', () => {
    expect(normalize('1').ok).toBe(false);
  });

  it('toE164 returns null on bad input', () => {
    expect(toE164('xx')).toBeNull();
  });
});
