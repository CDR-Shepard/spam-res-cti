/**
 * Plan 1D write-back: the pure write plan. Built once per call and frozen on the write-back row, so a retry never
 * re-decides against values the write-back itself wrote. It fills blanks only (never a rep's value), moves Status or
 * Stage per the approved outcome tables (only from the listed states, and only when the record still shows what
 * research saw), and models the appointment: an Event on the Opportunity (including a Lead just converted), or the
 * hold fallback on a Lead that could not be converted.
 */
import { BookedAppointment } from '@cti/contracts';
import { z } from 'zod';
import { DECLINED_VALUES, NEVER_WRITE_VALUES, isBlankish } from '../research/qualification.js';
import type { WritableField } from './fields.js';
import type { MappedAnswers, MappedValue } from './mapping-model.js';
import { CALL_RESULTS, LEAD_FROM, LEAD_TABLE, OPP_FROM, OPP_OPEN, OPP_TABLE, REASON_FIELDS, callResult, type CallResult, type Move, type Row } from './outcome-tables.js';
import { asText, blankKind, currentOf, inPicklist, modeAllows, resolveMove, sameText } from './plan-values.js';

type SfObject = 'Lead' | 'Opportunity';

export interface Change {
  field: string;
  label: string;
  before: string | null;
  after: string;
  why: 'filled' | 'status' | 'dnc' | 'follow_up' | 'changes';
}
export interface Kept {
  field: string;
  label: string;
  current: string;
  proposed: string;
  evidence: string;
}
export interface Skipped {
  field: string;
  label: string;
  why: 'not_writable' | 'invalid_value' | 'moved_since_research' | 'not_from_state';
}
/**
 * The Opportunity's booking moves, merged after the Event step: `onBooked` when the Event was created (or found),
 * `onConflict` when the slot was taken. The `*Changes` lists are the same moves as `Change`s, for the changes text.
 */
export interface AppointmentAction {
  booked: BookedAppointment;
  kind: 'opportunity_event' | 'lead_hold';
  onBooked: Record<string, unknown>;
  onConflict: Record<string, unknown>;
  onBookedChanges: Change[];
  onConflictChanges: Change[];
}
export interface WritePlan {
  sfObject: SfObject;
  result: CallResult;
  /** Never contains CHANGES_FIELD: the run step adds it. */
  patch: Record<string, unknown>;
  changes: Change[];
  kept: Kept[];
  skipped: Skipped[];
  appointment: AppointmentAction | null;
  /** Opportunity + do not call: the primary contact's DoNotCall is set too. */
  contactDnc: boolean;
  /** False when the answer mapping was unavailable: no fill-blanks. */
  mapped: boolean;
}

const ChangeSchema = z.object({
  field: z.string(),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string(),
  why: z.enum(['filled', 'status', 'dnc', 'follow_up', 'changes']),
});
const Patch = z.record(z.unknown());
/** The plan as stored in `ai_call_writebacks.plan` (jsonb); a row that no longer parses is refused, never guessed. */
export const StoredWritePlan: z.ZodType<WritePlan> = z.object({
  sfObject: z.enum(['Lead', 'Opportunity']),
  result: z.enum(CALL_RESULTS),
  patch: Patch,
  changes: z.array(ChangeSchema),
  kept: z.array(z.object({ field: z.string(), label: z.string(), current: z.string(), proposed: z.string(), evidence: z.string() })),
  skipped: z.array(z.object({ field: z.string(), label: z.string(), why: z.enum(['not_writable', 'invalid_value', 'moved_since_research', 'not_from_state']) })),
  appointment: z
    .object({
      booked: BookedAppointment,
      kind: z.enum(['opportunity_event', 'lead_hold']),
      onBooked: Patch,
      onConflict: Patch,
      onBookedChanges: z.array(ChangeSchema),
      onConflictChanges: z.array(ChangeSchema),
    })
    .nullable(),
  contactDnc: z.boolean(),
  mapped: z.boolean(),
});

export interface WritePlanInput {
  sfObject: SfObject;
  outcome: string;
  mapped: MappedAnswers | null;
  current: Record<string, unknown>;
  researchStatus: string | null;
  fields: ReadonlyMap<string, WritableField>;
  appointment: BookedAppointment | null;
  callbackAt: Date | null;
  now: Date;
  /** Set when the Lead was converted: the plan targets the new Opportunity (sfObject 'Opportunity'). */
  converted: { fromLeadId: string } | null;
}

