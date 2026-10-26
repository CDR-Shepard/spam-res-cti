/**
 * Parsers for the two Salesforce REST list-view responses the power dialer
 * pulls (via the rep's own token, sfFetch):
 *   GET /sobjects/{obj}/listviews                 → the rep's list views
 *   GET /sobjects/{obj}/listviews/{id}/results    → the records in one list view
 *
 * This is how the softphone gets "the list" without relying on a Salesforce
 * list-view button — the Lightning Console doesn't hand a custom button the
 * row selection, but the CTI can query the list view directly.
 */

export interface ListViewSummary {
  id: string;
  label: string;
  developerName: string;
}

/** Parse `/sobjects/{obj}/listviews` → the rep's list views, sorted by label. */
export function parseListViews(json: unknown): ListViewSummary[] {
  const lvs = (json as { listviews?: unknown[] } | null)?.listviews;
  if (!Array.isArray(lvs)) return [];
  return lvs
    .map((lv) => lv as { id?: string; label?: string; developerName?: string })
    .filter((lv): lv is { id: string; label: string; developerName?: string } =>
      typeof lv.id === 'string' && typeof lv.label === 'string',
    )
    .map((lv) => ({ id: lv.id, label: lv.label, developerName: lv.developerName ?? '' }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Parse `/sobjects/{obj}/listviews/{id}/results` → the record ids. Salesforce
 * always includes an `Id` column in the results (even when it isn't a displayed
 * column); each record is `{ columns: [{ fieldNameOrPath, value }] }`.
 */
export function parseListViewResultIds(json: unknown): string[] {
  const records = (json as { records?: unknown[] } | null)?.records;
  if (!Array.isArray(records)) return [];
  const ids: string[] = [];
  for (const rec of records) {
    const cols = (rec as { columns?: Array<{ fieldNameOrPath?: string; value?: unknown }> } | null)?.columns;
    if (!Array.isArray(cols)) continue;
    const idCol = cols.find((c) => c.fieldNameOrPath === 'Id');
    if (idCol && typeof idCol.value === 'string' && idCol.value) ids.push(idCol.value);
  }
  return ids;
}

/** The most records one list-view run reads (5 query pages). */
export const LIST_FETCH_CAP = 10_000;

/** The old read, kept as the fallback: /results won't return more per call. */
const RESULTS_FALLBACK_LIMIT = '2000';

/** `sfFetch` bound to one rep (paths are relative to /services/data/vXX). */
export type SfFetcher = (
  path: string,
  init?: { query?: Record<string, string> },
) => Promise<{ status: number; json: unknown }>;

const ok = (status: number): boolean => status >= 200 && status < 300;

/**
 * A list view's own SOQL (from its describe) selecting Id only: the view's
 * FROM, USING SCOPE, WHERE and ORDER BY are kept exactly, so the ids come back
 * in the list's own order. Null when it doesn't read as SELECT … FROM ….
 */
export function listViewIdQuery(soql: string): string | null {
  const m = /^\s*SELECT\s+[\s\S]+?\s(FROM\s[\s\S]*)$/i.exec(soql);
  return m ? `SELECT Id ${m[1]}` : null;
}

/** `/services/data/v62.0/query/01g…-2000` → `/query/01g…-2000` (sfFetch adds the prefix). */
function queryMorePath(nextRecordsUrl: string): string {
  const m = /^\/services\/data\/v[\d.]+(\/query\/.+)$/.exec(nextRecordsUrl);
  if (!m) throw new Error(`unexpected nextRecordsUrl: ${nextRecordsUrl}`);
  return m[1]!;
}

/** A list view's records, and whether each rep sees their own (`listViewIsPerRep`). */
export interface ListViewRecords {
  ids: string[];
  perRep: boolean;
}

/**
 * Whether a list view shows each rep their OWN records, from its describe's
 * `scope`. `everything` and `entity` (one queue's or one owner's records, the
 * same for everyone — LA Hunt Queue is `entity`) are shared: reps working one
 * share its place. Anything else (`mine` "My Leads", the Task view "Today",
 * `team`, `mru`, `delegated`, …) differs per rep, so each keeps their own
 * place — one rep's last record is never in another's list (review of
 * eacba2c0, N1). Unknown (no describe) counts as per rep: a rep's own place
 * can never steer someone else's.
 */
export function listViewIsPerRep(scope: unknown): boolean {
  return scope !== 'everything' && scope !== 'entity';
}

async function idsThroughQuery(fetcher: SfFetcher, soql: unknown, cap: number): Promise<string[]> {
  const q = typeof soql === 'string' ? listViewIdQuery(soql) : null;
  if (!q) throw new Error('describe returned no usable query');
  const ids: string[] = [];
  let res = await fetcher('/query', { query: { q } });
  for (;;) {
    if (!ok(res.status)) throw new Error(`query answered ${res.status}`);
    const body = res.json as { records?: Array<{ Id?: unknown } | null>; done?: unknown; nextRecordsUrl?: unknown } | null;
    for (const r of body?.records ?? []) {
      if (typeof r?.Id === 'string' && r.Id) ids.push(r.Id);
      if (ids.length >= cap) return ids;
    }
    if (body?.done !== false || typeof body.nextRecordsUrl !== 'string') return ids;
    res = await fetcher(queryMorePath(body.nextRecordsUrl));
  }
}

/**
 * Every record id in a list view, in its own order, up to `cap`, and whether
 * the view is per rep.
 *
 * 2026-10-26 (Matt): this used to be `/results?limit=200`, so a list longer
 * than 200 never got past its first 200 — each later run re-dialed them. And
 * /results can't page past offset 2000. So the list is read through its own
 * SOQL instead (from the view's describe), run as the rep (their sharing,
 * their "mine" scope), paged with nextRecordsUrl. Should that path fail — a
 * view the describe can't give a query for, a query Salesforce refuses — it
 * falls back to /results with its 2000 maximum, which still beats the old 200.
 * Throws only when that fails too.
 */
export async function fetchListViewRecordIds(
  fetcher: SfFetcher,
  object: string,
  listViewId: string,
  cap: number = LIST_FETCH_CAP,
): Promise<ListViewRecords> {
  // The describe's scope, once it answers; undefined (→ per rep) until then.
  let scope: unknown;
  try {
    const described = await fetcher(`/sobjects/${object}/listviews/${listViewId}/describe`);
    if (!ok(described.status)) throw new Error(`describe answered ${described.status}`);
    const body = described.json as { query?: unknown; scope?: unknown } | null;
    scope = body?.scope;
    return { ids: await idsThroughQuery(fetcher, body?.query, cap), perRep: listViewIsPerRep(scope) };
  } catch (err) {
    console.warn(
      `[listviews] reading list "${listViewId}" through its query failed — falling back to its first ${RESULTS_FALLBACK_LIMIT}: ${(err as Error).message}`,
    );
  }
  const res = await fetcher(`/sobjects/${object}/listviews/${listViewId}/results`, { query: { limit: RESULTS_FALLBACK_LIMIT } });
  if (!ok(res.status)) throw new Error(`list-view results fetch answered ${res.status}`);
  return { ids: parseListViewResultIds(res.json).slice(0, cap), perRep: listViewIsPerRep(scope) };
}
