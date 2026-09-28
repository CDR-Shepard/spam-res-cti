/**
 * Power Dial run settings on Ready to dial (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md): the draft the rep
 * edits, the Start dialing body, the run line under the progress, and a limited
 * run's "record X of N". Pure — DialerPanel owns the state.
 */
import {
  toDialerRunDefaults,
  type DialerPasses,
  type DialerRunDefaults,
  type DialerRunSettings,
  type RolloverBusinessDays,
} from '@cti/contracts';

/** What the rep is editing. `howMany` is the raw box: '' means All. */
export interface RunDraft {
  passes: DialerPasses;
  rolloverBusinessDays: RolloverBusinessDays;
  howMany: string;
}

export const PASS_LABELS: Readonly<Record<DialerPasses, string>> = { 1: 'Once', 2: 'Twice' };
export const ROLLOVER_LABELS: Readonly<Record<RolloverBusinessDays, string>> = { 1: 'Next business day', 2: 'In 2 business days' };

/** A fresh Ready screen: the rep's saved choices — including How many
 *  (controller ruling S2: `defaults.maxRecords`, null = All) — prefilled from
 *  their last run. */
export function draftFromDefaults(defaults: DialerRunDefaults): RunDraft {
  return {
    passes: defaults.passes,
    rolloverBusinessDays: defaults.rolloverBusinessDays,
    howMany: defaults.maxRecords == null ? '' : String(defaults.maxRecords),
  };
}

/** `/auth/me`'s saved choices, including the remembered How many (ruling S2).
 *  An older API (no field) or a value this build does not know reads as
 *  today's run. */
export function runDefaultsFromMe(user: {
  dialerRunDefaults?: { passes?: unknown; maxRecords?: unknown; rolloverBusinessDays?: unknown } | null;
}): DialerRunDefaults {
  return toDialerRunDefaults(user.dialerRunDefaults);
}

/** The box keeps digits only, so a paste of "1,000" or "50 people" can never
 *  become a number the rep did not see. */
export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

export type HowMany = { ok: true; maxRecords: number | null } | { ok: false; error: string };

/** Blank = All; otherwise a whole number from 1 up to the list size. */
export function parseHowMany(raw: string, listSize: number): HowMany {
  const text = raw.trim();
  if (text === '') return { ok: true, maxRecords: null };
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > listSize) {
    return { ok: false, error: `Enter a whole number from 1 to ${listSize}, or leave it blank for all.` };
  }
  return { ok: true, maxRecords: n };
}

/** The Start dialing body — or null while the box holds something Start must not send. */
export function runSettingsFor(draft: RunDraft, listSize: number): DialerRunSettings | null {
  const howMany = parseHowMany(draft.howMany, listSize);
  if (!howMany.ok) return null;
  return { passes: draft.passes, maxRecords: howMany.maxRecords, rolloverBusinessDays: draft.rolloverBusinessDays };
}

/** The line under a run's progress, e.g. "Once · first 100 · missed → next
 *  business day". Null when the server sent no settings (an older API). */
export function runSettingsLine(session: {
  passes?: DialerPasses;
  maxRecords?: number | null;
  rolloverBusinessDays?: RolloverBusinessDays;
}): string | null {
  if (session.passes === undefined || session.rolloverBusinessDays === undefined) return null;
  const size = session.maxRecords == null ? 'all' : `first ${session.maxRecords}`;
  const missed = session.rolloverBusinessDays === 2 ? 'in 2 business days' : 'next business day';
  return `${PASS_LABELS[session.passes]} · ${size} · missed → ${missed}`;
}

/**
 * The current record's "record X of N". A limited run (spec 2026-09-28
 * decision 5) counts its OWN queue: "record 3 of 100" — the Salesforce list
 * position would read "record 150 of 100" there. A full run keeps the list
 * position ("two reps, one list", spec 2026-09-23 §4). An attempt-2 retry sits
 * past the end of the queue, so it gets no count; nor does a row an older
 * server sent without an ordinal.
 */
export function recordPositionLine(
  item: { listPosition?: number | null; ordinal?: number; attempt?: number },
  ctx: { listTotal: number | null; runSize: number | null },
): string | null {
  if (ctx.runSize !== null) {
    if (item.attempt === 2 || item.ordinal === undefined) return null;
    return `record ${item.ordinal + 1} of ${ctx.runSize}`;
  }
  if (item.listPosition != null && ctx.listTotal !== null) return `record ${item.listPosition + 1} of ${ctx.listTotal}`;
  return null;
}
