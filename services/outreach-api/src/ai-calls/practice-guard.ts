/**
 * Final review (OUT minor): one practice call at a time per admin, so a double click or a second tab never rings the
 * admin's test phone twice. A start is in flight while its cti-api answer has not come (PRACTICE_PENDING_MS, which also
 * covers an answer lost after cti-api placed the call), or while its call is still live. The call is found by the row's
 * ai_call_id, else by its practice key in ai_call_requests (cti-api links the call to the key when it inserts it).
 *
 * The check and the insert run in one transaction under a per-admin advisory lock, so two starts at once cannot both
 * see "nothing in flight".
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';

/** A start with no cti-api answer blocks the next one this long. */
export const PRACTICE_PENDING_MS = 2 * 60_000;
/** How far back a still-live practice call is looked for (longer than any call lasts). */
const LIVE_LOOKBACK_MS = 60 * 60_000;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const iso = (at: Date): string => at.toISOString();

/** Takes the admin's practice lock for this transaction, then says whether one of their practice calls is in flight. */
export async function lockAndCheckPractice(tx: Tx, orgId: string, userId: string, now: Date): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai_practice:${orgId}:${userId}`}, 0))`);
  const found = await tx.execute(sql`
    select 1
    from ai_practice_calls p
    left join ai_call_requests q on p.ai_call_id is null and q.org_id = p.org_id and q.idempotency_key = p.idempotency_key
    left join ai_calls a on a.id = coalesce(p.ai_call_id, q.ai_call_id) and a.org_id = p.org_id
    where p.org_id = ${orgId}::uuid and p.requested_by = ${userId}::uuid
      and p.created_at > ${iso(new Date(now.getTime() - LIVE_LOOKBACK_MS))}
      and ((p.result is null and q.response is null and p.created_at > ${iso(new Date(now.getTime() - PRACTICE_PENDING_MS))})
        or a.status in ('queued', 'ringing', 'in_progress', 'transferring'))
    limit 1`);
  return (found as unknown as { rows: unknown[] }).rows.length > 0;
}