const STATUS_FIELD: Readonly<Record<SfObject, string>> = { Lead: 'Status', Opportunity: 'StageName' };
const DNC_FIELDS: ReadonlySet<string> = new Set(['DoNotCall', 'Removal_Status__c', 'Skip_on_Dialer__c']);
const FOLLOW_UP_FIELDS: ReadonlySet<string> = new Set(['Next_Follow_Up_Date__c']);

const whyFor = (field: string): Change['why'] => (DNC_FIELDS.has(field) ? 'dnc' : FOLLOW_UP_FIELDS.has(field) ? 'follow_up' : 'status');

/** Collects patch entries, changes and skips; one entry per field. */
class Builder {
  readonly patch: Record<string, unknown> = {};
  readonly changes: Change[] = [];
  readonly kept: Kept[] = [];
  readonly skipped: Skipped[] = [];
  /** While true, skips are not recorded (the conflict moves: their stage reasons repeat the booked ones). */
  muted = false;
  constructor(private readonly i: WritePlanInput) {}

  field(name: string): WritableField | undefined {
    return this.i.fields.get(name);
  }
  label(name: string): string {
    return this.field(name)?.label ?? name;
  }
  skip(field: string, why: Skipped['why']): void {
    if (!this.muted && !this.skipped.some((s) => s.field === field)) this.skipped.push({ field, label: this.label(field), why });
  }
  /** The move as `{ name: value }` and a Change when it changes the record; null when it is skipped or no change. */
  move(m: Move, why: Change['why'] = whyFor(m.field)): { name: string; value: unknown; change: Change } | null {
    const f = this.field(m.field);
    const r = resolveMove(m, f, { now: this.i.now, callbackAt: this.i.callbackAt });
    if (!r.ok || !f) {
      this.skip(m.field, r.ok ? 'not_writable' : r.why);
      return null;
    }
    const before = asText(currentOf(this.i.current, f.name));
    if (!modeAllows(m.mode, f, this.i.current) || sameText(before, r.text)) return null;
    return { name: f.name, value: r.value, change: { field: m.field, label: f.label, before, after: r.text, why } };
  }
  apply(m: Move, why?: Change['why']): void {
    const out = this.move(m, why);
    if (!out) return;
    this.patch[out.name] = out.value;
    this.changes.push(out.change);
  }
}

/** Why the status may not move to `target` (null when it may). An already-reached target needs no check. */
function statusBlock(b: Builder, i: WritePlanInput, row: Row, target: string): Skipped['why'] | null {
  const name = STATUS_FIELD[i.sfObject];
  const f = b.field(name);
  if (!f) return 'not_writable';
  if (f.picklist !== null && inPicklist(f, target) === null) return 'invalid_value';
  const current = asText(currentOf(i.current, f.name));
  const from = i.sfObject === 'Lead' ? LEAD_FROM : OPP_FROM;
  if (current === null || !from.has(current) || (row.onlyFromOpen === true && !OPP_OPEN.has(current))) return 'not_from_state';
  if (i.researchStatus !== null && current !== i.researchStatus) return 'moved_since_research';
  return null;
}

/** The status move and the moves that go with it, as a list of moves to apply (reasons only with their status). */
function rowMoves(b: Builder, i: WritePlanInput, row: Row): Move[] {
  const name = STATUS_FIELD[i.sfObject];
  if (row.status === null) return [...row.also];
  const current = asText(currentOf(i.current, b.field(name)?.name ?? name));
  const atTarget = sameText(current, row.status);
  const block = atTarget ? null : statusBlock(b, i, row, row.status);
  if (block !== null) b.skip(name, block);
  const moves: Move[] = atTarget || block !== null ? [] : [{ field: name, value: row.status, mode: 'set' }];
  for (const m of row.also) {
    if (!REASON_FIELDS.has(m.field)) moves.push(m);
    else if (atTarget) moves.push({ ...m, mode: m.mode === 'set' ? 'fill' : m.mode });
    else if (block === null) moves.push(m);
    else b.skip(m.field, block);
  }
  return moves;
}

/** The booking moves as a patch plus changes, applied later by the run step. */
function bookingMoves(b: Builder, i: WritePlanInput, row: Row): { patch: Record<string, unknown>; changes: Change[] } {
  const patch: Record<string, unknown> = {};
  const changes: Change[] = [];
  for (const m of rowMoves(b, i, row)) {
    const out = b.move(m);
    if (!out) continue;
    patch[out.name] = out.value;
    changes.push(out.change);
  }
  return { patch, changes };
}

