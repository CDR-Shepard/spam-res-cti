import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDirectorySnapshot,
  CursorPagingError,
  MAX_DIRECTORY_ENTRIES,
  pickActingUsers,
  startDirectoryLoop,
  sweepRawEntries,
  type SweepDeps,
} from './directory-build.js';
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

  it('skips Deals (with exactly one warn) when the Deal__c describe returns 404, but still sweeps Leads and Opps', async () => {
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

  it('skips Deals (with exactly one warn) when the Deal__c describe returns 403 — an unreadable object never kills the whole sweep', async () => {
    // A permanently unreadable Deal__c (the acting admin's profile has no
    // object permission) is the same class of signal as a 404: it will not
    // fix itself on the next tick, and it must not stop Leads/Opps from
    // publishing every 30 minutes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      const isFirstPage = !q.includes('Id >');
      if (/FROM Lead/.test(q)) return isFirstPage ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : [];
      if (/FROM OpportunityContactRole/.test(q)) {
        return isFirstPage
          ? [{ Id: 'R1', Opportunity: { Name: 'Big Deal', Account: {} }, Contact: { Phone: '6195550300', MobilePhone: null } }]
          : [];
      }
      if (/FROM Deal__c/.test(q)) throw new Error('should not query Deal__c after a 403 describe');
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 403, json: null })) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries.filter((e) => e.stage === 'deal')).toHaveLength(0);
    expect(entries.filter((e) => e.stage === 'lead')).toHaveLength(1);
    expect(entries.filter((e) => e.stage === 'opp')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips Deals (with exactly one warn) when the Deal__c query itself fails — Leads and Opps still publish', async () => {
    // e.g. INVALID_FIELD on a phone field the describe advertised but the
    // acting user cannot read. Deal__c support must never break the baseline.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      const isFirstPage = !q.includes('Id >');
      if (/FROM Lead/.test(q)) return isFirstPage ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : [];
      if (/FROM OpportunityContactRole/.test(q)) {
        return isFirstPage
          ? [{ Id: 'R1', Opportunity: { Name: 'Big Deal', Account: {} }, Contact: { Phone: '6195550300', MobilePhone: null } }]
          : [];
      }
      if (/FROM Deal__c/.test(q)) throw new Error("INVALID_FIELD: No such column 'Phone__c' on entity 'Deal__c'");
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async (_u: string, path: string) =>
      (path === '/sobjects/Deal__c/describe'
        ? { status: 200, json: { fields: [{ name: 'Phone__c', type: 'phone' }] } }
        : { status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    const entries = await sweepRawEntries({ soqlQuery, sfFetch }, 'U1');

    expect(entries.filter((e) => e.stage === 'deal')).toHaveLength(0);
    expect(entries.filter((e) => e.stage === 'lead')).toHaveLength(1);
    expect(entries.filter((e) => e.stage === 'opp')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT swallow a Deal-side CURSOR fault as "no Deals" — a half-swept object must fail the whole sweep', async () => {
    // The catch above deliberately turns a Deal QUERY failure into "skip
    // Deals". A paging fault is a different animal: the Deal rows exist and
    // some of them were read, so swallowing it would publish a directory
    // missing an unknown share of Deal-stage labels AS A NEW VERSION and
    // prune the good one — the exact partial publish the design forbids.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      const isFirstPage = !q.includes('Id >');
      if (/FROM Lead/.test(q)) return isFirstPage ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : [];
      // A Deal__c cursor that never advances: every page comes back with the
      // same last Id.
      if (/FROM Deal__c/.test(q)) return [{ Id: 'D1', Name: '123 Main St', Phone__c: '6195550400' }];
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async (_u: string, path: string) =>
      (path === '/sobjects/Deal__c/describe'
        ? { status: 200, json: { fields: [{ name: 'Phone__c', type: 'phone' }] } }
        : { status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    await expect(sweepRawEntries({ soqlQuery, sfFetch }, 'U1')).rejects.toBeInstanceOf(CursorPagingError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('publishes nothing at all when a Deal-side cursor fault aborts the sweep', async () => {
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      const isFirstPage = !q.includes('Id >');
      if (/FROM Lead/.test(q)) return isFirstPage ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : [];
      if (/FROM Deal__c/.test(q)) return [{ Id: 'D1', Name: '123 Main St', Phone__c: '6195550400' }];
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async (_u: string, path: string) =>
      (path === '/sobjects/Deal__c/describe'
        ? { status: 200, json: { fields: [{ name: 'Phone__c', type: 'phone' }] } }
        : { status: 404, json: null })) as unknown as SweepDeps['sfFetch'];
    const db = fakeDb({ latestVersion: { version: 4, contentHash: 'old', entryCount: 9 } });

    await expect(
      buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, { soqlQuery, sfFetch }),
    ).rejects.toBeInstanceOf(CursorPagingError);
    expect(db._txInserts).toEqual([]);
    expect(db._deletes).toEqual([]);
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

  it('propagates a transient Deal__c describe failure (500) instead of skipping Deals — only a 404 is tolerated', async () => {
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      // A correct implementation aborts before ever issuing this query.
      if (/FROM Deal__c/.test(q)) throw new Error('should not query Deal__c after a transient describe failure');
      return [];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async (_u: string, path: string) =>
      (path === '/sobjects/Deal__c/describe' ? { status: 500, json: null } : { status: 404, json: null }),
    ) as unknown as SweepDeps['sfFetch'];

    await expect(sweepRawEntries({ soqlQuery, sfFetch }, 'U1')).rejects.toThrow(/describe failed \(500\)/);
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

  it('rejects instead of restarting from page one when a page\'s last row has no Id', async () => {
    // Without a progress guard, an Id-less last row leaves the cursor at null
    // and the loop re-issues the first page forever — an unattended worker
    // spinning against prod. Failing loudly lets the tick's catch warn.
    const soqlQuery = vi.fn(async (_u: string, q: string) =>
      (/FROM Lead/.test(q) ? [{ Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : []),
    ) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    await expect(sweepRawEntries({ soqlQuery, sfFetch }, 'U1')).rejects.toThrow(/no Id/i);
  });

  it('rejects when the Id cursor fails to advance strictly between pages', async () => {
    const soqlQuery = vi.fn(async (_u: string, q: string) =>
      (/FROM Lead/.test(q) ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }] : []),
    ) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    await expect(sweepRawEntries({ soqlQuery, sfFetch }, 'U1')).rejects.toThrow(/did not advance/i);
    // The guard fires on the second page, not after an unbounded spin.
    expect((soqlQuery as any).mock.calls.length).toBeLessThan(5);
  });

  it('rejects once paging passes the hard max-page bound', async () => {
    // A cursor that advances forever (a pathological org, or a query whose
    // filter never narrows) is bounded rather than left to run until the
    // process dies.
    let n = 0;
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      if (!/FROM Lead/.test(q)) return [];
      n += 1;
      return [{ Id: `L${String(n).padStart(8, '0')}`, Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }];
    }) as unknown as SweepDeps['soqlQuery'];
    const sfFetch = vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'];

    await expect(sweepRawEntries({ soqlQuery, sfFetch }, 'U1')).rejects.toThrow(/max page/i);
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
    // The stored hash is exactly the hash of the merged fixture — the value a
    // later tick compares against to decide "nothing changed, don't bump".
    const expectedHash = contentHash(mergeDirectory([{ e164: '+16195550100', name: 'Jane Doe', stage: 'lead' }]));
    expect(db._txInserts[1]).toMatchObject({
      table: schema.callerDirectoryVersions,
      values: { orgId: 'O1', version: 1, entryCount: 1, contentHash: expectedHash },
    });
    // No prior version to prune.
    expect(db._deletes).toHaveLength(0);
  });

  it('refuses to publish an empty sweep over an existing version — one anomalous sweep never blanks an org\'s caller ID', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fakeDb({ latestVersion: { version: 4, contentHash: 'stale-hash', entryCount: 12 } });

    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, fakeSf());

    expect(out).toEqual({ version: 4, entryCount: 12, changed: false });
    expect(db._txInserts).toHaveLength(0);
    expect(db._deletes).toHaveLength(0);
    expect(warn.mock.calls.some((c) => /empty/i.test(String(c[0])))).toBe(true);
  });

  it('publishes an empty first-ever build — there is no directory to blank', async () => {
    const db = fakeDb({ latestVersion: null });

    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, fakeSf());

    expect(out).toEqual({ version: 1, entryCount: 0, changed: true });
    expect(db._txInserts).toHaveLength(1);
    expect(db._txInserts[0]).toMatchObject({
      table: schema.callerDirectoryVersions,
      values: { orgId: 'O1', version: 1, entryCount: 0 },
    });
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

  it('aborts the snapshot — no writes at all — when the Deal__c describe fails transiently (not a 404)', async () => {
    const db = fakeDb({ latestVersion: null });
    const sf: SweepDeps = {
      soqlQuery: vi.fn(async (_u: string, q: string) =>
        (/FROM Lead/.test(q) && !q.includes('Id >')
          ? [{ Id: 'L1', Name: 'Jane Doe', Phone: '6195550100', MobilePhone: null }]
          : [])) as unknown as SweepDeps['soqlQuery'],
      sfFetch: vi.fn(async (_u: string, path: string) =>
        (path === '/sobjects/Deal__c/describe' ? { status: 503, json: null } : { status: 404, json: null }),
      ) as unknown as SweepDeps['sfFetch'],
    };

    await expect(buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, sf)).rejects.toThrow(/describe failed \(503\)/);
    // Nothing published — not even the Lead sweep's entries, which is
    // correct: a transient Deal__c failure must abort the WHOLE snapshot,
    // not publish a partial one missing Deals.
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

describe('the Call Directory entry ceiling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  /** `count` swept Leads with strictly ascending, valid US numbers, served in
   *  PAGE_SIZE batches the way pageByIdCursor asks for them. */
  function leadSweepOf(count: number): SweepDeps {
    const leads = Array.from({ length: count }, (_, i) => ({
      Id: `L${String(i).padStart(6, '0')}`,
      Name: `Lead ${i}`,
      // 619-2xx-xxxx ascending in i, so the "lowest-numbered prefix" the cap
      // keeps is exactly the first MAX_DIRECTORY_ENTRIES of these.
      Phone: `6192${String(i).padStart(6, '0')}`,
      MobilePhone: null,
    }));
    let served = 0;
    const soqlQuery = vi.fn(async (_u: string, q: string) => {
      if (!/FROM Lead/.test(q)) return [];
      const batch = leads.slice(served, served + 2000);
      served += batch.length;
      return batch;
    }) as unknown as SweepDeps['soqlQuery'];
    return { soqlQuery, sfFetch: vi.fn(async () => ({ status: 404, json: null })) as unknown as SweepDeps['sfFetch'] };
  }

  it('publishes at most MAX_DIRECTORY_ENTRIES rows, keeping the ascending-lowest prefix, and warns about the tail it dropped', async () => {
    // Past this ceiling the phone extension is jetsammed mid-stream and NO
    // label ever appears — a total, silent failure. So the server publishes
    // what the phone can hold rather than what the CRM happens to contain.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const over = 5;
    const db = fakeDb({ latestVersion: null });

    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, leadSweepOf(MAX_DIRECTORY_ENTRIES + over));

    expect(out).toEqual({ version: 1, entryCount: MAX_DIRECTORY_ENTRIES, changed: true });
    const published = db._txInserts
      .filter((i: { table: unknown }) => i.table === schema.callerDirectoryEntries)
      .flatMap((i: { values: unknown }) => i.values as Array<{ e164: string }>);
    expect(published).toHaveLength(MAX_DIRECTORY_ENTRIES);
    // The prefix kept is the LOWEST numbers, still ascending — the order the
    // feed pages in and CallKit requires.
    expect(published[0]!.e164).toBe('+16192000000');
    expect(published[MAX_DIRECTORY_ENTRIES - 1]!.e164).toBe(`+16192${String(MAX_DIRECTORY_ENTRIES - 1).padStart(6, '0')}`);
    // …and the version row agrees with what was actually written.
    expect(db._txInserts[db._txInserts.length - 1]).toMatchObject({
      table: schema.callerDirectoryVersions,
      values: { orgId: 'O1', version: 1, entryCount: MAX_DIRECTORY_ENTRIES },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('memory ceiling'),
      expect.objectContaining({ orgId: 'O1', published: MAX_DIRECTORY_ENTRIES, dropped: over }),
    );
  });

  it('hashes what it publishes, so churn ABOVE the ceiling never bumps the version', async () => {
    // The hash has to be taken after the cap: otherwise every Lead added past
    // the ceiling would republish a byte-identical directory, bumping the
    // version, pruning the previous one, and making every phone re-download
    // the whole thing for nothing.
    const first = fakeDb({ latestVersion: null });
    await buildDirectorySnapshot(first, { orgId: 'O1', userId: 'U1' }, leadSweepOf(MAX_DIRECTORY_ENTRIES + 5));
    const versionRow = first._txInserts[first._txInserts.length - 1] as { values: { contentHash: string } };

    const second = fakeDb({
      latestVersion: { version: 1, contentHash: versionRow.values.contentHash, entryCount: MAX_DIRECTORY_ENTRIES },
    });
    const out = await buildDirectorySnapshot(second, { orgId: 'O1', userId: 'U1' }, leadSweepOf(MAX_DIRECTORY_ENTRIES + 50));

    expect(out).toEqual({ version: 1, entryCount: MAX_DIRECTORY_ENTRIES, changed: false });
    expect(second._txInserts).toEqual([]);
  });

  it('leaves a directory under the ceiling completely untouched', async () => {
    const db = fakeDb({ latestVersion: null });
    const out = await buildDirectorySnapshot(db, { orgId: 'O1', userId: 'U1' }, leadSweepOf(10));
    expect(out).toEqual({ version: 1, entryCount: 10, changed: true });
  });
});

describe('pickActingUsers', () => {
  it('picks the org\'s connected admin user', () => {
    const rows = [
      { orgId: 'O1', userId: 'U1', isAdmin: true },
      { orgId: 'O1', userId: 'U2', isAdmin: false },
      { orgId: 'O2', userId: 'U3', isAdmin: false },
    ];

    expect(pickActingUsers(rows)).toEqual([{ orgId: 'O1', userId: 'U1' }]);
  });

  it('yields no acting user for an org with no connected admin — no non-admin fallback', () => {
    // Per the brief: "resolves the org's connected admin user". A rep whose
    // sharing rules hide most records must never become the source of truth
    // for the whole org's caller-ID directory.
    const rows = [
      { orgId: 'O1', userId: 'U2', isAdmin: false },
      { orgId: 'O2', userId: 'U3', isAdmin: true },
    ];

    expect(pickActingUsers(rows)).toEqual([{ orgId: 'O2', userId: 'U3' }]);
  });

  it('is deterministic when an org has more than one connected admin, regardless of row order', () => {
    const rowsAscending = [
      { orgId: 'O1', userId: 'U1', isAdmin: true },
      { orgId: 'O1', userId: 'U2', isAdmin: true },
    ];
    const rowsDescending = [...rowsAscending].reverse();

    const pickedAscending = pickActingUsers(rowsAscending);
    const pickedDescending = pickActingUsers(rowsDescending);

    expect(pickedAscending).toEqual([{ orgId: 'O1', userId: 'U1' }]);
    expect(pickedDescending).toEqual(pickedAscending);
  });
});

/** A db whose only exercised surface is `fetchActingUserCandidates`' join
 *  chain. Every candidate here is a non-admin, so no snapshot (and therefore
 *  no Salesforce call) is ever attempted from these tests. */
function fakeCandidateDb(rows: Array<{ orgId: string; userId: string; isAdmin: boolean }>) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ innerJoin: () => ({ where: async () => rows }) }),
      }),
    }),
  } as any;
}

describe('startDirectoryLoop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs an immediate kickoff tick on start instead of waiting a whole interval', async () => {
    const dbFactory = vi.fn(() => fakeCandidateDb([]));
    const timer = startDirectoryLoop(1_800_000, dbFactory);
    try {
      expect(dbFactory).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(timer);
    }
  });

  it('clears the single-flight flag even when the db factory throws synchronously', async () => {
    // Sync work outside the async tick body would escape the .catch/.finally
    // chain, leaving `running` stuck at true — the worker silently dead for
    // the life of the process. Invoking twice proves the flag cleared.
    const dbFactory = vi.fn(() => { throw new Error('db unavailable'); }) as unknown as () => any;
    const timer = startDirectoryLoop(60_000, dbFactory);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(dbFactory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(dbFactory).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(timer);
    }
  });

  it('warns for an org that has connected users but no connected admin, instead of skipping it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fakeCandidateDb([
      { orgId: 'O1', userId: 'U2', isAdmin: false },
      { orgId: 'O1', userId: 'U3', isAdmin: false },
    ]);
    const timer = startDirectoryLoop(60_000, () => db);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/no connected admin/i);
    } finally {
      clearInterval(timer);
    }
  });
});
