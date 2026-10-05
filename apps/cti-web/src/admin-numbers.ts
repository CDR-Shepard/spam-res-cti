/**
 * Where a number sits on the admin Numbers screen: assigned to a rep, in the
 * shared reserve, or in AI calls — the AI voice agent's OWN caller IDs
 * (`kind = 'ai_pool'`). An AI number is never a rep's; moving one to a rep or
 * the reserve makes it an ordinary `agent` number in the same edit, which the
 * API requires (services/cti-api routes/number-kind.ts).
 */
export type NumberKind = 'agent' | 'dialer_pool' | 'ai_pool';

export const RESERVE = '__reserve__';
export const AI_CALLS = '__ai_calls__';
export const AI_CALLS_LABEL = 'AI calls';

export interface PlacedNumber {
  id: string;
  /** Optional: an older API build did not send it. */
  kind?: NumberKind;
  assignedUserId: string | null;
}

const isAi = (n: PlacedNumber): boolean => n.kind === 'ai_pool';

/** The value a row's placement select shows. */
export function placementOf(n: PlacedNumber): string {
  if (isAi(n)) return AI_CALLS;
  return n.assignedUserId ?? RESERVE;
}

/** The PATCH body for choosing `value` in a row's placement select. */
export function placementPatch(n: PlacedNumber, value: string): Record<string, unknown> {
  if (value === AI_CALLS) return { kind: 'ai_pool', assignedUserId: null };
  const assignedUserId = value === RESERVE ? null : value;
  return isAi(n) ? { kind: 'agent', assignedUserId } : { assignedUserId };
}

/** The POST body fields for the Add form's placement choice. */
export function addPlacement(value: string): Record<string, unknown> {
  if (value === AI_CALLS) return { kind: 'ai_pool', assignedUserId: null };
  return { assignedUserId: value === RESERVE ? null : value };
}

export interface NumberGroup<T> {
  key: string;
  title: string;
  icon: 'rep' | 'reserve' | 'ai';
  rows: T[];
}

/** Each rep, then the reserve pool, then AI calls. Stable, predictable order. */
export function groupNumbers<T extends PlacedNumber, R extends { id: string }>(
  numbers: readonly T[],
  reps: readonly R[],
  repLabel: (r: R) => string,
): Array<NumberGroup<T>> {
  const byPlacement = new Map<string, T[]>();
  for (const n of numbers) {
    const key = placementOf(n);
    byPlacement.set(key, [...(byPlacement.get(key) ?? []), n]);
  }
  return [
    ...reps.map((r) => ({ key: r.id, title: repLabel(r), icon: 'rep' as const, rows: byPlacement.get(r.id) ?? [] })),
    { key: RESERVE, title: 'Reserve pool', icon: 'reserve' as const, rows: byPlacement.get(RESERVE) ?? [] },
    { key: AI_CALLS, title: AI_CALLS_LABEL, icon: 'ai' as const, rows: byPlacement.get(AI_CALLS) ?? [] },
  ];
}
