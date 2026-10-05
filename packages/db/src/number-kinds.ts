/**
 * The kinds of caller-ID number in `outbound_numbers.kind` (pgEnum `number_kind`),
 * and which dial paths may use each. One source of truth so no path invents its
 * own list.
 *
 *   agent        a rep's own warm number (click-to-dial, Task-list power runs)
 *   dialer_pool  shared numbers the power dialer uses for cold volume
 *   ai_pool      the AI voice agent's OWN numbers (services/cti-api/src/ai-voice)
 *
 * Hard invariant: the AI dials only from `ai_pool`, and no rep path ever dials
 * from `ai_pool`. Order matches Postgres (`ADD VALUE` appends 'ai_pool' last in
 * migration 0050); drizzle-kit compares enum member order.
 */
export const NUMBER_KINDS = ['agent', 'dialer_pool', 'ai_pool'] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

/** The only kind the AI voice agent may dial from. */
export const AI_NUMBER_KIND = 'ai_pool' satisfies NumberKind;

/**
 * Kinds a rep path (click-to-dial rotation, the firewall's from-number check,
 * POST /calls, the dial-time re-check) may dial from: every kind EXCEPT
 * `ai_pool`. `dialer_pool` stays in so a pool number an admin assigned to a rep
 * keeps behaving as it did before `ai_pool` existed.
 */
export const REP_NUMBER_KINDS = ['agent', 'dialer_pool'] as const satisfies readonly NumberKind[];
