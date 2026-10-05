import { soqlEscape } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** Rich text (Chatter, ContentNote, EmailMessage HTML) → one line of plain text. */
export function plainText(s: string): string {
  return s
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|div|li|ul|ol|h\d)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first `max` UTF-16 code units of `s`, minus a trailing first half of a surrogate pair:
 * a lone surrogate would serialize as a \udXXX escape that Postgres jsonb rejects.
 */
export function cutUtf16(s: string, max: number): string {
  const cut = s.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A string Postgres jsonb will accept. Salesforce can hand us a lone surrogate, which
 * `JSON.stringify` writes as a \udXXX escape that jsonb refuses, and a NUL, which jsonb refuses too.
 * Each lone surrogate becomes U+FFFD and NULs are dropped.
 */
export const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, '\uFFFD').replace(/\u0000/g, '');

/** `wellFormed` on every string in `v`, keys included (objects and arrays are copied, never changed in place). */
export function wellFormedDeep<T>(v: T): T {
  if (typeof v === 'string') return wellFormed(v) as T;
  if (Array.isArray(v)) return v.map((x) => wellFormedDeep(x)) as T;
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [wellFormed(k), wellFormedDeep(x)])) as T;
  return v;
}

export function clip(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: `${cutUtf16(s, max)}…`, truncated: true } : { text: s, truncated: false };
}

/** A field value worth showing: strings, numbers, true. False, empty, and compound/relationship objects are dropped. */
export function fieldValueText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v.trim() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (v === true) return 'true';
  return null;
}

/** `'id1', 'id2'` for an IN (...) list; ids are shape-checked, then escaped. */
export function soqlIdList(ids: readonly string[]): string {
  const valid = [...new Set(ids.filter((id) => SF_ID.test(id)))];
  if (valid.length === 0) throw new Error('soqlIdList needs at least one valid record id');
  return valid.map((id) => `'${soqlEscape(id)}'`).join(', ');
}

/** Record text inside the prompt's data tags can never open or close a tag. */
export function escapeData(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeData(s).replace(/"/g, '&quot;');
}