/** Blank, or holding only never-write values ("I Didn't Ask"): the only values a declined answer may replace. */
const onlyNeverWrite = (before: string | null): boolean => before === null || before.split(';').every((s) => s.trim() === '' || NEVER_WRITE_VALUES.has(s.trim().toLowerCase()));
const isDeclined = (v: MappedValue): boolean => {
  const vs = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return vs.length > 0 && vs.every((x) => DECLINED_VALUES.has(x.trim().toLowerCase()));
};
const neverWrite = (v: MappedValue): boolean => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).some((x) => NEVER_WRITE_VALUES.has(x.trim().toLowerCase()));

/** The mapped value as the field takes it, or null when it is not valid for the field (re-checked against the describe). */
function fillValue(f: WritableField, v: MappedValue): string | number | boolean | null {
  if (neverWrite(v)) return null;
  if (f.kind === 'picklist') return typeof v === 'string' ? inPicklist(f, v) : null;
  if (f.kind === 'multipicklist') {
    const vs = Array.isArray(v) ? v.map((x) => inPicklist(f, x)) : [];
    return vs.length > 0 && vs.every((x) => x !== null) ? vs.join(';') : null;
  }
  if (f.kind === 'currency') return typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (f.kind === 'boolean') return v === true ? true : null;
  return f.kind === 'text' && typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Same answer as the record already holds: case-insensitive text, numeric for currency, as a set for a multipicklist. */
function sameAnswer(f: WritableField, current: string, after: string): boolean {
  if (f.kind === 'currency') return Number(current) === Number(after);
  if (f.kind === 'multipicklist') {
    const set = (s: string) => [...new Set(s.split(';').map((x) => x.trim().toLowerCase()).filter((x) => x !== ''))].sort().join(';');
    return set(current) === set(after);
  }
  return current.trim().toLowerCase() === after.trim().toLowerCase();
}

/** spec §5.1: fill only blank or "didn't ask" values; a declined value only over blank or never-write; a rep's value is kept. */
function fillBlanks(b: Builder, i: WritePlanInput, mapped: MappedAnswers): void {
  for (const [name, answer] of Object.entries(mapped.values)) {
    const f = b.field(name);
    if (!f || f.kind === 'status') {
      b.skip(name, 'not_writable');
      continue;
    }
    const value = fillValue(f, answer.value);
    if (value === null) {
      b.skip(name, 'invalid_value');
      continue;
    }
    const after = String(value);
    const before = asText(currentOf(i.current, f.name));
    if (before !== null && sameAnswer(f, before, after)) continue;
    const blank = isBlankish(before, blankKind(f), f.name);
    const declinedOk = !isDeclined(answer.value) || onlyNeverWrite(before);
    if (blank && declinedOk) {
      b.patch[f.name] = value;
      b.changes.push({ field: name, label: f.label, before, after, why: 'filled' });
    } else if (!blank && f.kind !== 'boolean' && before !== null) {
      b.kept.push({ field: name, label: f.label, current: before, proposed: after, evidence: answer.evidence });
    }
  }
}

export function buildWritePlan(i: WritePlanInput): WritePlan {
  if (i.converted !== null && i.sfObject !== 'Opportunity') throw new Error('a converted Lead is written as its Opportunity');
  const disposition = i.mapped?.disposition ?? null;
  const result = callResult(i.outcome, disposition, i.appointment !== null);
  const b = new Builder(i);
  let appointment: AppointmentAction | null = null;

  if (result === 'appointment' && i.appointment !== null && i.sfObject === 'Opportunity') {
    const booked = bookingMoves(b, i, OPP_TABLE.appointment);
    b.muted = true;
    const conflict = bookingMoves(b, i, OPP_TABLE.appointment_conflict);
    b.muted = false;
    appointment = { booked: i.appointment, kind: 'opportunity_event', onBooked: booked.patch, onConflict: conflict.patch, onBookedChanges: booked.changes, onConflictChanges: conflict.changes };
  } else {
    const row = i.sfObject === 'Lead' ? LEAD_TABLE[result] : OPP_TABLE[result];
    for (const m of rowMoves(b, i, row)) b.apply(m);
    if (result === 'appointment' && i.appointment !== null) {
      appointment = { booked: i.appointment, kind: 'lead_hold', onBooked: {}, onConflict: {}, onBookedChanges: [], onConflictChanges: [] };
    }
  }
  if (i.mapped !== null) fillBlanks(b, i, i.mapped);

  return {
    sfObject: i.sfObject,
    result,
    patch: b.patch,
    changes: b.changes,
    kept: b.kept,
    skipped: b.skipped,
    appointment,
    contactDnc: i.sfObject === 'Opportunity' && result === 'do_not_call',
    mapped: i.mapped !== null,
  };
}
