import { describe, expect, it } from 'vitest';
import { aggregate, type CheckResult } from './index.js';

const chk = (over: Partial<CheckResult>): CheckResult => ({
  name: 'gate',
  passed: true,
  severity: 'info',
  reasonCode: 'OK',
  ...over,
});

/**
 * The verdict precedence is what makes BLOCK gates actually block and REVIEW
 * gates require acknowledgement. Task #2's POST /calls enforcement relies on
 * this being correct.
 */
describe('aggregate', () => {
  it('ALLOW when every check passes at info severity', () => {
    expect(aggregate([chk({}), chk({})], 'script1').decision).toBe('ALLOW');
  });

  it('REQUIRE_REVIEW when any review-severity check is present and nothing blocks', () => {
    const r = aggregate([chk({}), chk({ severity: 'review' })], 'script1');
    expect(r.decision).toBe('REQUIRE_REVIEW');
    expect(r.requiredScriptId).toBe('script1');
  });

  it('BLOCK takes precedence over review, and drops the required script', () => {
    const r = aggregate(
      [chk({ severity: 'review' }), chk({ severity: 'block', passed: false, detail: 'on DNC' })],
      'script1',
    );
    expect(r.decision).toBe('BLOCK');
    expect(r.blockReason).toBe('on DNC');
    expect(r.requiredScriptId).toBeNull();
  });

  it('a PASSED block-severity check does not block', () => {
    expect(aggregate([chk({ severity: 'block', passed: true })], null).decision).toBe('ALLOW');
  });

  it('carries every reason code through in the reasons array', () => {
    const r = aggregate([chk({ reasonCode: 'A' }), chk({ reasonCode: 'B' })], null);
    expect(r.reasons).toEqual(['A', 'B']);
  });
});
