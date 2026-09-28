/**
 * Two reps, one list (2026-09-23 ruling, spec §4; frontier rule corrected by
 * review I1, 2026-09-28): creating a run over the SAME Salesforce list view
 * within the last 12h starts the queue right after the position of the MOST
 * RECENT dial on it — including one from THIS same rep's earlier run. The
 * records before that spot go to the end, so the list gets worked exactly
 * once per lap instead of every run re-dialing the top.
 *
 * I1: the position must come from the MOST RECENT dial, not the highest
 * position ever reached in the window. A `max(list_position)` aggregate is
 * sticky — once any dial anywhere in the window ever touches a high position
 * (a full-list run, or a limited run that happened to land near the end), that
 * high-water mark outlives it for the rest of the 12h window, so every later
 * run wraps back to the top even while an untouched middle segment is still
 * waiting for its turn. Ordering by `dialed_at` instead tracks the ACTUAL
 * current frontier — whichever rep dialed most recently — which is what "two
 * reps work the list together" was always meant to mean.
 *
 * I1 follow-up (final review, 2026-09-28): the start is anchored on that
 * dial's RECORD, not its index. A position is an index into the list AS IT
 * WAS FETCHED for that run; a Task view that hides completed tasks loses every
 * task the run rolled, so the next fetch is shorter and the old index lands
 * past where the run really stopped (80 of the first 100 rolled → the next run
 * began at #180, not #100). `listRunStart` reads the anchor record plus that
 * same run's records below it, and `listStartIndex` finds the first of them
 * still in the FRESH list and starts right after it.
 */
import { and, desc, eq, gte, isNotNull, lt, type SQL } from 'drizzle-orm';
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
 * A queue row's identity IN THE LIST VIEW — the id the view itself returns,
 * which is what `createDialerSession`'s `recordIds` holds. A Lead/Opportunity
 * row dials the record itself, so that's `record_id`. A Task run's row dials
 * the Task's PERSON (`record_id` is a Lead/Contact/Opportunity) and carries the
 * Task on `task_id` — and the Task is what a Task view lists. Keyed on the
 * SESSION's object type, never the row's own (a Task run's rows are 'Lead',
 * 'Contact', 'Opportunity', or 'Task' only when unresolvable). A Task row with
 * no task id has no key: its person id is never in a Task view.
 */
export function listRecordKey(
  sessionObjectType: string,
  row: { recordId: string; taskId: string | null },
): string | null {
  return sessionObjectType === 'Task' ? row.taskId : row.recordId;
}

/** Dials on THIS list view, by any rep, inside the share window. */
function listScope(orgId: string, listViewId: string, now: Date): SQL | undefined {
  const a = schema.dialerDialAttempts;
  const s = schema.dialerSessions;
  return and(
    eq(s.orgId, orgId),
    eq(s.listViewId, listViewId),
    gte(a.dialedAt, new Date(now.getTime() - LIST_SHARE_WINDOW_MS)),
  );
}

/**
 * The frontier: the MOST RECENT dial in the window (I1) — `dialed_at DESC`,
 * then `id DESC` as a stable tiebreak so two dials in the same instant still
 * resolve to one deterministic row — with the run that made it, that run's
 * object type, and the row's record and task ids (its identity in the list,
 * `listRecordKey`). `list_position IS NOT NULL` mirrors the old MAX read's
 * null filter: a row with no stamped position (an end-of-run retry, a run
 * with no list view) was never part of a list-view build and cannot anchor.
 */
export function listFrontierQuery(db: Pick<Db, 'select'>, orgId: string, listViewId: string, now: Date) {
  const a = schema.dialerDialAttempts;
  const i = schema.dialerQueueItems;
  const s = schema.dialerSessions;
  return db
    .select({ position: i.listPosition, sessionId: s.id, objectType: s.objectType, recordId: i.recordId, taskId: i.taskId })
    .from(a)
    .innerJoin(i, eq(i.id, a.itemId))
    .innerJoin(s, eq(s.id, a.sessionId))
    .where(and(listScope(orgId, listViewId, now), isNotNull(i.listPosition)))
    .orderBy(desc(a.dialedAt), desc(a.id))
    .limit(1);
}

