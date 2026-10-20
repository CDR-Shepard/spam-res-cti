/**
 * What Sam's writer is told about one seller, read from the database: the first name, the approved call plan,
 * the history digest of the timeline, and the seller's local time. Read-only, and every statement is scoped by
 * tenant, so a record id of another tenant reads as an empty context rather than someone else's data.
 *
 * The call plan is the one the seller's AI call campaign approved, worded the way the voice agent gets it
 * (`renderPlanForAgent`: no situation summary, no evidence quotes, no price they have in mind), so Sam knows what
 * the call was after without being handed anything the agent is not. It comes from the record's NEWEST AI call
 * enrollment only: an older enrollment's plan is stale once the seller has been enrolled again.
 */
import { and, eq, sql } from 'drizzle-orm';
import { EditableCallPlan } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { renderPlanForAgent } from '../ai-calls/plan-text.js';
import { historyDigest } from '../conversations/digest.js';
import { readTimeline } from '../conversations/timeline.js';
import { recipientTimezone } from '../planner/local-time.js';
import type { WriterInput } from './writer-prompt.js';

/** How much history Sam reads: the newest lines that fit, whole. */
export const HISTORY_DIGEST_CHARS = 3_000;

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

/** The first word of a name; null for none. */
function firstWord(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** `Tuesday, October 20, 2026, 9:05 AM` as the clock reads in `timezone` (built from parts, so no ICU version changes it). */
function localTimeWords(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')}, ${part('month')} ${part('day')}, ${part('year')}, ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`;
}

/** The approved plan of the record's newest AI call enrollment, as the voice agent reads it; null when there is none or it does not render. */
async function approvedPlanText(db: Db, i: { orgId: string; crmRecordId: string; now: Date }): Promise<string | null> {
  const result = await db.execute(sql`
    select p.plan as "plan"
    from (
      select e.id
      from campaign_enrollments e
      join campaigns c on c.id = e.campaign_id and c.org_id = e.org_id and c.mode = 'ai_call'
      where e.org_id = ${i.orgId}::uuid and e.crm_record_id = ${i.crmRecordId}::uuid
      order by e.enrolled_at desc, e.id desc
      limit 1
    ) newest
    join call_plans p on p.enrollment_id = newest.id and p.org_id = ${i.orgId}::uuid and p.status = 'approved'
    order by p.version desc
    limit 1`);
  const stored = rows<{ plan: unknown }>(result)[0]?.plan;
  if (stored === undefined) return null;
  const plan = EditableCallPlan.safeParse(stored);
  if (!plan.success) return null;
  const rendered = renderPlanForAgent(plan.data, i.now);
  return rendered.ok ? rendered.text : null;
}

/**
 * The three reads run one after another, never at once: the reply handler calls this inside its transaction, on one pg
 * client, and a client takes one query at a time (concurrent calls are deprecated in pg 8 and refused in pg 9).
 */
export async function loadWriterContext(
  db: Db,
  i: { orgId: string; crmRecordId: string; conversationId: string | null; now: Date; companyName: string },
): Promise<Omit<WriterInput, 'mode' | 'inbound'>> {
  const r = schema.crmRecords;
  const [record] = await db
    .select({ name: r.name, phones: r.phones })
    .from(r)
    .where(and(eq(r.id, i.crmRecordId), eq(r.orgId, i.orgId)));
  const planText = await approvedPlanText(db, i);
  const timeline = await readTimeline(db, { orgId: i.orgId, crmRecordId: i.crmRecordId, conversationId: i.conversationId });
  return {
    firstName: firstWord(record?.name),
    companyName: i.companyName,
    planText,
    history: historyDigest(timeline, HISTORY_DIGEST_CHARS),
    localTime: localTimeWords(i.now, recipientTimezone(record?.phones[0]?.e164 ?? null)),
  };
}
