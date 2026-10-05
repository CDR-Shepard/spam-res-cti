/**
 * An edited plan stays plain text. The contract bounds its lengths; this rejects what is not text:
 *  - control characters other than tab, line feed and carriage return (`\p{Cc}`; a NUL also makes Postgres refuse the jsonb),
 *  - every format character (`\p{Cf}`: bidi overrides and isolates, zero-width characters, the byte-order mark),
 *  - the Unicode line and paragraph separators (U+2028, U+2029),
 *  - lone surrogates (the same jsonb refusal).
 * Single-line fields (everything the contract treats as one line) also reject line breaks, through one shared rule.
 */
import type { EditableCallPlan } from '@cti/contracts';

const NOT_TEXT = /[^\P{Cc}\t\n\r]|\p{Cf}|[\u{2028}\u{2029}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const LINE_BREAK = /[\n\r]/;

/** True when `s` is plain text; `singleLine` also refuses line breaks. */
export const isPlainString = (s: string, singleLine = false): boolean => !NOT_TEXT.test(s) && !(singleLine && LINE_BREAK.test(s));

/** True when every string anywhere inside `value` (object keys included) is plain text. Line breaks are allowed. */
export function isPlainText(value: unknown): boolean {
  if (typeof value === 'string') return isPlainString(value);
  if (Array.isArray(value)) return value.every(isPlainText);
  if (value !== null && typeof value === 'object') return Object.entries(value).every(([k, v]) => isPlainString(k) && isPlainText(v));
  return true;
}

/** The one field that may run over several lines; every other string of a plan is a single line. */
const MULTI_LINE_FIELDS: ReadonlySet<string> = new Set(['situationSummary']);

function collect(value: unknown, path: string[], out: string[]): void {
  if (typeof value === 'string') {
    if (!isPlainString(value, !MULTI_LINE_FIELDS.has(path[0] ?? ''))) out.push(path.join('.'));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collect(v, [...path, String(i)], out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!isPlainString(k, true)) out.push([...path, '<key>'].join('.'));
      collect(v, [...path, k], out);
    }
  }
}

/** The dotted paths of the plan's fields that are not plain text (empty when the plan is fine). */
export function planTextIssues(plan: EditableCallPlan): string[] {
  const out: string[] = [];
  collect(plan, [], out);
  return out;
}
