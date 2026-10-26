import { describe, expect, it } from 'vitest';
import { fetchListViewRecordIds, listViewIdQuery, parseListViews, parseListViewResultIds, type SfFetcher } from './listviews.js';

describe('parseListViews', () => {
  it('extracts id/label/developerName and sorts by label', () => {
    const json = {
      listviews: [
        { id: '00B2', label: 'Zeta Opps', developerName: 'Zeta_Opps' },
        { id: '00B1', label: 'Alpha Opps', developerName: 'Alpha_Opps' },
      ],
      done: true,
    };
    expect(parseListViews(json)).toEqual([
      { id: '00B1', label: 'Alpha Opps', developerName: 'Alpha_Opps' },
      { id: '00B2', label: 'Zeta Opps', developerName: 'Zeta_Opps' },
    ]);
  });

  it('is empty/robust for missing or malformed input', () => {
    expect(parseListViews(null)).toEqual([]);
    expect(parseListViews({})).toEqual([]);
    expect(parseListViews({ listviews: [{ id: '00B1' }] })).toEqual([]); // no label → dropped
  });
});

describe('parseListViewResultIds', () => {
  it('pulls the Id column value from each record (real results shape)', () => {
    const json = {
      records: [
        { columns: [{ fieldNameOrPath: 'Name', value: 'A' }, { fieldNameOrPath: 'Id', value: '006US00000DyV4hYAF' }] },
        { columns: [{ fieldNameOrPath: 'Name', value: 'B' }, { fieldNameOrPath: 'Id', value: '006US00000Zzzz1YAF' }] },
      ],
      done: true,
    };
    expect(parseListViewResultIds(json)).toEqual(['006US00000DyV4hYAF', '006US00000Zzzz1YAF']);
  });

  it('skips records with no Id column and is robust for malformed input', () => {
    expect(parseListViewResultIds(null)).toEqual([]);
    expect(parseListViewResultIds({ records: [{ columns: [{ fieldNameOrPath: 'Name', value: 'A' }] }] })).toEqual([]);
    expect(parseListViewResultIds({ records: [{}] })).toEqual([]);
  });
});

// 2026-10-26, Matt: the dialer read list views through /results?limit=200,
// so a 5,646-lead "LA Hunt Queue" only ever showed its oldest 200 — every
// run after the first re-dialed them ("190 called in the last 3 h · dialing
// 10"). /results can't page past offset 2000 either, so the list is read
// through its own SOQL (the view's describe), Id only, page by page.
describe('listViewIdQuery', () => {
  it('keeps the view\'s FROM, scope, filter and order; selects Id only', () => {
    expect(listViewIdQuery(
      "SELECT CreatedDate, Name, toLabel(Status), Owner.NameOrAlias, Id FROM Lead WHERE OwnerId = '00G8X000006aRkG' AND IsConverted = false ORDER BY CreatedDate ASC NULLS FIRST, Id ASC NULLS FIRST",
    )).toBe("SELECT Id FROM Lead WHERE OwnerId = '00G8X000006aRkG' AND IsConverted = false ORDER BY CreatedDate ASC NULLS FIRST, Id ASC NULLS FIRST");
    expect(listViewIdQuery("SELECT Subject, Who.Name, Id FROM Task USING SCOPE mine WHERE ActivityDate = TODAY ORDER BY Id ASC NULLS FIRST"))
      .toBe('SELECT Id FROM Task USING SCOPE mine WHERE ActivityDate = TODAY ORDER BY Id ASC NULLS FIRST');
  });

  it('is case-insensitive on the keywords', () => {
    expect(listViewIdQuery('select Name, Id from Lead order by Id')).toBe('SELECT Id from Lead order by Id');
  });

  it('refuses anything it cannot read as SELECT … FROM …', () => {
    expect(listViewIdQuery('')).toBeNull();
    expect(listViewIdQuery('Lead WHERE x = 1')).toBeNull();
    expect(listViewIdQuery('SELECT Name, Id')).toBeNull();
  });
});

