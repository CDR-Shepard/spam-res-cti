/**
 * Parser for `GET /sobjects/{obj}/listviews`, copied from
 * services/cti-api/src/salesforce/listviews.ts (`parseListViews`).
 */

export interface ListViewSummary {
  id: string;
  label: string;
  developerName: string;
}

/** Parse `/sobjects/{obj}/listviews` → list views, sorted by label. */
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
