import { describe, expect, it } from 'vitest';
import { classifyNumberVerifier } from './numberverifier.js';

describe('classifyNumberVerifier', () => {
  it('is healthy when nothing is flagged', () => {
    const r = classifyNumberVerifier({ phone: '+16195551234', flag_status: false, errors: null, checks: [] });
    expect(r.flagged).toBe(false);
    expect(r.health).toBe('healthy');
  });

  it('marks spam_likely when a carrier check is flagged', () => {
    const r = classifyNumberVerifier({
      phone: '+16195551234',
      flag_status: true,
      checks: [
        { carrier: 'ATT', flag_status: true, words: 'Spam Likely' },
        { carrier: 'TMOBILE', flag_status: false },
      ],
    });
    expect(r.flagged).toBe(true);
    expect(r.health).toBe('spam_likely');
    expect(r.flaggedCarriers).toEqual(['ATT']);
    expect(r.reasons.join(' ')).toContain('Spam Likely');
  });

  it('treats DNO / 606 / 608 as a hard block (spam_likely)', () => {
    for (const code of ['DNO', '606', '608']) {
      const r = classifyNumberVerifier({ phone: '+1', errors: code, checks: [] });
      expect(r.flagged, code).toBe(true);
      expect(r.health, code).toBe('spam_likely');
    }
  });

  it('treats 607 (provider blocked) as a softer degrade', () => {
    const r = classifyNumberVerifier({ phone: '+1', errors: '607', checks: [] });
    expect(r.flagged).toBe(true);
    expect(r.health).toBe('degraded');
  });

  it('parses comma-separated error strings and string flags', () => {
    const r = classifyNumberVerifier({ phone: '+1', errors: '607,606', checks: [{ carrier: 'VERIZON', flag_status: 'true' }] });
    expect(r.health).toBe('spam_likely'); // 606 hard block wins
    expect(r.flaggedCarriers).toContain('VERIZON');
  });

  it('handles array errors and missing checks', () => {
    const r = classifyNumberVerifier({ phone: '+1', errors: ['607'] });
    expect(r.health).toBe('degraded');
  });
});
