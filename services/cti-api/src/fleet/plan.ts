/** Area-code policy for the inbound-team fleet (spec 2026-08-24): LA = 213/323, SD = 619/858. */
export type AreaClass = 'LA' | 'SD' | 'other';

export const LA_CODES = ['213', '323'];
export const SD_CODES = ['619', '858'];
const LA = new Set(LA_CODES);
const SD = new Set(SD_CODES);

export function classifyArea(e164: string): AreaClass {
  const ac = /^\+1(\d{3})\d{7}$/.exec(e164)?.[1];
  if (!ac) return 'other';
  return LA.has(ac) ? 'LA' : SD.has(ac) ? 'SD' : 'other';
}

export interface Holding { e164: string; health: string; active: boolean }

const usable = (x: Holding): boolean => x.active && x.health !== 'degraded' && x.health !== 'spam_likely';

/** How many LA/SD numbers a rep still needs. Degraded/inactive/other-area holdings never count. */
export function buyPlanForRep(holdings: ReadonlyArray<Holding>, target = { la: 6, sd: 6 }): { la: number; sd: number } {
  const held = { LA: 0, SD: 0, other: 0 };
  for (const x of holdings) if (usable(x)) held[classifyArea(x.e164)]++;
  return { la: Math.max(0, target.la - held.LA), sd: Math.max(0, target.sd - held.SD) };
}

/** Dialer-pool size the fleet is sized for (spec 2026-08-24). */
export const POOL_TARGET = 50;

export function poolBuyCount(existingActivePool: number, target = POOL_TARGET): number {
  return Math.max(0, target - existingActivePool);
}

/**
 * How many pool DIDs a `buy-pool --count <asked>` run should actually purchase.
 * `asked` is a TARGET, never an increment: it is capped by the shortfall toward
 * `target` given what is live in the DB, then reduced by what a previous run
 * already bought into the hand-off but has not `register`ed yet. Never negative,
 * so a re-run (including one after `register` pruned the hand-off) never re-buys.
 */
export function poolBuyTarget(asked: number, activePool: number, inHandoff: number, target = POOL_TARGET): number {
  return Math.max(0, Math.min(asked, poolBuyCount(activePool, target)) - inHandoff);
}

/**
 * How many reserve DIDs of one area class a `buy-reserve` run should purchase.
 * `asked` is the desired size of the free (unassigned, healthy) reserve, so both
 * what the DB already holds free and what sits unregistered in the hand-off count
 * against it. Never negative — a satisfied re-run buys nothing.
 */
export function reserveBuyTarget(asked: number, freeInDb: number, inHandoff: number): number {
  return Math.max(0, asked - freeInDb - inHandoff);
}

/**
 * Split one pool batch evenly across the two pool area codes (619 first, 951
 * second): `ceil(n/2)` from the first, `floor(n/2)` from the second, so a 40-DID
 * batch lands 20/20 instead of exhausting 619 first. Never negative, and the two
 * halves always sum back to the batch.
 */
export function splitEvenly(count: number): [number, number] {
  const n = Math.max(0, count);
  const first = Math.ceil(n / 2);
  return [first, n - first];
}
