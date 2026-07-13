import { describe, expect, it } from 'vitest';
import { selectRawPhone } from './record-phone.js';

describe('selectRawPhone', () => {
  it('prefers Mobile, falls back to Phone, else null', () => {
    expect(selectRawPhone({ MobilePhone: '619-555-0001', Phone: '619-555-0002' })).toBe('619-555-0001');
    expect(selectRawPhone({ MobilePhone: null, Phone: '619-555-0002' })).toBe('619-555-0002');
    expect(selectRawPhone({ MobilePhone: '', Phone: '' })).toBeNull();
    expect(selectRawPhone({})).toBeNull();
  });
});
