/**
 * SOQL text helpers. Dependency-free, like services/cti-api/src/salesforce/soql.ts.
 */

/** Escape a value for safe interpolation into a SOQL string literal.
 *  Same behavior as services/cti-api/src/salesforce/soql.ts. */
export function soqlEscape(value: string): string {
  // Backslash FIRST: escaping quotes first would then double-escape the
  // backslashes this step introduces.
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** A 15- or 18-character Salesforce record Id. */
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/**
 * The record Id of one query row: the selected `Id` when present, else the
 * last path segment of `attributes.url` (`/services/data/vXX.X/sobjects/Lead/00Q…`),
 * which Salesforce includes on every row even when the query does not select
 * `Id`. Null when neither holds a well-formed Id.
 */
export function recordIdFromRow(row: { Id?: unknown; attributes?: { url?: unknown } }): string | null {
  if (typeof row.Id === 'string' && SF_ID.test(row.Id)) return row.Id;
  const url = row.attributes?.url;
  if (typeof url !== 'string') return null;
  const path = url.split('?')[0] ?? '';
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return SF_ID.test(last) ? last : null;
}
