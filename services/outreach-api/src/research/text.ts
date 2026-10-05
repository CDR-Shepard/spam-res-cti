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

export function clip(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: `${s.slice(0, max)}…`, truncated: true } : { text: s, truncated: false };
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
