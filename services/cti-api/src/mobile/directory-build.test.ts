import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDirectorySnapshot, sweepRawEntries, type SweepDeps } from './directory-build.js';
import { contentHash, mergeDirectory } from './directory-merge.js';
import { schema } from '../db/index.js';

// -----------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------

/** A `soqlQuery` fake that dispatches on the query text, mirroring the style
 *  used across this repo's worker tests (e.g. followup-worker.test.ts). */
function fakeSf(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    soqlQuery: vi.fn(async () => []) as unknown as SweepDeps['soqlQuery'],
    sfFetch: vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'],
    ...over,
  };
}

/** Fake db for `buildDirectorySnapshot`: records every insert made INSIDE
 *  `db.transaction(...)` separately from an outer (non-transactional) delete,
 *  so a test can assert the entries + version row landed in the SAME tx. */
function fakeDb(opts: { latestVersion?: { version: number; contentHash: string; entryCount: number } | null } = {}) {
  const txInserts: Array<{ table: unknown; values: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const latestVersion = opts.latestVersion ?? null;
  return {
    _txInserts: txInserts,
    _deletes: deletes,
    query: {
      callerDirectoryVersions: {
        findFirst: async () => latestVersion,
      },
    },
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      const tx = {
        insert(table: unknown) {
          return {
            values: (values: unknown) => {
              txInserts.push({ table, values });
              return Promise.resolve();
            },
          };
        },
      };
      return fn(tx);
    },
    delete(table: unknown) {
      return { where: async () => { deletes.push({ table }); } };
    },
  } as any;
}

describe('sweepRawEntries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('maps each object to the right stage/name: Lead -> lead, OpportunityContactRole -> opp, Deal__c -> deal', async () => {
    // Each branch returns its canned row only on the first (cursor-less) page
    // and an empty page after that — pageByIdCursor now pages until it sees
    // an empty page, so a static canned response has to "run out" or the
    // fake would loop forever.
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      const isFirstPage = !q.includes('Id >');
      if (/FROM Lead/.test(q)) return isFirstPage ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : [];
      if (/FROM OpportunityContactRole/.test(q)) {
        return isFirstPage ? [{
          Id: 'R1',
          Opportunity: { Name: 'Big Deal', Account: { Phone: '6195550200' } },
          Contact: { Phone: '6195550300', MobilePhone: null },
        }] : [];
      }
      if (/FROM Deal__c/.test(q)) return isFirstPage ? [{ Id: 'D1', Name: '123 Main St', Phone__c: '6195550400', Mobile__c: null }] : [];
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async (_u: string, path: string) => {
      if (path === '/sobjects/Deal__c/describe') {
        return {
          status: 200,
          json: { fields: [{ name: 'Phone__c', type: 'phone' }, { name: 'Mobile__c', type: 'phone' }, { name: 'Fax__c', type: 'text' }] },
        };
      }
      return { status: 404, json: null };
    }) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries).toHaveLength(4);
    expect(entries).toEqual(expect.arrayContaining([
      { e164: '+16195550100', name: 'Jane Doe', stage: 'lead' },
      { e164: '+16195550300', name: 'Big Deal', stage: 'opp' },
      { e164: '+16195550200', name: 'Big Deal', stage: 'opp' },
      { e164: '+16195550400', name: '123 Main St', stage: 'deal' },
    ]));
    // Deal__c query only selects the describe-discovered phone fields, not Fax__c.
    const dealCall = (soqlQuery as any).mock.calls.find((c: any[]) => /FROM Deal__c/.test(c[1]));
    expect(dealCall[1]).toContain('Phone__c');
    expect(dealCall[1]).toContain('Mobile__c');
    expect(dealCall[1]).not.toContain('Fax__c');
  });

  it('skips Deals (with exactly one warn) when the Deal__c describe fails, but still sweeps Leads and Opps', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      const isFirstPage = !q.includes('Id >');
      if (/FROM Lead/.test(q)) return isFirstPage ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : [];
      if (/FROM OpportunityContactRole/.test(q)) {
        return isFirstPage
          ? [{ Id: 'R1', Opportunity: { Name: 'Big Deal', Account: {} }, Contact: { Phone: '6195550300', MobilePhone: null } }]
          : [];
      }
      // A correct implementation never queries Deal__c once its describe fails.
      if (/FROM Deal__c/.test(q)) throw new Error('should not query Deal__c after a failed describe');
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries.filter((e) => e.stage === 'deal')).toHaveLength(0);
    expect(entries.filter((e) => e.stage === 'lead')).toHaveLength(1);
    expect(entries.filter((e) => e.stage === 'opp')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips Deals (with exactly one warn) when the describe succeeds but has no phone-type fields', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const soqlQuery = vi.fn(async () => []) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async (_u: string, path: string) =>
      (path === '/sobjects/Deal__c/describe'
        ? { status: 200, json: { fields: [{ name: 'Fax__c', type: 'text' }] } }
        : { status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops invalid phone numbers via normalize, keeping only the valid ones', async () => {
    const soqlQuery = vi.fn(async (_u: string, q: string) =>
      (/FROM Lead/.test(q) && !q.includes('Id >')
        ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '123', MobilePhone: '6195550100' }]
        : [])) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries).toEqual([{ e164: '+16195550100', name: 'Jane Doe', stage: 'lead' }]);
  });

  it('keeps paging past a short page — a page under PAGE_SIZE does not mean the sweep is done', async () => {
    // Regression test: Salesforce's REST batch size can come back smaller
    // than the SOQL LIMIT (done: false with a short `records` array) for
    // wide/relationship queries. A cursor loop that stops as soon as a page
    // is "short" would silently drop every record after that page.
    const page1 = [{ Id: 'L1', Name: 'Alice', Phone: '6195550001', MobilePhone: null }];
    const page2 = [{ Id: 'L2', Name: 'Bob', Phone: '6195550002', MobilePhone: null }];
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      if (!/FROM Lead/.test(q)) return [];
      if (!q.includes('Id >')) return page1;
      if (q.includes("Id > 'L1'")) return page2;
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries).toEqual([
      { e164: '+16195550001', name: 'Alice', stage: 'lead' },
      { e164: '+16195550002', name: 'Bob', stage: 'lead' },
    ]);
  });
});

