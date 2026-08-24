/** Area-code policy for the inbound-team fleet (spec 2026-08-24): LA = 213/323, SD = 619/858. */
export type AreaClass = 'LA' | 'SD' | 'other';

const LA = new Set(['213', '323']);
const SD = new Set(['619', '858']);

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

export function poolBuyCount(existingActivePool: number, target = 50): number {
  return Math.max(0, target - existingActivePool);
}
