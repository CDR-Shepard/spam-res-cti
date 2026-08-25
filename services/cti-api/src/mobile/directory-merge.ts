/** The caller-ID directory rule (spec 2026-08-25): one label per number, the
 *  latest stage wins (Deal > Opp > Lead), stage spelled out in the label. */
import { createHash } from 'node:crypto';

export type Stage = 'deal' | 'opp' | 'lead';
export interface RawEntry { e164: string; name: string; stage: Stage }

const RANK: Record<Stage, number> = { deal: 3, opp: 2, lead: 1 };
const PREFIX: Record<Stage, string> = { deal: 'Deal: ', opp: 'Opp: ', lead: 'Lead: ' };

export function mergeDirectory(entries: ReadonlyArray<RawEntry>): Array<{ e164: string; label: string; stage: Stage }> {
  const best = new Map<string, RawEntry>();
  for (const e of entries) {
    const name = e.name.trim();
    if (!name) continue;
    const cur = best.get(e.e164);
    if (!cur || RANK[e.stage] > RANK[cur.stage]) best.set(e.e164, { ...e, name });
  }
  return [...best.values()]
    .map((e) => ({ e164: e.e164, label: PREFIX[e.stage] + e.name, stage: e.stage }))
    .sort((a, b) => (BigInt(a.e164.replace(/\D/g, '')) < BigInt(b.e164.replace(/\D/g, '')) ? -1 : 1));
}

export function contentHash(merged: ReadonlyArray<{ e164: string; label: string }>): string {
  return createHash('sha256').update(JSON.stringify(merged.map((m) => [m.e164, m.label]))).digest('hex');
}
