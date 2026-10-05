import { describe, expect, it } from 'vitest';
import type { SalesforceClient } from '@cti/salesforce';
import { leadId } from '../test/outreach-fixtures.js';
import { activitySoql, recordsWithNewActivity } from './activity-check.js';

/** Distinct 15-character cores (leadId(1) and leadId(2) share theirs). */
const A = leadId(1_000);
const B = leadId(2_000);
const SINCE = new Date('2026-10-05T12:00:00.250Z');

function client(rows: Record<'Task' | 'Event', Array<Record<string, unknown>>>) {
  const soql: string[] = [];
  const c = {
    async queryAll(q: string) {
      soql.push(q);
      return / FROM Task /.test(q) ? rows.Task : rows.Event;
    },
  } as unknown as SalesforceClient;
  return { c, soql };
}

describe('activitySoql', () => {
  it('asks for Tasks or Events on the records as Who or What, modified after the cutoff in whole seconds', () => {
    expect(activitySoql('Task', [A, B], SINCE)).toBe(
      `SELECT Id, WhoId, WhatId, LastModifiedDate FROM Task WHERE (WhoId IN ('${A}','${B}') OR WhatId IN ('${A}','${B}')) AND LastModifiedDate > 2026-10-05T12:00:00Z`,
    );
    expect(activitySoql('Event', [A], SINCE)).toContain('FROM Event');
  });
  it('never puts a malformed id into the SOQL', () => {
    expect(activitySoql('Task', [A, "x' OR Id != '"], SINCE)).not.toContain('OR Id');
    expect(() => activitySoql('Task', ['bad'], SINCE)).toThrow();
  });
});

describe('recordsWithNewActivity', () => {
  it('finds a Task newer than the record\'s own research and an Event on another record, matched on the 15-character core', async () => {
    const { c, soql } = client({
      Task: [{ Id: '00T000000000001AAA', WhoId: A, WhatId: null, LastModifiedDate: '2026-10-05T12:00:01.000+0000' }],
      Event: [{ Id: '00U000000000001AAA', WhoId: null, WhatId: B.slice(0, 15), LastModifiedDate: '2026-10-05T13:00:00.000+0000' }],
    });
    const found = await recordsWithNewActivity(c, [{ sfRecordId: A, since: SINCE }, { sfRecordId: B, since: SINCE }], new Set());
    expect([...found].sort()).toEqual([A, B]);
    expect(soql).toHaveLength(2);
  });

  it('ignores activity no newer than the research (the SOQL cutoff is rounded down) and the engine\'s own call Tasks', async () => {
    const { c } = client({
      Task: [
        { Id: '00T000000000001AAA', WhoId: A, LastModifiedDate: '2026-10-05T12:00:00.100+0000' },
        { Id: '00T000000000002AAA', WhoId: A, LastModifiedDate: '2026-10-05T18:00:00.000+0000' },
      ],
      Event: [],
    });
    expect(await recordsWithNewActivity(c, [{ sfRecordId: A, since: SINCE }], new Set(['00T000000000002']))).toEqual(new Set());
  });

  it('compares each record with its own research time', async () => {
    const { c } = client({ Task: [{ Id: '00T000000000003AAA', WhoId: B, LastModifiedDate: '2026-10-05T13:00:00.000+0000' }], Event: [] });
    const found = await recordsWithNewActivity(c, [{ sfRecordId: A, since: SINCE }, { sfRecordId: B, since: new Date('2026-10-05T14:00:00Z') }], new Set());
    expect(found).toEqual(new Set());
  });

  it('treats an unreadable date as news', async () => {
    const { c } = client({ Task: [{ Id: '00T000000000004AAA', WhoId: A, LastModifiedDate: 'garbage' }], Event: [] });
    expect(await recordsWithNewActivity(c, [{ sfRecordId: A, since: SINCE }], new Set())).toEqual(new Set([A]));
  });

  it('asks nothing for no valid ids, and lets a Salesforce error through', async () => {
    const { c, soql } = client({ Task: [], Event: [] });
    expect(await recordsWithNewActivity(c, [{ sfRecordId: 'bad', since: SINCE }], new Set())).toEqual(new Set());
    expect(soql).toEqual([]);
    const failing = { async queryAll() { throw new Error('INVALID_TYPE'); } } as unknown as SalesforceClient;
    await expect(recordsWithNewActivity(failing, [{ sfRecordId: A, since: SINCE }], new Set())).rejects.toThrow('INVALID_TYPE');
  });
});
