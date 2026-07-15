import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  soqlQuery: vi.fn(),
  soqlEscape: (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
}));

import { resolveDialNumber, selectRawPhone } from './record-phone.js';
import { soqlQuery } from './client.js';

const mockSoql = soqlQuery as unknown as ReturnType<typeof vi.fn>;

describe('selectRawPhone', () => {
  it('prefers Mobile, falls back to Phone, else null', () => {
    expect(selectRawPhone({ MobilePhone: '619-555-0001', Phone: '619-555-0002' })).toBe('619-555-0001');
    expect(selectRawPhone({ MobilePhone: null, Phone: '619-555-0002' })).toBe('619-555-0002');
    expect(selectRawPhone({ MobilePhone: '', Phone: '' })).toBeNull();
    expect(selectRawPhone({})).toBeNull();
  });
});

describe('resolveDialNumber', () => {
  beforeEach(() => mockSoql.mockReset());

  it('resolves + normalizes a Lead mobile to E.164', async () => {
    mockSoql.mockResolvedValue([{ MobilePhone: '619-555-0100', Phone: null }]);
    const r = await resolveDialNumber('u', 'Lead', '00Q1');
    expect(r?.e164).toMatch(/^\+1\d{10}$/);
  });

  it('resolves an Opportunity via its primary contact', async () => {
    mockSoql.mockResolvedValue([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r?.e164).toMatch(/^\+1\d{10}$/);
  });

  it('returns null when the record/contact has no number', async () => {
    mockSoql.mockResolvedValue([]);
    expect(await resolveDialNumber('u', 'Lead', '00Q1')).toBeNull();
    mockSoql.mockResolvedValue([{ Contact: null }]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toBeNull();
  });
});
