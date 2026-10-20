/**
 * What a call is told about the seller so far (Task 14): the digest of the seller's REAL conversation timeline (emails,
 * replies, earlier calls; never an admin's practice copy), so Sam on the phone does not repeat herself or ask what the
 * seller already wrote. The same read and digest Sam's email writer uses (email/writer-context.ts), capped at what the
 * trigger's contract carries.
 *
 * Read-only, and never allowed to stop a call: any failure reads as "no history" and the call goes without it. The log
 * line names the touch and the error's name only; the history is seller-written text and is never logged.
 */
import { HISTORY_TEXT_MAX } from '@cti/contracts';
import type { Db } from '@cti/db';
import { historyDigest } from '../conversations/digest.js';
import { realConversation } from '../conversations/seller-view.js';
import { readTimeline } from '../conversations/timeline.js';
import type { RunnerLogger } from '../jobs/boss.js';

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** The history for one touch's call, or null when there is none (or it could not be read). */
export async function callHistory(
  deps: { db: Db; log: RunnerLogger },
  i: { orgId: string; touchId: string; crmRecordId: string },
): Promise<string | null> {
  try {
    const conversation = await realConversation(deps.db, i.orgId, i.crmRecordId);
    const timeline = await readTimeline(deps.db, { orgId: i.orgId, crmRecordId: i.crmRecordId, conversationId: conversation?.id ?? null });
    return historyDigest(timeline, HISTORY_TEXT_MAX) || null;
  } catch (err) {
    deps.log.warn(
      { orgId: i.orgId, touchId: i.touchId, errName: errName(err) },
      "ai_call.place: the seller's history could not be read; the call goes without it",
    );
    return null;
  }
}
