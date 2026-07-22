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
