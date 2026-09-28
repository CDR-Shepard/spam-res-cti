/**
 * Power Dial run settings (spec docs/superpowers/specs/2026-09-28-run-settings-design.md)
 * — the one definition the API (route validation, engine, rollover worker,
 * `/auth/me`) and the softphone (Ready to dial, the run line) share.
 *
 * Every default here is TODAY'S run: Twice, the whole list, next business day.
 * A value that cannot be read falls back to it, so a bad row or an older
 * client never changes how a rep's run behaves.
 */

/** Calls per person: 1 = Once (no end-of-run retry), 2 = Twice (today). */
export const DIALER_PASSES = [1, 2] as const;
export type DialerPasses = (typeof DIALER_PASSES)[number];

/** Missed tasks move to: 1 = next business day (today), 2 = in 2 business days. */
export const ROLLOVER_BUSINESS_DAYS = [1, 2] as const;
export type RolloverBusinessDays = (typeof ROLLOVER_BUSINESS_DAYS)[number];

/** The most records one run can hold — POST /dialer/sessions caps `recordIds` at 500. */
export const MAX_RUN_RECORDS = 500;

/**
 * What `/auth/me` returns as `dialerRunDefaults`, and what a Start saves as
 * the rep's next defaults. `maxRecords` (controller ruling S2, migration
 * 0046) is remembered like the other two choices: null = All.
 */
export interface DialerRunDefaults {
  passes: DialerPasses;
  maxRecords: number | null;
  rolloverBusinessDays: RolloverBusinessDays;
}

/** The Start dialing body — currently the same shape as `DialerRunDefaults`,
 *  kept as its own name because `maxRecords` is fundamentally a per-run
 *  choice (only saved as a default per S2, not defined by being one). */
export type DialerRunSettings = DialerRunDefaults;

export const DEFAULT_DIALER_RUN_DEFAULTS: DialerRunDefaults = { passes: 2, maxRecords: null, rolloverBusinessDays: 1 };

export function toDialerPasses(v: unknown): DialerPasses {
  return v === 1 ? 1 : 2;
}

export function toRolloverBusinessDays(v: unknown): RolloverBusinessDays {
  return v === 2 ? 2 : 1;
}

/** `null` (All) unless `v` is a positive integer — a bad or missing row reads
 *  as All, never an arbitrary number (controller ruling S2). */
export function toMaxRecords(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

export function toDialerRunDefaults(
  v: { passes?: unknown; maxRecords?: unknown; rolloverBusinessDays?: unknown } | null | undefined,
): DialerRunDefaults {
  return {
    passes: toDialerPasses(v?.passes),
    maxRecords: toMaxRecords(v?.maxRecords),
    rolloverBusinessDays: toRolloverBusinessDays(v?.rolloverBusinessDays),
  };
}
