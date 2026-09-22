import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({
  soqlQuery: vi.fn(),
  soqlEscape: (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
}));

import { _resetSkipFieldWarnForTests, choosePhones, fetchContactNames, opportunityPhones, resolveDialNumber } from './record-phone.js';
import { soqlQuery } from './client.js';

const mockSoql = soqlQuery as unknown as ReturnType<typeof vi.fn>;

/** The two name fields every DialTarget now carries, absent from a row that
 *  has neither (most fixtures here are about phones, not names). */
const NO_NAME = { displayName: null, contactId: null };

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

  it('resolves an Opportunity via its primary contact ONLY when the Opportunity itself has no phone', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null }])
      .mockResolvedValueOnce([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
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
    expect(await resolveDialNumber('u', 'Lead', '00Q1')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: false, ...NO_NAME });
    mockSoql.mockResolvedValue([{ Contact: null }]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: false, ...NO_NAME });
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
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: '+16195550199', skipOnDialer: false, ...NO_NAME });
  });
});

describe('resolveDialNumber — the display name (what the panel headlines before the record pops)', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(mockSoql.mock.calls[n]?.[1] ?? '');
  beforeEach(() => {
    mockSoql.mockReset();
    _resetSkipFieldWarnForTests();
  });

  it('asks the Lead for its Name in the same round trip as the phones, and returns it trimmed', async () => {
    mockSoql.mockResolvedValueOnce([{ Name: '  Ada Lovelace ', MobilePhone: '619-555-0100', Phone: null, Skip_on_Dialer__c: false }]);
    const r = await resolveDialNumber('u', 'Lead', '00Q1');
    expect(soqlOf(0)).toBe("SELECT Name, MobilePhone, Phone, Skip_on_Dialer__c FROM Lead WHERE Id = '00Q1' LIMIT 1");
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: null, skipOnDialer: false, displayName: 'Ada Lovelace', contactId: null });
  });

  it('asks the Lead for its Name on the field-less retry too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSoql
      .mockRejectedValueOnce(new Error('INVALID_FIELD: No such column Skip_on_Dialer__c'))
      .mockResolvedValueOnce([{ Name: 'Ada Lovelace', MobilePhone: '619-555-0100', Phone: null }]);
    const r = await resolveDialNumber('u', 'Lead', '00Q1');
    expect(soqlOf(1)).toBe("SELECT Name, MobilePhone, Phone FROM Lead WHERE Id = '00Q1' LIMIT 1");
    expect(r?.displayName).toBe('Ada Lovelace');
    warn.mockRestore();
  });

  it('asks the Contact for its Name (a Contact never carries a contactId — it IS the contact)', async () => {
    mockSoql.mockResolvedValueOnce([{ Name: 'Grace Hopper', MobilePhone: '619-555-0100', Phone: null }]);
    const r = await resolveDialNumber('u', 'Contact', '0031');
    expect(soqlOf(0)).toBe("SELECT Name, MobilePhone, Phone FROM Contact WHERE Id = '0031' LIMIT 1");
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: null, skipOnDialer: false, displayName: 'Grace Hopper', contactId: null });
  });

  it('an empty or blank Name is null, not "" — the card must fall back to the number, never headline nothing', async () => {
    mockSoql.mockResolvedValueOnce([{ Name: '   ', MobilePhone: '619-555-0100', Phone: null }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q1'))?.displayName).toBeNull();
    mockSoql.mockResolvedValueOnce([{ Name: '', MobilePhone: '619-555-0100', Phone: null }]);
    expect((await resolveDialNumber('u', 'Contact', '0031'))?.displayName).toBeNull();
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q2'))?.displayName).toBeNull();
  });

  it('a found-but-phoneless record still reports its name (the skipped/unreachable row shows WHO)', async () => {
    mockSoql.mockResolvedValueOnce([{ Name: 'Ada Lovelace', MobilePhone: null, Phone: null, Skip_on_Dialer__c: true }]);
    expect(await resolveDialNumber('u', 'Lead', '00Q1'))
      .toEqual({ e164: null, fallbackE164: null, skipOnDialer: true, displayName: 'Ada Lovelace', contactId: null });
  });

  it('an Opportunity reports its own Name AND its ContactId, so the caller can batch the person\'s name', async () => {
    mockSoql.mockResolvedValueOnce([{
      Name: ' 123 Main St ', ContactId: '003000000000001AAA',
      Mobile_Phone__c: '(213) 555-0199', Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: false,
    }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(soqlOf(0)).toBe(
      "SELECT Name, ContactId, Mobile_Phone__c, Phone__c, Other_Phone__c, Skip_on_Dialer__c FROM Opportunity WHERE Id = '006AAA' LIMIT 1",
    );
    // The Opportunity Name is the fallback headline; the batched lookup at
    // session creation swaps in the contact's name when ContactId resolves.
    expect(r).toEqual({
      e164: '+12135550199', fallbackE164: null, skipOnDialer: false,
      displayName: '123 Main St', contactId: '003000000000001AAA',
    });
    // Never a second query per record for the contact's name.
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });

  it('an Opportunity with no ContactId reports contactId null and keeps its own Name', async () => {
    mockSoql.mockResolvedValueOnce([{ Name: '123 Main St', ContactId: null, Mobile_Phone__c: '213-555-0199' }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false, displayName: '123 Main St', contactId: null });
  });

  it('an Opportunity that fell through to the Contact Role keeps its Name and ContactId from the first query', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Name: '123 Main St', ContactId: '003000000000001AAA', Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null }])
      .mockResolvedValueOnce([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({
      e164: '+12135550199', fallbackE164: null, skipOnDialer: false,
      displayName: '123 Main St', contactId: '003000000000001AAA',
    });
  });
});

