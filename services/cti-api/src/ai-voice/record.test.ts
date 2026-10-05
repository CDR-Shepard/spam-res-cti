import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DialTarget } from '../salesforce/record-phone.js';
import type { RecordAddress } from '../salesforce/client.js';
import { NOTES_MAX_CHARS, clearDescribeCache, loadAiCallRecord, type RecordDeps } from './record.js';

const LEAD_ID = '00Q5e00000AbCdEFGH';
const OPP_ID = '0065e00000AbCdEFGH';

type Field = { name: string; label: string };
const LEAD_FIELDS: Field[] = [
  { name: 'Id', label: 'Lead ID' },
  { name: 'AI_Call_Consent__c', label: 'AI Call Consent' },
  { name: 'Notes__c', label: 'Notes' },
  { name: 'Description', label: 'Description' },
  { name: 'Motivation__c', label: 'Motivation' },
  { name: 'FirstName', label: 'First Name' },
  { name: 'Name', label: 'Full Name' },
  { name: 'OwnerId', label: 'Owner ID' },
  { name: 'Unrelated__c', label: 'Unrelated' },
];

interface FakeOpts {
  fields?: Field[];
  describeStatus?: number;
  record?: Record<string, unknown> | null;
  tasks?: Array<Record<string, unknown>>;
  tasksFail?: boolean;
  dial?: DialTarget | null;
  address?: RecordAddress | null;
}

function fakeDeps(o: FakeOpts = {}) {
  const soql: string[] = [];
  const deps = {
    sfFetch: vi.fn(async (_userId: string, path: string) => {
      if (!path.endsWith('/describe')) throw new Error(`unexpected path ${path}`);
      return { status: o.describeStatus ?? 200, json: { fields: o.fields ?? LEAD_FIELDS } };
    }),
    soqlQuery: vi.fn(async (_userId: string, q: string) => {
      soql.push(q);
      if (q.includes('FROM Task')) {
        if (o.tasksFail) throw new Error('SOQL failed (400)');
        return o.tasks ?? [];
      }
      return o.record === null ? [] : [o.record ?? { Id: LEAD_ID }];
    }),
    resolveDialNumber: vi.fn(async () =>
      o.dial === undefined
        ? { e164: '+16195550100', fallbackE164: '+16195550101', skipOnDialer: false, displayName: 'Jane Doe', contactId: null }
        : o.dial,
    ),
    fetchRecordAddress: vi.fn(async () =>
      o.address === undefined
        ? { state: 'CA', country: 'US', postalCode: '92101', recordName: 'Jane Doe', objectType: 'Lead' as const }
        : o.address,
    ),
  } satisfies RecordDeps;
  return { deps, soql };
}

beforeEach(() => clearDescribeCache());