describe('buildDirectorySnapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const oneLeadSf = () => fakeSf({
    soqlQuery: vi.fn(async (_u: string, q: string) =>
      (/FROM Lead/.test(q) && !q.includes('Id >')
        ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }]
        : [])) as unknown as SweepDeps['soqlQuery'],
  });

  it('publishes a new version atomically — entries + version row in the SAME transaction — when the hash changes', async () => {
    const db = fakeDb({ latestVersion: null });
    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, oneLeadSf());

    expect(out).toEqual({ version: 1, entryCount: 1, changed: true });
    expect(db._txInserts).toHaveLength(2);
    expect(db._txInserts[0]).toMatchObject({
      table: schema.callerDirectoryEntries,
      values: [{ orgId: 'O1', version: 1, e164: '+16195550100', label: 'Lead: Jane Doe', stage: 'lead' }],
    });
    expect(db._txInserts[1]).toMatchObject({
      table: schema.callerDirectoryVersions,
      values: { orgId: 'O1', version: 1, entryCount: 1 },
    });
    // No prior version to prune.
    expect(db._deletes).toHaveLength(0);
  });

  it('bumps the version and prunes entry rows older than the previous version when the hash changes', async () => {
    const db = fakeDb({ latestVersion: { version: 5, contentHash: 'stale-hash', entryCount: 9 } });
    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, oneLeadSf());

    expect(out).toEqual({ version: 6, entryCount: 1, changed: true });
    expect(db._txInserts[1]).toMatchObject({ values: { orgId: 'O1', version: 6, entryCount: 1 } });
    // Keep 2 versions (5 and 6): prune anything older than the previous (5).
    expect(db._deletes).toHaveLength(1);
    expect(db._deletes[0].table).toBe(schema.callerDirectoryEntries);
  });

  it('no-ops without touching the db when the content hash matches the latest published version', async () => {
    const merged = mergeDirectory([{ e164: '+16195550100', name: 'Jane Doe', stage: 'lead' }]);
    const db = fakeDb({ latestVersion: { version: 3, contentHash: contentHash(merged), entryCount: 1 } });
    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, oneLeadSf());

    expect(out).toEqual({ version: 3, entryCount: 1, changed: false });
    expect(db._txInserts).toHaveLength(0);
    expect(db._deletes).toHaveLength(0);
  });

  it('chunks large inserts to stay under the bind-parameter cap, still inside the same transaction', async () => {
    // Regression test: a single multi-row INSERT for an org-wide directory
    // can exceed Postgres's 65535-bind-parameter cap. 2500 rows (with 5
    // notNull columns each) forces multiple insert() calls; this also swept
    // in two real SOQL pages (2000 + 500) to double as paging coverage.
    const N = 2500;
    const allLeads = Array.from({ length: N }, (_, i) => ({
      Id: `L${String(i).padStart(4, '0')}`,
      Name: `Lead ${i}`,
      Phone: `619555${String(i).padStart(4, '0')}`,
      MobilePhone: null,
    }));
    let call = 0;
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      if (!/FROM Lead/.test(q)) return [];
      call += 1;
      if (call === 1) return allLeads.slice(0, 2000);
      if (call === 2) return allLeads.slice(2000);
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];
    const db = fakeDb({ latestVersion: null });

    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, { soqlQuery, sfFetch });

    expect(out).toEqual({ version: 1, entryCount: N, changed: true });
    const entryInserts = db._txInserts.filter((i: { table: unknown }) => i.table === schema.callerDirectoryEntries);
    expect(entryInserts.length).toBeGreaterThan(1);
    for (const insert of entryInserts) {
      expect((insert.values as unknown[]).length).toBeLessThanOrEqual(1000);
    }
    const totalRowsInserted = entryInserts.reduce((sum: number, i: { values: unknown }) => sum + (i.values as unknown[]).length, 0);
    expect(totalRowsInserted).toBe(N);
    // The version row is still the last write, in the same transaction as every entry chunk.
    expect(db._txInserts[db._txInserts.length - 1]).toMatchObject({
      table: schema.callerDirectoryVersions,
      values: { orgId: 'O1', version: 1, entryCount: N },
    });
  });
});
