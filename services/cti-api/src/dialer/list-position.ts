/**
 * Two reps, one list (2026-09-23 ruling, spec §4): creating a run over the
 * SAME Salesforce list view within the last 12h starts the queue right after
 * the furthest position any rep — including the one starting THIS run —
 * reached on it. The records before that spot go to the end, so the list
 * gets worked exactly once per lap instead of every run re-dialing the top.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { getDb } from '@cti/db';
import { schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;

/** The share window: an attempt older than this doesn't count as "still
 *  working this list" — a run from yesterday must not rotate today's. */
export const LIST_SHARE_WINDOW_MS = 12 * 60 * 60_000;

/**
 * Rotate `records` to begin right after `position` (its ORIGINAL index),
 * moving the records before it to the end. `positions[i]` is the ORIGINAL
 * index of `ordered[i]` — what the caller stamps back onto each row as
 * `list_position`, since the queue's own ordinal no longer matches the
 * list's order once rotated. `startedFrom` is the original index the queue
 * now begins at.
 *
 * `position` null, or already at (or past) the last record, leaves the list
 * exactly as given — nothing to start after, or the lap just completed and
 * wraps back to the top.
 */
export function rotateAfter<T>(
  records: readonly T[],
  position: number | null,
): { ordered: T[]; positions: number[]; startedFrom: number } {
  const start = position == null || position + 1 >= records.length ? 0 : position + 1;
  const idx = records.map((_, i) => (start + i) % records.length);
  return { ordered: idx.map((i) => records[i]!), positions: idx, startedFrom: start };
}

/** One rep who has dialed this list view within the share window. */
export interface ListWorker {
  userId: string;
  name: string;
}

/**
 * The furthest `list_position` any rep reached dialing THIS list view in the
 * last `LIST_SHARE_WINDOW_MS`, plus who they were — org-wide, not scoped to
 * one rep, because the whole point is noticing ANOTHER rep's run (or this
 * same rep's own earlier one). `null` when nobody has dialed it in the
 * window: the queue starts at the top, today's behaviour.
 *
 * `workedBy` carries EVERY rep who dialed the list in the window (not just
 * whoever set the furthest position) together with their user id — the
 * confirm line excludes the REQUESTING rep from that list, and that has to
 * match on id, never on display name (two reps can share a name; an id
 * cannot collide).
 *
 * Not fail-open itself — callers each decide what "the read failed" means
 * for them (create-session.ts: no rotation; the GET route: no `workedBy`)
 * and catch at their own call site, the same way `preferredNumbersFor` is
 * caught by `withPreferredNumbers` rather than by itself.
 */
export async function listStartPosition(
  db: Db,
  orgId: string,
  listViewId: string,
  now: Date,
): Promise<{ position: number; workedBy: ListWorker[] } | null> {
  const a = schema.dialerDialAttempts;
  const i = schema.dialerQueueItems;
  const s = schema.dialerSessions;
  const u = schema.users;
  const rows = await db
    .select({ position: sql<number | null>`max(${i.listPosition})`, userId: u.id, name: u.displayName })
    .from(a)
    .innerJoin(i, eq(i.id, a.itemId))
    .innerJoin(s, eq(s.id, a.sessionId))
    .innerJoin(u, eq(u.id, s.userId))
    .where(and(
      eq(s.orgId, orgId),
      eq(s.listViewId, listViewId),
      gte(a.dialedAt, new Date(now.getTime() - LIST_SHARE_WINDOW_MS)),
    ))
    .groupBy(u.id, u.displayName);
  const positions = rows.map((r) => r.position).filter((p): p is number => p != null);
  if (!positions.length) return null;
  return {
    position: Math.max(...positions),
    workedBy: rows.map((r) => ({ userId: r.userId, name: r.name ?? 'Someone' })),
  };
}

/**
 * What GET /dialer/sessions/:id exposes as `listContext`. `total` and
 * `startedFrom` are read from the session's OWN rows — no join, no matter
 * the status. `workedBy` (the one part that needs the grouped join across
 * every session on this list view) is computed ONLY while `status` is
 * `ready`, which is the one moment the confirm block that shows it is even
 * on screen: the panel polls this route every 1-2s for the life of a run, and
 * running that join on every one of those ticks would multiply an
 * org-wide, cross-session query by the poll rate for no reason — an active
 * run never shows the confirm line again. Fails open on a broken read: the
 * display just omits the other-reps line, the same way `create-session.ts`'s
 * `resolveListStartPosition` keeps the RUN itself safe on a broken read.
 */
export async function listContextFor(
  db: Db,
  session: { orgId: string; listViewId: string | null; status: string },
  items: ReadonlyArray<{ attempt: number; ordinal: number; listPosition: number | null; redialOf?: string | null }>,
  requestingUserId: string,
  now: Date = new Date(),
  readShared: typeof listStartPosition = listStartPosition,
): Promise<{ total: number; startedFrom: number; workedBy: string[] } | null> {
  if (!session.listViewId) return null;
  // A redial copy is also excluded, same as an attempt-2 retry: it is a
  // rep-requested extra dial, not part of the queue creation built from the
  // list view (Task 11 fix-round-1 Minor).
  const total = items.filter((it) => it.attempt === 1 && it.redialOf == null).length;
  const first = items.find((it) => it.ordinal === 0);
  const startedFrom = first?.listPosition ?? 0;
  let workedBy: string[] = [];
  if (session.status === 'ready') {
    try {
      const shared = await readShared(db, session.orgId, session.listViewId, now);
      workedBy = shared ? shared.workedBy.filter((w) => w.userId !== requestingUserId).map((w) => w.name) : [];
    } catch (err) {
      console.warn('[list-position] confirm-block lookup failed — showing no workedBy:', (err as Error).message);
    }
  }
  return { total, startedFrom, workedBy };
}