describe('fetchContactNames — ONE batched read of the primary contacts\' names for a whole run', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(mockSoql.mock.calls[n]?.[1] ?? '');
  beforeEach(() => mockSoql.mockReset());

  /** A syntactically valid 18-char Contact id: '003' + 15 digits zero-padded. */
  const contactId = (n: number): string => `003${String(n).padStart(15, '0')}`;

  it('asks for every id in one IN (...) and maps Id → trimmed Name, dropping blanks', async () => {
    mockSoql.mockResolvedValueOnce([
      { Id: contactId(1), Name: ' Ada Lovelace ' },
      { Id: contactId(2), Name: '   ' },
      { Id: contactId(3), Name: null },
    ]);
    const names = await fetchContactNames('u', [contactId(1), contactId(2), contactId(3)]);
    expect(mockSoql).toHaveBeenCalledTimes(1);
    expect(soqlOf(0)).toBe(
      `SELECT Id, Name FROM Contact WHERE Id IN ('${contactId(1)}','${contactId(2)}','${contactId(3)}')`,
    );
    expect(names).toEqual(new Map([[contactId(1), 'Ada Lovelace']]));
  });

  it('chunks at 200 ids per query', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => contactId(i + 1));
    mockSoql.mockResolvedValue([]);
    await fetchContactNames('u', ids);
    expect(mockSoql).toHaveBeenCalledTimes(2);
    expect((soqlOf(0).match(/'003/g) ?? []).length).toBe(200);
    expect((soqlOf(1).match(/'003/g) ?? []).length).toBe(1);
    expect(soqlOf(1)).toContain(`'${contactId(201)}'`);
  });

  it('interpolates only 15/18-char alphanumeric ids — anything else never reaches the query, escaped or not', async () => {
    mockSoql.mockResolvedValue([]);
    const fifteen = '003000000000001';
    await fetchContactNames('u', [
      contactId(1), fifteen,
      "003000000000001AA'", // 18 chars, but a quote — not an id
      '003000000000001',    // duplicate of `fifteen`
      '0030000000000012',   // 16 chars
      '', "' OR 1=1 --",
    ]);
    expect(mockSoql).toHaveBeenCalledTimes(1);
    expect(soqlOf(0)).toBe(`SELECT Id, Name FROM Contact WHERE Id IN ('${contactId(1)}','${fifteen}')`);
  });

  it('with no valid ids, issues no query at all', async () => {
    expect(await fetchContactNames('u', [])).toEqual(new Map());
    expect(await fetchContactNames('u', ['nope', "'"])).toEqual(new Map());
    expect(mockSoql).not.toHaveBeenCalled();
  });

  it('propagates a failed query — the CALLER decides that a name is not worth failing a run over', async () => {
    mockSoql.mockRejectedValueOnce(new Error('SOQL failed (401): session expired'));
    await expect(fetchContactNames('u', [contactId(1)])).rejects.toThrow('session expired');
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
    expect(soqlOf(0)).toMatch(/SELECT Name, MobilePhone, Phone, Skip_on_Dialer__c FROM Lead/);
    expect(r).toEqual({ e164: '+16195550100', fallbackE164: null, skipOnDialer: true, ...NO_NAME });
  });

  it('an unchecked (or null) Lead checkbox is not a skip', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null, Skip_on_Dialer__c: false }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q1'))?.skipOnDialer).toBe(false);
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null, Skip_on_Dialer__c: null }]);
    expect((await resolveDialNumber('u', 'Lead', '00Q2'))?.skipOnDialer).toBe(false);
  });

  it('NEVER asks a Contact for the checkbox — the field does not exist there', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null }]);
    const r = await resolveDialNumber('u', 'Contact', '0031');
    expect(soqlOf(0)).not.toContain('Skip_on_Dialer__c');
    expect(r?.skipOnDialer).toBe(false);
  });

  it('reports a flagged record that has no number at all (skip has to beat unreachable)', async () => {
    mockSoql.mockResolvedValueOnce([{ MobilePhone: null, Phone: null, Skip_on_Dialer__c: true }]);
    expect(await resolveDialNumber('u', 'Lead', '00Q1')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: true, ...NO_NAME });

    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: true }])
      .mockResolvedValueOnce([]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toEqual({ e164: null, fallbackE164: null, skipOnDialer: true, ...NO_NAME });
  });

  it('retries WITHOUT the field on INVALID_FIELD, treats the record as unflagged, and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First Lead: the flag query 400s, the field-less retry answers. Dialing an
    // org that has not got the field yet must never fail.
    mockSoql.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ MobilePhone: '619-555-0100', Phone: null }]);
    expect(await resolveDialNumber('rep-005XYZ', 'Lead', '00Q1')).toEqual({ e164: '+16195550100', fallbackE164: null, skipOnDialer: false, ...NO_NAME });
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
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null }])
      .mockResolvedValueOnce([{ Contact: { MobilePhone: '213-555-0199', Phone: null } }]);

    expect(await resolveDialNumber('u', 'Opportunity', '006AAA'))
      .toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false, ...NO_NAME });
    expect(soqlOf(0)).toContain('Skip_on_Dialer__c');
    expect(soqlOf(1)).not.toContain('Skip_on_Dialer__c');
    warn.mockRestore();
  });

  it('propagates an error that is NOT a missing field (a real failure must not read as unflagged)', async () => {
    mockSoql.mockRejectedValueOnce(new Error('SOQL failed (401): session expired'));
    await expect(resolveDialNumber('u', 'Lead', '00Q1')).rejects.toThrow('session expired');
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDialNumber — Opportunity phone fields (this org stores phones on the Opportunity)', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(mockSoql.mock.calls[n]?.[1] ?? '');
  beforeEach(() => {
    mockSoql.mockReset();
    _resetSkipFieldWarnForTests();
  });

  it('opportunityPhones folds the three fields in order: primary is the first non-empty, fallback the next', () => {
    expect(opportunityPhones({ Mobile_Phone__c: '213-555-0100', Phone__c: '213-555-0200', Other_Phone__c: '213-555-0300' }))
      .toEqual({ MobilePhone: '213-555-0100', Phone: '213-555-0200' });
    expect(opportunityPhones({ Mobile_Phone__c: '  ', Phone__c: null, Other_Phone__c: '213-555-0300' }))
      .toEqual({ MobilePhone: '213-555-0300', Phone: null });
    expect(opportunityPhones({})).toEqual({ MobilePhone: null, Phone: null });
  });

  it('dials Mobile_Phone__c and never asks the Contact Role when the Opportunity has a number', async () => {
    mockSoql.mockResolvedValueOnce([{ Mobile_Phone__c: '(213) 555-0199', Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: false }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false, ...NO_NAME });
    expect(mockSoql).toHaveBeenCalledTimes(1);
    expect(soqlOf(0)).toBe("SELECT Name, ContactId, Mobile_Phone__c, Phone__c, Other_Phone__c, Skip_on_Dialer__c FROM Opportunity WHERE Id = '006AAA' LIMIT 1");
  });

  it('Phone__c then Other_Phone__c: the second non-empty field is the fallback', async () => {
    mockSoql.mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: '213-555-0100', Other_Phone__c: '213-555-0200' }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550100', fallbackE164: '+12135550200', skipOnDialer: false, ...NO_NAME });
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });

  it('falls back to the primary Contact Role only when all three Opportunity fields are empty', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: '', Other_Phone__c: null, Skip_on_Dialer__c: false }])
      .mockResolvedValueOnce([{ Contact: { MobilePhone: null, Phone: '213-555-0199' } }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false, ...NO_NAME });
    expect(mockSoql).toHaveBeenCalledTimes(2);
    expect(soqlOf(1)).toBe("SELECT Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole WHERE OpportunityId = '006AAA' AND IsPrimary = true LIMIT 1");
  });

  it('reads Skip on Dialer from the Opportunity query; a flagged Opportunity with no number anywhere is found-but-empty', async () => {
    mockSoql
      .mockResolvedValueOnce([{ Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: true }])
      .mockResolvedValueOnce([]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: null, fallbackE164: null, skipOnDialer: true, ...NO_NAME });
  });

  it('a missing Opportunity is null and the Contact Role is never asked', async () => {
    mockSoql.mockResolvedValueOnce([]);
    expect(await resolveDialNumber('u', 'Opportunity', '006AAA')).toBeNull();
    expect(mockSoql).toHaveBeenCalledTimes(1);
  });

  it('retries the Opportunity query without Skip_on_Dialer__c when the org has not got the field', async () => {
    mockSoql
      .mockRejectedValueOnce(new Error('INVALID_FIELD: No such column Skip_on_Dialer__c on entity Opportunity'))
      .mockResolvedValueOnce([{ Mobile_Phone__c: '213-555-0199' }]);
    const r = await resolveDialNumber('u', 'Opportunity', '006AAA');
    expect(r).toEqual({ e164: '+12135550199', fallbackE164: null, skipOnDialer: false, ...NO_NAME });
    expect(soqlOf(1)).toBe("SELECT Name, ContactId, Mobile_Phone__c, Phone__c, Other_Phone__c FROM Opportunity WHERE Id = '006AAA' LIMIT 1");
  });
});
