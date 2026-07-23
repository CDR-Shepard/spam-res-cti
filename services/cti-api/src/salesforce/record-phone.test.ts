import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  soqlQuery: vi.fn(),
  soqlEscape: (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
}));

import { choosePhones, resolveDialNumber } from './record-phone.js';
import { soqlQuery } from './client.js';

const mockSoql = soqlQuery as unknown as ReturnType<typeof vi.fn>;

describe('choosePhones', () => {
  it('makes Mobile the primary and Phone the fallback', () => {
    expect(choosePhones('619-555-0001', '619-555-0002')).toEqual({ primaryRaw: '619-555-0001', fallbackRaw: '619-555-0002' });
  });
  it('with no Mobile, the Phone is the primary and there is no fallback', () => {
    expect(choosePhones(null, '619-555-0002')).toEqual({ primaryRaw: '619-555-0002', fallbackRaw: null });
  });
  it('with only a Mobile, there is no fallback', () => {
    expect(choosePhones('619-555-0001', '  ')).toEqual({ primaryRaw: '619-555-0001', fallbackRaw: null });
  });
  it('with neither, both are null', () => {
    expect(choosePhones('', null)).toEqual({ primaryRaw: null, fallbackRaw: null });
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

  it('returns the Mobile as primary and the Phone as a distinct fallback', async () => {
    mockSoql.mockResolvedValue([{ MobilePhone: '619-555-0100', Phone: '213-555-0199' }]);
    const r = await resolveDialNumber('u', 'Lead', '00Q1');
    expect(r?.e164).toMatch(/^\+1619555/);
    expect(r?.fallbackE164).toMatch(/^\+1213555/);
  });

  it('drops the fallback when Mobile and Phone are the same number (differing formats)', async () => {
    mockSoql.mockResolvedValue([{ MobilePhone: '(619) 555-0100', Phone: '619-555-0100' }]);
    const r = await resolveDialNumber('u', 'Lead', '00Q1');
    expect(r?.e164).toMatch(/^\+1619555/);
    expect(r?.fallbackE164).toBeNull();
  });

  it('has no fallback when only one of Mobile/Phone is present', async () => {
    mockSoql.mockResolvedValue([{ MobilePhone: '619-555-0100', Phone: null }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q1'))?.fallbackE164).toBeNull();
    mockSoql.mockResolvedValue([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
    expect((await resolveDialNumber('u', 'Opportunity', '006AAA'))?.fallbackE164).toBeNull();
  });
});