describe('fetchListViewRecordIds', () => {
  const DESCRIBE = '/sobjects/Lead/listviews/00B000000000001/describe';
  const VIEW_SOQL = "SELECT Name, Id FROM Lead WHERE OwnerId = '00G' ORDER BY CreatedDate ASC NULLS FIRST, Id ASC NULLS FIRST";
  const ID_SOQL = "SELECT Id FROM Lead WHERE OwnerId = '00G' ORDER BY CreatedDate ASC NULLS FIRST, Id ASC NULLS FIRST";
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `00Q${String(from + i).padStart(12, '0')}`);
  const page = (list: string[], next?: string) => ({
    status: 200,
    json: { done: !next, records: list.map((Id) => ({ attributes: { type: 'Lead' }, Id })), ...(next ? { nextRecordsUrl: next } : {}) },
  });

  /** A fake Salesforce: the describe, then the query and its nextRecordsUrl pages. */
  function fakeSf(pages: Array<{ status: number; json: unknown }>, describe: { status: number; json: unknown } = { status: 200, json: { query: VIEW_SOQL } }) {
    const calls: Array<{ path: string; query?: Record<string, string> }> = [];
    let pageIdx = 0;
    const fetcher: SfFetcher = async (path, init) => {
      calls.push({ path, query: init?.query });
      if (path === DESCRIBE) return describe;
      if (path === '/query' || path.startsWith('/query/')) return pages[pageIdx++] ?? { status: 500, json: [] };
      return { status: 404, json: [] };
    };
    return { fetcher, calls };
  }

  it('reads every record through the view\'s own query, following nextRecordsUrl, in list order', async () => {
    const { fetcher, calls } = fakeSf([
      page(ids(0, 2000), '/services/data/v62.0/query/01gXX-2000'),
      page(ids(2000, 2000), '/services/data/v62.0/query/01gXX-4000'),
      page(ids(4000, 1646)),
    ]);
    const got = await fetchListViewRecordIds(fetcher, 'Lead', '00B000000000001');
    expect(got.length).toBe(5646);
    expect(got[0]).toBe(ids(0, 1)[0]);
    expect(got[5645]).toBe(ids(5645, 1)[0]);
    expect(calls.map((c) => c.path)).toEqual([DESCRIBE, '/query', '/query/01gXX-2000', '/query/01gXX-4000']);
    expect(calls[1]!.query).toEqual({ q: ID_SOQL });
  });

  it('stops at the cap, keeping the list\'s first records', async () => {
    const { fetcher, calls } = fakeSf([
      page(ids(0, 2000), '/services/data/v62.0/query/01gXX-2000'),
      page(ids(2000, 2000), '/services/data/v62.0/query/01gXX-4000'),
    ]);
    const got = await fetchListViewRecordIds(fetcher, 'Lead', '00B000000000001', 3000);
    expect(got).toEqual(ids(0, 3000));
    expect(calls).toHaveLength(3); // describe + 2 pages; the 3rd page is never asked for
  });

  it('falls back to the results endpoint (up to 2000) when the view\'s query cannot be used', async () => {
    const results = { columns: [], records: ids(0, 3).map((Id) => ({ columns: [{ fieldNameOrPath: 'Id', value: Id }] })) };
    for (const describe of [
      { status: 403, json: [{ errorCode: 'INSUFFICIENT_ACCESS' }] },
      { status: 200, json: { query: 'not soql' } },
      { status: 200, json: {} },
    ]) {
      const calls: string[] = [];
      const fetcher: SfFetcher = async (path, init) => {
        calls.push(`${path}${init?.query ? `?${new URLSearchParams(init.query)}` : ''}`);
        if (path.endsWith('/describe')) return describe;
        if (path.endsWith('/results')) return { status: 200, json: results };
        return { status: 500, json: [] };
      };
      expect(await fetchListViewRecordIds(fetcher, 'Lead', '00B000000000001')).toEqual(ids(0, 3));
      expect(calls.at(-1)).toBe('/sobjects/Lead/listviews/00B000000000001/results?limit=2000');
    }
  });

  it('a query page that fails also falls back to the results endpoint', async () => {
    const results = { records: ids(0, 2).map((Id) => ({ columns: [{ fieldNameOrPath: 'Id', value: Id }] })) };
    const fetcher: SfFetcher = async (path) => {
      if (path.endsWith('/describe')) return { status: 200, json: { query: VIEW_SOQL } };
      if (path === '/query') return page(ids(0, 2000), '/services/data/v62.0/query/01gXX-2000');
      if (path.endsWith('/results')) return { status: 200, json: results };
      return { status: 500, json: [{ errorCode: 'QUERY_TIMEOUT' }] };
    };
    expect(await fetchListViewRecordIds(fetcher, 'Lead', '00B000000000001')).toEqual(ids(0, 2));
  });

  it('throws when the results endpoint fails too (the route answers 502)', async () => {
    const fetcher: SfFetcher = async () => ({ status: 500, json: [] });
    await expect(fetchListViewRecordIds(fetcher, 'Lead', '00B000000000001')).rejects.toThrow(/500/);
  });
});

