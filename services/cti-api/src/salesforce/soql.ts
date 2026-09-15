/**
 * SOQL text helpers. Deliberately dependency-free so modules that must not pull
 * in the Salesforce client (and with it config, the database and undici) can
 * still build a query safely — see permission-set.ts.
 */

/** Escape a value for safe interpolation into a SOQL string literal. */
export function soqlEscape(value: string): string {
  // Backslash FIRST: escaping quotes first would then double-escape the
  // backslashes this step introduces.
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
