/**
 * Plan 1D write-back: the pure write plan. Built once per call and frozen on the write-back row, so a retry never
 * re-decides against values the write-back itself wrote. It fills blanks only (never a rep's value), moves Status or
 * Stage per the approved outcome tables (only from the listed states, and only when the record still shows what
 * research saw), and models the appointment: an Event on the Opportunity (including a Lead just converted), or the
 * hold fallback on a Lead that could not be converted.
 */
import { BookedAppointment } from '@cti/contracts';
import { z } from 'zod';
import { isBlankish } from '../research/qualification.js';
import type { WritableField } from './fields.js';
import type { MappedAnswers } from './mapping-model.js';
import { CALL_RESULTS, LEAD_FROM, LEAD_TABLE, OPP_FROM, OPP_OPEN, OPP_TABLE, REASON_FIELDS, callResult, type CallResult, type Move, type Row } from './outcome-tables.js';
import { asText, blankKind, currentOf, fillValue, inPicklist, isDeclined, modeAllows, onlyNeverWrite, resolveMove, sameAnswer, sameText } from './plan-values.js';

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
  /** An appointment whose call then went to a transfer (5a Fix 1, M-9): noted in the changes text and Chatter. */
  bookingThen: BookingThen | null;
}
export type BookingThen = 'transferred' | 'transfer_failed';

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
  bookingThen: z.enum(['transferred', 'transfer_failed']).nullable(),
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
  /** A practice call: never books (its stored booking is ignored). */
  practice?: boolean;
}

const STATUS_FIELD: Readonly<Record<SfObject, string>> = { Lead: 'Status', Opportunity: 'StageName' };
/**
 * The do-not-call class: always applied, whatever the status guard says (5a Fix 1, I-3). PersonDoNotCall is never in a
 * plan; it is the Person Account flag the run sets for an Opportunity (Fix 1, M8), listed here so a refusal gets the
 * do-not-call section.
 */
export const DNC_FIELDS: ReadonlySet<string> = new Set(['DoNotCall', 'Removal_Status__c', 'Skip_on_Dialer__c', 'PersonDoNotCall']);
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

  /** The field and its allowlist name, matched exactly, then ignoring case against the allowlist or org name (M-4). */
  entry(name: string): [string, WritableField] | undefined {
    const exact = this.i.fields.get(name);
    if (exact) return [name, exact];
    const lower = name.toLowerCase();
    return [...this.i.fields].find(([key, f]) => key.toLowerCase() === lower || f.name.toLowerCase() === lower);
  }
  field(name: string): WritableField | undefined {
    return this.entry(name)?.[1];
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

/** The from-state and research checks for a row with no status move. */
function guardBlock(i: WritePlanInput, current: string | null): 'not_from_state' | 'moved_since_research' | null {
  const from = i.sfObject === 'Lead' ? LEAD_FROM : OPP_FROM;
  if (current === null || !from.has(current)) return 'not_from_state';
  if (i.researchStatus !== null && current !== i.researchStatus) return 'moved_since_research';
  return null;
}

/**
 * The status move and the moves that go with it, as a list of moves to apply. A reason goes only with its status. When
 * the record is outside the from-states or moved since research, Rating and Next Follow-Up stay too (a rep has the
 * record; 5a Fix 1, I-3), unless it is already at the target. Do-not-call moves always apply.
 */
function rowMoves(b: Builder, i: WritePlanInput, row: Row): Move[] {
  const name = STATUS_FIELD[i.sfObject];
  const current = asText(currentOf(i.current, b.field(name)?.name ?? name));
  const atTarget = row.status !== null && sameText(current, row.status);
  const block = row.status === null ? guardBlock(i, current) : atTarget ? null : statusBlock(b, i, row, row.status);
  if (row.status !== null && block !== null) b.skip(name, block);
  const held = block === 'not_from_state' || block === 'moved_since_research' ? block : null;
  const moves: Move[] = row.status === null || atTarget || block !== null ? [] : [{ field: name, value: row.status, mode: 'set' }];
  for (const m of row.also) {
    if (DNC_FIELDS.has(m.field)) moves.push(m);
    else if (REASON_FIELDS.has(m.field) && atTarget) moves.push({ ...m, mode: m.mode === 'set' ? 'fill' : m.mode });
    else if (REASON_FIELDS.has(m.field) && block !== null) b.skip(m.field, block);
    else if (held !== null) b.skip(m.field, held);
    else moves.push(m);
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

/** spec §5.1: fill only blank or "didn't ask" values; a declined value only over blank or never-write; a rep's value is kept. */
function fillBlanks(b: Builder, i: WritePlanInput, mapped: MappedAnswers): void {
  for (const [key, answer] of Object.entries(mapped.values)) {
    const hit = b.entry(key);
    if (!hit || hit[1].kind === 'status') {
      b.skip(hit?.[0] ?? key, 'not_writable');
      continue;
    }
    const [name, f] = hit;
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

const bookingThen = (outcome: string): BookingThen | null =>
  outcome === 'qualified_transferred' ? 'transferred' : outcome === 'transfer_failed' ? 'transfer_failed' : null;

export function buildWritePlan(i: WritePlanInput): WritePlan {
  if (i.converted !== null && i.sfObject !== 'Opportunity') throw new Error('a converted Lead is written as its Opportunity');
  const disposition = i.mapped?.disposition ?? null;
  const facts = { dispositionQuoted: i.mapped?.dispositionEvidence !== undefined, practice: i.practice === true };
  const result = callResult(i.outcome, disposition, i.appointment !== null, facts);
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
    bookingThen: result === 'appointment' ? bookingThen(i.outcome) : null,
  };
}
