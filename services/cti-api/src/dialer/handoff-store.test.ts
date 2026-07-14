import { describe, expect, it } from 'vitest';
import { isValidSfId, parseHandoffInput, constantTimeEqual } from './handoff-store.js';

describe('isValidSfId', () => {
  it('accepts a 15-char alphanumeric id', () => {
    expect(isValidSfId('00Q000000000001')).toBe(true);
  });

  it('accepts an 18-char alphanumeric id', () => {
    expect(isValidSfId('00Q000000000001AAA')).toBe(true);
  });

  it('rejects ids with symbols', () => {
    expect(isValidSfId('00Q00000000000-')).toBe(false);
    expect(isValidSfId('00Q0000_0000001')).toBe(false);
  });

  it('rejects ids shorter than 15 chars', () => {
    expect(isValidSfId('00Q00000000')).toBe(false);
  });

  it('rejects ids longer than 18 chars', () => {
    expect(isValidSfId('00Q000000000001AAAAA')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidSfId('')).toBe(false);
  });
});

describe('parseHandoffInput', () => {
  const sfUserId = '005000000000001AAA';
  const recordId1 = '00Q000000000001AAA';
  const recordId2 = '00Q000000000002AAA';

  it('accepts a valid Lead handoff and dedupes recordIds', () => {
    const result = parseHandoffInput({
      salesforceUserId: sfUserId,
      objectType: 'Lead',
      recordIds: [recordId1, recordId2, recordId1],
    });
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unexpected error result');
    expect(result.salesforceUserId).toBe(sfUserId);
    expect(result.objectType).toBe('Lead');
    expect(result.recordIds).toEqual([recordId1, recordId2]);
  });

  it('accepts a valid Opportunity handoff', () => {
    const result = parseHandoffInput({
      salesforceUserId: sfUserId,
      objectType: 'Opportunity',
      recordIds: [recordId1],
    });
    expect('error' in result).toBe(false);
  });

  it('rejects an unsupported objectType', () => {
    const result = parseHandoffInput({ salesforceUserId: sfUserId, objectType: 'Account', recordIds: [recordId1] });
    expect('error' in result).toBe(true);
  });

  it('rejects an empty recordIds array', () => {
    const result = parseHandoffInput({ salesforceUserId: sfUserId, objectType: 'Lead', recordIds: [] });
    expect('error' in result).toBe(true);
  });

  it('rejects more than 500 recordIds', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `00Q${String(i).padStart(12, '0')}`);
    const result = parseHandoffInput({ salesforceUserId: sfUserId, objectType: 'Lead', recordIds: tooMany });
    expect('error' in result).toBe(true);
  });

  it('rejects a malformed recordId', () => {
    const result = parseHandoffInput({ salesforceUserId: sfUserId, objectType: 'Lead', recordIds: ['not-a-valid-id'] });
    expect('error' in result).toBe(true);
  });

  it('rejects a malformed salesforceUserId', () => {
    const result = parseHandoffInput({ salesforceUserId: 'nope', objectType: 'Lead', recordIds: [recordId1] });
    expect('error' in result).toBe(true);
  });

  it('rejects a non-object body', () => {
    expect('error' in (parseHandoffInput(null) as { error: string })).toBe(true);
    expect('error' in (parseHandoffInput('junk') as { error: string })).toBe(true);
    expect('error' in (parseHandoffInput(undefined) as { error: string })).toBe(true);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('secret-value', 'secret-value')).toBe(true);
  });

  it('returns false for unequal strings of the same length', () => {
    expect(constantTimeEqual('secret-value', 'secret-valuf')).toBe(false);
  });

  it('returns false for strings of different lengths (without throwing)', () => {
    expect(constantTimeEqual('short', 'a-much-longer-secret')).toBe(false);
  });

  it('returns false when one side is empty', () => {
    expect(constantTimeEqual('', 'nonempty')).toBe(false);
  });

  it('returns true when both sides are empty', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
