/** One lead's research: the record, its related records and activity, capped to RESEARCH_LIMITS.totalChars. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AiConsentStatus, ResearchSource, ResearchSourceSummary } from '@cti/contracts';
import { canonicalJson } from '../triage/notes.js';
import { readContentNotes, readEmails, readEvents, readNotes, readTasks, type ActivityItem } from './activity.js';
import { readChatter } from './chatter.js';
import { RESEARCH_LIMITS } from './limits.js';
import { readMainAndRelated, type RecordBlock, type ResearchReadDeps } from './related.js';

const Field = z.object({ name: z.string(), label: z.string(), value: z.string() });
const Block = z.object({
  relation: z.enum(['self', 'converted_contact', 'converted_account', 'converted_opportunity', 'account', 'contact']),
  sfObject: z.string(),
  id: z.string(),
  role: z.string().nullable(),
  fields: z.array(Field),
});
const Activity = z.object({
  source: z.enum(['task', 'event', 'note', 'content_note', 'email', 'chatter', 'chatter_comment']),
  id: z.string(),
  at: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string(),
  meta: z.record(z.string()),
});
export const ResearchSnapshot = z.object({
  version: z.literal(1),
  sfObject: z.enum(['Lead', 'Opportunity']),
  sfRecordId: z.string(),
  collectedAt: z.string(),
  consent: AiConsentStatus,
  records: z.array(Block),
  activity: z.array(Activity),
  sources: z.array(ResearchSourceSummary),
  truncated: z.boolean(),
});
export type ResearchSnapshot = z.infer<typeof ResearchSnapshot>;

export interface SnapshotInput {
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  collectedAt: Date;
  consent: z.infer<typeof AiConsentStatus>;
  records: RecordBlock[];
  activity: ActivityItem[];
  sources: ResearchSourceSummary[];
}

const KEEP_ON_SELF = new Set(['name', 'phone', 'mobilephone', 'email', 'firstname', 'lastname']);
const len = (v: unknown): number => JSON.stringify(v).length;

/** Drops the longest field values (related blocks first, then non-key fields of self) until the blocks fit `budget`. */
function fitRecords(records: RecordBlock[], budget: number): { records: RecordBlock[]; cut: boolean } {
  let out = records.map((b) => ({ ...b, fields: [...b.fields] }));
  let cut = false;
  while (len(out) > budget) {
    const candidates = out.flatMap((b, bi) => b.fields.map((f, fi) => ({ bi, fi, size: f.value.length, rank: b.relation === 'self' ? (KEEP_ON_SELF.has(f.name.toLowerCase()) ? 2 : 1) : 0 })));
    const victim = candidates.filter((c) => c.rank < 2).sort((a, b) => a.rank - b.rank || b.size - a.size)[0];
    if (!victim) break;
    out = out.map((b, bi) => (bi === victim.bi ? { ...b, fields: b.fields.filter((_, fi) => fi !== victim.fi) } : b));
    cut = true;
  }
  return { records: out, cut };
}

export function assembleSnapshot(input: SnapshotInput, totalChars: number = RESEARCH_LIMITS.totalChars): ResearchSnapshot {
  const { records, cut } = fitRecords(input.records, Math.floor(totalChars / 2));
  const base = { version: 1 as const, sfObject: input.sfObject, sfRecordId: input.sfRecordId, collectedAt: input.collectedAt.toISOString(), consent: input.consent, records, activity: [] as ActivityItem[], sources: input.sources, truncated: cut };
  let used = len(base);
  const activity: ActivityItem[] = [];
  const newestFirst = [...input.activity].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  for (const item of newestFirst) {
    const size = len(item) + 1;
    if (used + size > totalChars) return { ...base, activity, truncated: true };
    activity.push(item);
    used += size;
  }
  return { ...base, activity, truncated: cut || input.sources.some((s) => s.truncated) };
}

export const snapshotSize = (s: ResearchSnapshot): number => len(s);
export const snapshotHash = (s: ResearchSnapshot): string =>
  createHash('sha256').update(canonicalJson({ records: s.records, activity: s.activity, consent: s.consent })).digest('hex');

const SOURCE_ORDER = ResearchSource.options;

export async function researchRecord(
  deps: ResearchReadDeps,
  target: { sfObject: 'Lead' | 'Opportunity'; sfRecordId: string; consentField: string | null; now: Date },
): Promise<ResearchSnapshot | null> {
  const main = await readMainAndRelated(deps, target);
  if (!main) return null;
  const { links } = main;
  const [tasks, events, notes, contentNotes, emails, chatter] = await Promise.all([
    readTasks(deps.client, links),
    readEvents(deps.client, links),
    readNotes(deps.client, links),
    readContentNotes(deps.client, links),
    readEmails(deps.client, links),
    readChatter(deps.client, links),
  ]);
  const reads = [main.related, tasks, events, notes, contentNotes, emails, chatter.posts, chatter.comments];
  const summaries = [{ source: 'record' as const, status: 'ok' as const, count: 1, truncated: false, note: null }, ...reads.map((r) => r.summary)];
  return assembleSnapshot({
    sfObject: target.sfObject,
    sfRecordId: target.sfRecordId,
    collectedAt: target.now,
    consent: main.consent,
    records: [main.main, ...main.related.items],
    activity: [tasks, events, notes, contentNotes, emails, chatter.posts, chatter.comments].flatMap((r) => r.items),
    sources: SOURCE_ORDER.map((s) => summaries.find((x) => x.source === s)!),
  });
}