/** The run whose dial is the frontier, and that dial's record in the list. */
export interface ListAnchor {
  sessionId: string;
  objectType: string;
  /** `listRecordKey` of the dialed row. */
  key: string | null;
}

async function readFrontier(
  db: Pick<Db, 'select'>,
  orgId: string,
  listViewId: string,
  now: Date,
): Promise<{ position: number; anchor: ListAnchor } | null> {
  const [row] = await listFrontierQuery(db, orgId, listViewId, now);
  if (!row || row.position == null) return null;
  return {
    position: row.position,
    anchor: { sessionId: row.sessionId, objectType: row.objectType, key: listRecordKey(row.objectType, row) },
  };
}

/**
 * The MOST RECENT dial any rep made on THIS list view in the last
 * `LIST_SHARE_WINDOW_MS` — its `list_position`, its record (`anchor`), and
 * who has worked the list — org-wide, not scoped to one rep, because the
 * whole point is noticing ANOTHER rep's run (or this same rep's own earlier
 * one). `null` when nobody has dialed it in the window: the queue starts at
 * the top, today's behaviour.
 *
 * `workedBy` carries EVERY rep who dialed the list in the window (not just
 * whoever made the last dial) together with their user id — the confirm line
 * excludes the REQUESTING rep from that list, and that has to match on id,
 * never on display name (two reps can share a name; an id cannot collide).
 *
 * Not fail-open itself — callers each decide what "the read failed" means
 * for them (create-session.ts: no rotation; the GET route: no `workedBy`)
 * and catch at their own call site, the same way `preferredNumbersFor` is
 * caught by `withPreferredNumbers` rather than by itself.
 */
export async function listStartPosition(
  db: Pick<Db, 'select'>,
  orgId: string,
  listViewId: string,
  now: Date,
): Promise<{ position: number; anchor: ListAnchor; workedBy: ListWorker[] } | null> {
  const frontier = await readFrontier(db, orgId, listViewId, now);
  if (!frontier) return null;
  const a = schema.dialerDialAttempts;
  const i = schema.dialerQueueItems;
  const s = schema.dialerSessions;
  const u = schema.users;
  // Who worked it: every rep with a dial in the window, independent of the
  // frontier lookup above — unchanged shape from before this fix.
  const workers = await db
    .select({ userId: u.id, name: u.displayName })
    .from(a)
    .innerJoin(i, eq(i.id, a.itemId))
    .innerJoin(s, eq(s.id, a.sessionId))
    .innerJoin(u, eq(u.id, s.userId))
    .where(listScope(orgId, listViewId, now))
    .groupBy(u.id, u.displayName);
  return {
    ...frontier,
    workedBy: workers.map((r) => ({ userId: r.userId, name: r.name ?? 'Someone' })),
  };
}

/**
 * The anchor run's records strictly BELOW the anchor's position, one per
 * record (a redial or take-callback copy repeats its original's position and
 * record), nearest first. Positions are indices into THAT run's own fetch, so
 * this never mixes in another run's rows. `<` also drops unpositioned rows
 * (an end-of-run retry carries none).
 */
export function listTrailQuery(db: Pick<Db, 'selectDistinct'>, sessionId: string, position: number) {
  const i = schema.dialerQueueItems;
  return db
    .selectDistinct({ position: i.listPosition, recordId: i.recordId, taskId: i.taskId })
    .from(i)
    .where(and(eq(i.sessionId, sessionId), lt(i.listPosition, position)))
    .orderBy(desc(i.listPosition));
}

/** One record of the anchor run, by its position in that run's fetch. */
export interface ListTrailEntry {
  position: number;
  key: string | null;
}

/** What a NEW run needs to decide where it starts (see `listStartIndex`). */
export interface ListRunStart {
  /** `list_position` of the most recent dial — the index fallback. */
  position: number;
  /** That dial's record (`listRecordKey`). */
  key: string | null;
  /** The same run's records below it, nearest first. */
  earlier: ReadonlyArray<ListTrailEntry>;
}

