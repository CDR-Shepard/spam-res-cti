/**
 * Plan 1D write plan helpers: reading a record's current values as text, resolving a table move to a value valid for
 * its field, and the next-business-day follow-up time. Pure.
 */
import { addLocalDays, zonedInstant, zonedParts } from '../appointments/zoned.js';
import { isBlankish, type FieldKind } from '../research/qualification.js';
import type { WritableField } from './fields.js';
import type { Move } from './outcome-tables.js';

export const FOLLOW_UP_ZONE = 'America/Los_Angeles';
const FOLLOW_UP_HOUR = 10;

/** `current[name]`, matched case-insensitively (the org's spelling may differ from ours). */
export function currentOf(current: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(current, name)) return current[name];
  const lower = name.toLowerCase();
  const key = Object.keys(current).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : current[key];
}

/** A Salesforce value as text for comparing and showing: null for null, undefined and blank strings. */
export function asText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

/** The blank rule for a field: its qualification kind, or by describe type for a status field. */
export function blankKind(f: WritableField): FieldKind {
  if (f.kind !== 'status') return f.kind;
  if (f.type === 'boolean') return 'boolean';
  if (f.type === 'multipicklist') return 'multipicklist';
  return f.type === 'picklist' ? 'picklist' : 'text';
}

export const isBlank = (f: WritableField, current: Record<string, unknown>): boolean => isBlankish(asText(currentOf(current, f.name)), blankKind(f), f.name);

/** The org's spelling of `value` in the field's active picklist, matched case-insensitively. */
export function inPicklist(f: WritableField, value: string): string | null {
  const lower = value.trim().toLowerCase();
  return (f.picklist ?? []).find((p) => p.toLowerCase() === lower) ?? null;
}

const isoWeekday = (y: number, m: number, d: number): number => {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
};

/** The next Monday–Friday after `now`'s Pacific date, at 10:00 Pacific. Holidays are not modelled. */
export function nextBusinessMorning(now: Date): Date {
  for (let n = 1; n <= 7; n += 1) {
    const day = addLocalDays(now, n, FOLLOW_UP_ZONE);
    if (isoWeekday(day.year, day.month, day.day) <= 5) return zonedInstant(FOLLOW_UP_ZONE, day.year, day.month, day.day, FOLLOW_UP_HOUR, 0);
  }
  throw new Error('unreachable: a week always has a weekday');
}

/** A date-only field takes the Pacific calendar date of the instant. */
function pacificDate(at: Date): string {
  const p = zonedParts(at, FOLLOW_UP_ZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export type Resolved = { ok: true; value: string | boolean; text: string } | { ok: false; why: 'not_writable' | 'invalid_value' };

/**
 * A table move's value, valid for its field: a picklist value the org has (its spelling), a boolean for a boolean
 * field, `NOW` / `CALLBACK` for a datetime (or date) field. Anything else is `invalid_value`.
 */
export function resolveMove(move: Move, f: WritableField | undefined, times: { now: Date; callbackAt: Date | null }): Resolved {
  if (!f) return { ok: false, why: 'not_writable' };
  const { value } = move;
  if (typeof value === 'boolean') return f.type === 'boolean' ? { ok: true, value, text: String(value) } : { ok: false, why: 'invalid_value' };
  if (value === 'NOW' || value === 'CALLBACK') {
    const at = value === 'NOW' ? times.now : (times.callbackAt ?? nextBusinessMorning(times.now));
    if (f.type === 'datetime') return { ok: true, value: at.toISOString(), text: at.toISOString() };
    if (f.type === 'date') return { ok: true, value: pacificDate(at), text: pacificDate(at) };
    return { ok: false, why: 'invalid_value' };
  }
  if (f.picklist !== null) {
    const hit = inPicklist(f, value);
    return hit === null ? { ok: false, why: 'invalid_value' } : { ok: true, value: hit, text: hit };
  }
  return f.type === 'string' || f.type === 'textarea' ? { ok: true, value, text: value } : { ok: false, why: 'invalid_value' };
}

/** Whether `mode` lets the move write over the current value. */
export function modeAllows(mode: Move['mode'], f: WritableField, current: Record<string, unknown>): boolean {
  if (mode === 'set') return true;
  if (isBlank(f, current)) return true;
  return mode === 'raise' && asText(currentOf(current, f.name))?.toLowerCase() === 'cold';
}

/** Same value, ignoring case for text. */
export const sameText = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();