describe('loadAiCallRecord', () => {
  it('rejects a malformed record id before any Salesforce call', async () => {
    const { deps } = fakeDeps();
    for (const bad of ['', 'abc', "00Q5e00000AbCdE'OR", '00Q5e00000AbCdEFGHIJ']) {
      expect(await loadAiCallRecord('U1', 'Lead', bad, deps)).toBeNull();
    }
    expect(deps.sfFetch).not.toHaveBeenCalled();
    expect(deps.soqlQuery).not.toHaveBeenCalled();
  });

  it('builds the record context from the fields the org has (happy path)', async () => {
    const { deps, soql } = fakeDeps({
      record: {
        Id: LEAD_ID,
        AI_Call_Consent__c: true,
        Notes__c: 'Inherited the house',
        Description: '  ',
        Motivation__c: 'Relocating',
        FirstName: 'Jane',
        Name: 'Jane Doe',
        OwnerId: '0055e000001AAAAAAA',
      },
      tasks: [
        { Subject: 'Call', Description: 'Left VM', ActivityDate: '2026-10-02', CreatedDate: '2026-10-02T10:00:00.000+0000' },
        { Subject: 'Email', Description: null, ActivityDate: null, CreatedDate: '2026-09-30T10:00:00.000+0000' },
      ],
    });
    const rec = await loadAiCallRecord('U1', 'Lead', LEAD_ID, deps);
    expect(rec).toEqual({
      objectType: 'Lead',
      recordId: LEAD_ID,
      name: 'Jane Doe',
      firstName: 'Jane',
      phones: ['+16195550100', '+16195550101'],
      consentAiCall: true,
      consentFieldMissing: false,
      address: 'CA 92101, US',
      notes: [
        'Notes: Inherited the house',
        'Motivation: Relocating',
        'Task 2026-09-30 — Email',
        'Task 2026-10-02 — Call: Left VM',
      ].join('\n'),
      ownerSfUserId: '0055e000001AAAAAAA',
    });
    const recordSoql = soql.find((q) => q.includes('FROM Lead'))!;
    expect(recordSoql).toContain(`WHERE Id = '${LEAD_ID}'`);
    for (const f of ['AI_Call_Consent__c', 'Notes__c', 'Description', 'Motivation__c', 'FirstName', 'Name', 'OwnerId']) {
      expect(recordSoql).toContain(f);
    }
    // Only fields the describe reported, and never one outside the allowlist.
    for (const f of ['Agent_Notes__c', 'SecondaryMotivation__c', 'Unrelated__c']) expect(recordSoql).not.toContain(f);
    const taskSoql = soql.find((q) => q.includes('FROM Task'))!;
    expect(taskSoql).toBe(
      `SELECT Subject, Description, ActivityDate, CreatedDate FROM Task WHERE WhoId = '${LEAD_ID}' ORDER BY CreatedDate DESC LIMIT 5`,
    );
  });

  it('reports a missing consent field as consentFieldMissing with consentAiCall false', async () => {
    const { deps, soql } = fakeDeps({
      fields: LEAD_FIELDS.filter((f) => f.name !== 'AI_Call_Consent__c'),
      record: { Id: LEAD_ID, Name: 'Jane Doe' },
    });
    const rec = await loadAiCallRecord('U1', 'Contact', LEAD_ID, deps);
    expect(rec?.consentFieldMissing).toBe(true);
    expect(rec?.consentAiCall).toBe(false);
    expect(soql.find((q) => q.includes('FROM Contact'))).not.toContain('AI_Call_Consent__c');
  });

  it('treats anything but boolean true as no consent', async () => {
    const { deps } = fakeDeps({ record: { Id: LEAD_ID, AI_Call_Consent__c: 'true' } });
    const rec = await loadAiCallRecord('U1', 'Lead', LEAD_ID, deps);
    expect(rec?.consentAiCall).toBe(false);
    expect(rec?.consentFieldMissing).toBe(false);
  });

  it('returns null when the record is not visible', async () => {
    const { deps } = fakeDeps({ record: null });
    expect(await loadAiCallRecord('U1', 'Lead', LEAD_ID, deps)).toBeNull();
  });

  it('Skip on Dialer means no phones', async () => {
    const { deps } = fakeDeps({
      dial: { e164: '+16195550100', fallbackE164: null, skipOnDialer: true, displayName: null, contactId: null },
    });
    expect((await loadAiCallRecord('U1', 'Lead', LEAD_ID, deps))?.phones).toEqual([]);
  });

  it('no dial target / no number means no phones; a lone primary is one phone', async () => {
    expect((await loadAiCallRecord('U1', 'Lead', LEAD_ID, fakeDeps({ dial: null }).deps))?.phones).toEqual([]);
    clearDescribeCache();
    const none = fakeDeps({ dial: { e164: null, fallbackE164: null, skipOnDialer: false, displayName: null, contactId: null } });
    expect((await loadAiCallRecord('U1', 'Lead', LEAD_ID, none.deps))?.phones).toEqual([]);
    clearDescribeCache();
    const one = fakeDeps({ dial: { e164: '+16195550100', fallbackE164: null, skipOnDialer: false, displayName: null, contactId: null } });
    expect((await loadAiCallRecord('U1', 'Lead', LEAD_ID, one.deps))?.phones).toEqual(['+16195550100']);
  });

  it('queries an Opportunity\'s Tasks by WhatId', async () => {
    const { deps, soql } = fakeDeps({ record: { Id: OPP_ID }, address: null });
    const rec = await loadAiCallRecord('U1', 'Opportunity', OPP_ID, deps);
    expect(soql.find((q) => q.includes('FROM Task'))).toContain(`WHERE WhatId = '${OPP_ID}'`);
    expect(rec?.address).toBeNull();
    expect(deps.resolveDialNumber).toHaveBeenCalledWith('U1', 'Opportunity', OPP_ID);
  });

  it('caps notes at NOTES_MAX_CHARS, keeping the newest (Task) content', async () => {
    const { deps } = fakeDeps({
      record: { Id: LEAD_ID, Notes__c: 'x'.repeat(10_000) },
      tasks: [{ Subject: 'Newest', Description: 'keep me', ActivityDate: '2026-10-03' }],
    });
    const rec = await loadAiCallRecord('U1', 'Lead', LEAD_ID, deps);
    expect(rec!.notes.length).toBe(NOTES_MAX_CHARS);
    expect(rec!.notes.endsWith('Task 2026-10-03 — Newest: keep me')).toBe(true);
  });

  it('a failed Task or address read degrades to no tasks / no address', async () => {
    const { deps } = fakeDeps({ record: { Id: LEAD_ID, Notes__c: 'n' }, tasksFail: true });
    deps.fetchRecordAddress.mockRejectedValueOnce(new Error('network'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rec = await loadAiCallRecord('U1', 'Lead', LEAD_ID, deps);
    expect(rec?.notes).toBe('Notes: n');
    expect(rec?.address).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed describe throws and is not cached', async () => {
    const { deps } = fakeDeps({ describeStatus: 500 });
    await expect(loadAiCallRecord('U1', 'Lead', LEAD_ID, deps)).rejects.toThrow(/describe/i);
    await expect(loadAiCallRecord('U1', 'Lead', LEAD_ID, deps)).rejects.toThrow(/describe/i);
    expect(deps.sfFetch).toHaveBeenCalledTimes(2);
  });

  it('caches the describe per user and object for 10 minutes', async () => {
    let t = 1_000_000;
    const { deps } = fakeDeps();
    const withClock = { ...deps, now: () => t };
    await loadAiCallRecord('U1', 'Lead', LEAD_ID, withClock);
    await loadAiCallRecord('U1', 'Lead', LEAD_ID, withClock);
    expect(deps.sfFetch).toHaveBeenCalledTimes(1);
    await loadAiCallRecord('U2', 'Lead', LEAD_ID, withClock);
    await loadAiCallRecord('U1', 'Contact', LEAD_ID, withClock);
    expect(deps.sfFetch).toHaveBeenCalledTimes(3);
    t += 10 * 60 * 1000 + 1;
    await loadAiCallRecord('U1', 'Lead', LEAD_ID, withClock);
    expect(deps.sfFetch).toHaveBeenCalledTimes(4);
    expect(deps.sfFetch).toHaveBeenLastCalledWith('U1', '/sobjects/Lead/describe');
  });
});