/**
 * The frontier plus the walk `listStartIndex` needs, for `createDialerSession`.
 * Skips the who-worked-it join: run creation never shows it. Not fail-open
 * itself (see `listStartPosition`) — `resolveListStartPosition` catches.
 */
export async function listRunStart(
  db: Pick<Db, 'select' | 'selectDistinct'>,
  orgId: string,
  listViewId: string,
  now: Date,
): Promise<ListRunStart | null> {
  const frontier = await readFrontier(db, orgId, listViewId, now);
  if (!frontier) return null;
  const { anchor, position } = frontier;
  const rows = await listTrailQuery(db, anchor.sessionId, position);
  const earlier = rows
    .filter((r): r is typeof r & { position: number } => r.position != null)
    .map((r) => ({ position: r.position, key: listRecordKey(anchor.objectType, r) }));
  return { position, key: anchor.key, earlier };
}

/**
 * Which index of `recordIds` — the list as fetched NOW — the new run rotates
 * after (`rotateAfter`'s `position`); null = start at the top.
 *
 *  1. The anchor record, wherever it now sits.
 *  2. Gone (rolled out of a Task view, converted, …): the nearest earlier
 *     record of the same run that is still in the list. Everything between it
 *     and the anchor has left too, so the record right after it is the one
 *     the last run would have dialed next.
 *  3. Nothing from that run is still there: the old index, less one slot for
 *     the anchor and one for every earlier record the walk proved gone — each
 *     no longer sits in front of where the run stopped. When the walk named
 *     every record from the top down to the anchor, that is -1: the top. An
 *     anchor with no identity proves nothing, so its index is used as is.
 */
export function listStartIndex(recordIds: readonly string[], start: ListRunStart | null): number | null {
  if (!start) return null;
  for (const key of [start.key, ...start.earlier.map((e) => e.key)]) {
    if (key == null) continue;
    const at = recordIds.indexOf(key);
    if (at !== -1) return at;
  }
  if (start.key == null) return start.position;
  const gone = start.earlier.filter((e) => e.key != null).length;
  const after = start.position - gone - 1;
  return after < 0 ? null : after;
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
  session: { orgId: string; listViewId: string | null; status: string; runSize?: number | null },
  items: ReadonlyArray<{ attempt: number; ordinal: number; listPosition: number | null; redialOf?: string | null }>,
  requestingUserId: string,
  now: Date = new Date(),
  // Only `workedBy` is read here — the anchor is run creation's business.
  readShared: (
    db: Db, orgId: string, listViewId: string, now: Date,
  ) => Promise<{ workedBy: ReadonlyArray<ListWorker> } | null> = listStartPosition,
): Promise<{ total: number; startedFrom: number; workedBy: string[] } | null> {
  if (!session.listViewId) return null;
  // A redial copy is also excluded, same as an attempt-2 retry: it is a
  // rep-requested extra dial, not part of the queue creation built from the
  // list view (Task 11 fix-round-1 Minor).
  //
  // Counted by ORDINAL, not by row (review round 2, Minor #5a — same fix as
  // routes/dialer.ts `firstPassTotal`): a take-callback requeue copy
  // (engine.ts `callbackRequeue`) is an attempt-1, non-redial row that reuses
  // its cancelled original's ordinal, and must not inflate "record N of M".
  //
  // Deliberately NOT `session.runSize` (review R2, reverting M1's override):
  // the web computes "dialing" as this total minus the skip breakdown, and
  // the settled-at-build rows are still in THAT breakdown — swapping in
  // runSize here double-subtracted them, so "first 100" showed "dialing 92"
  // and could go negative. N (the "of N" the run line shows) comes ONLY from
  // `session.runSize` directly; this figure is unrelated to it.
  const total = new Set(items.filter((it) => it.attempt === 1 && it.redialOf == null).map((it) => it.ordinal)).size;
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
