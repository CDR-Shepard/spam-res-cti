/**
 * An edited plan stays plain text. The contract bounds its lengths; this rejects what is not text:
 * control characters (a NUL makes Postgres refuse the jsonb) and lone surrogates (the same).
 * Newlines and tabs are text.
 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export const isPlainString = (s: string): boolean => !CONTROL.test(s) && !LONE_SURROGATE.test(s);

/** True when every string anywhere inside `value` (object keys included) is plain text. */
export function isPlainText(value: unknown): boolean {
  if (typeof value === 'string') return isPlainString(value);
  if (Array.isArray(value)) return value.every(isPlainText);
  if (value !== null && typeof value === 'object') return Object.entries(value).every(([k, v]) => isPlainString(k) && isPlainText(v));
  return true;
}
