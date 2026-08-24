import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  soqlQuery: vi.fn(),
  soqlEscape: (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
}));

import { _resetSkipFieldWarnForTests, choosePhones, resolveDialNumber } from './record-phone.js';
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

  it('returns null ONLY when the record is missing — a found record with no number reports a null e164', async () => {
    // Missing: no Lead row, and an Opportunity with no primary contact role.
    mockSoql.mockResolvedValue([]);
    expect(await resolveDialNumber('u', 'Lead', '00Q1')).toBeNull();
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toBeNull();

    // Found but unreachable. The row still has to come back so its Skip on
    // Dialer flag can be read — a null here would hide the checkbox.
    mockSoql.mockResolvedValue([{ MobilePhone: null, Phone: null }]);
    expect(await resolveDialNumber('u', 'Lead', '00Q1')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: false });
    mockSoql.mockResolvedValue([{ Contact: null }]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: false });
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

  it('resolves a Contact by Mobile then Phone', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '(619) 555-0100', Phone: '(619) 555-0199' }]);
    const r = await resolveDialNumber('u1', 'Contact', '0031');
    expect(mockSoql.mock.calls[0]?.[1]).toMatch(/FROM Contact WHERE Id = '0031'/);
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: '+16195550199', skipOnDialer: false });
  });
});

describe('resolveDialNumber — Skip on Dialer', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(mockSoql.mock.calls[n]?.[1] ?? '');

  const INVALID_FIELD = new Error(
    'SOQL failed (400): [{"message":"No such column \'Skip_on_Dialer__c\'","errorCode":"INVALID_FIELD"}]',
  );

  // The module owns a process-wide warn-once flag; without this the order tests
  // run in decides what they see.
  beforeEach(() => {
    mockSoql.mockReset();
    _resetSkipFieldWarnForTests();
  });

  it('asks the Lead for the checkbox and reports a checked Lead as skipped', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null, Skip_on_Dialer__c: true }]);
    const r = await resolveDialNumber('u', 'Lead', '00Q1');
    expect(soqlOf(0)).toMatch(/SELECT MobilePhone, Phone, Skip_on_Dialer__c FROM Lead/);
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: null, skipOnDialer: true });
  });

  it('an unchecked (or null) Lead checkbox is not a skip', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null, Skip_on_Dialer__c: false }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q1'))?.skipOnDialer).toBe(false);
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null, Skip_on_Dialer__c: null }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q2'))?.skipOnDialer).toBe(false);
  });

  it('reads the parent Opportunity checkbox through the contact-role query', async () => {
    mockSoql.mockResolvedValueOnce([{
      Contact: { MobilePhone: null, Phone: '213-555-0199' },
      Opportunity: { Skip_on_Dialer__c: true },
    }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(soqlOf(0)).toMatch(/SELECT Contact\.MobilePhone, Contact\.Phone, Opportunity\.Skip_on_Dialer__c FROM OpportunityContactRole/);
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: true });
  });

  it('NEVER asks a Contact for the checkbox — the field does not exist there', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null }]);
    const r = await resolveDialNumber('u', 'Contact', '0031');
    expect(soqlOf(0)).not.toContain('Skip_on_Dialer__c');
    expect(r?.skipOnDialer).toBe(false);
  });

  it('reports a flagged record that has no number at all (skip has to beat unreachable)', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: null, Phone: null, Skip_on_Dialer__c: true }]);
    expect(await resolveDialNumber('u', 'Lead', '00Q1')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: true });

    mockSoql.mockResolvedValueOnce([{ Contact: null, Opportunity: { Skip_on_Dialer__c: true } }]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: true });
  });

  it('retries WITHOUT the field on INVALID_FIELD, treats the record as unflagged, and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First Lead: the flag query 400s, the field-less retry answers. Dialing an
    // org that has not got the field yet must never fail.
    mockSoql.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null }]);
    expect(await resolveDialNumber('rep-005XYZ', 'Lead', '00Q1')).toEqual({ e164: '+16195550100', fallbackE164: null, skipOnDialer: false });
    expect(mockSoql).toHaveBeenCalledTimes(2);
    expect(soqlOf(0)).toContain('Skip_on_Dialer__c');
    expect(soqlOf(1)).not.toContain('Skip_on_Dialer__c');

    // A second lookup — a DIFFERENT user — still asks for the field: the flag is
    // a log deduper, not a control-flow latch, and it is process-wide, not
    // per-connection. This process serves many orgs, and the next org's Lead may
    // well have the field (mirrors ownership.ts).
    mockSoql.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ MobilePhone: '619-555-0200', Phone: null }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q2'))?.skipOnDialer).toBe(false);
    expect(mockSoql).toHaveBeenCalledTimes(4);
    expect(soqlOf(2)).toContain('Skip_on_Dialer__c');

    expect(warn).toHaveBeenCalledTimes(1);

    // The single line is the ONLY signal an operator gets, and INVALID_FIELD also
    // means "this rep has no field-level read" — a flagged record they then dial.
    // So it has to name the connection it is about and admit both causes.
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('rep-005XYZ');
    expect(line).toMatch(/field-level read/);
    expect(line).toMatch(/that connection's/);
    warn.mockRestore();
  });

  it('retries WITHOUT the field on INVALID_FIELD on the Opportunity path too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSoql
      .mockRejectedValueOnce(INVALID_FIELD)
      .mockResolvedValueOnce([{ Contact: { MobilePhone: '213-555-0199', Phone: null } }]);

    expect(await resolveDialNumber('u', 'Opportunity', '006AAA'))
      .toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false });
    expect(soqlOf(0)).toContain('Opportunity.Skip_on_Dialer__c');
    expect(soqlOf(1)).not.toContain('Skip_on_Dialer__c');
    warn.mockRestore();
  });

  it('propagates an error that is NOT a missing field (a real failure must not read as unflagged)', async () => {
    mockSoql.mockRejectedValueOnce(new Error('SOQL failed (401): session expired'));
    await expect(resolveDialNumber('u', 'Lead', '00Q1')).rejects.toThrow('session expired');
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });
});
