/**
 * The contact-history reads. Two sources, deliberately: the power-dial log
 * (`dialer_dial_attempts`, written by the engine at originate) and the
 * click-to-dial call log (`calls`, direction outbound). A person is matched by
 * any of their numbers OR by record id, so a Lead and the Opportunity it became
 * still read as one person. Every read is bounded by `since` (24 h at most), so
 * each is a few index rows.
 */
import { and, desc, eq, gte, inArray, isNotNull, ne, or, type Column, type SQL } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { Dial, Person } from './contact-history.js';
import { preferredNumber } from './contact-history.js';

type Db = ReturnType<typeof getDb>;

/** Matches a person by any of their numbers on `numberCol`, OR by their
 *  record id on any of `recordCols` — a Lead and the Opportunity it became
 *  still read as one person when the record id lands in either column. */
function personMatch(numberCol: Column, recordCols: readonly Column[], person: Person): SQL | undefined {
  const arms: SQL[] = [];
  if (person.numbers.length) arms.push(inArray(numberCol, [...person.numbers]));
  if (person.recordId) for (const col of recordCols) arms.push(eq(col, person.recordId));
  return arms.length ? or(...arms) : undefined;
}

export async function dialsToPerson(db: Db, orgId: string, person: Person, since: Date): Promise<Dial[]> {
  if (person.numbers.length === 0 && !person.recordId) return [];
  const a = schema.dialerDialAttempts;
  const c = schema.calls;
  const attempts = await db
    .select({ userId: a.userId, sessionId: a.sessionId, toNumber: a.toNumber, at: a.dialedAt, connectedAt: a.connectedAt })
    .from(a)
    .where(and(eq(a.orgId, orgId), personMatch(a.toNumber, [a.recordId], person), gte(a.dialedAt, since)));
  const calls = await db
    .select({ userId: c.userId, normalizedToNumber: c.normalizedToNumber, createdAt: c.createdAt, disposition: c.disposition })
    .from(c)
    .where(and(
      eq(c.orgId, orgId),
      eq(c.direction, 'outbound'),
      personMatch(c.normalizedToNumber, [c.salesforceWhoId, c.salesforceWhatId], person),
      gte(c.createdAt, since),
    ));
  return [
    ...attempts.map((r): Dial => ({ userId: r.userId, sessionId: r.sessionId, toNumber: r.toNumber, at: r.at, connected: r.connectedAt != null, source: 'dialer' })),
    ...calls.filter((r): r is typeof r & { userId: string } => r.userId != null).map((r): Dial => ({ userId: r.userId, sessionId: null, toNumber: r.normalizedToNumber, at: r.createdAt, connected: r.disposition === 'Connected', source: 'manual' })),
  ];
}

/** Is this person ringing or on a call in ANOTHER live run of the org right now?
 *  Takes any handle that can `select` — the engine passes the claim
 *  transaction's `tx`, so the read rides that transaction's pool client. */
export async function inFlightElsewhere(db: Pick<Db, 'select'>, orgId: string, person: Person, sessionId: string): Promise<boolean> {
  const i = schema.dialerQueueItems;
  const s = schema.dialerSessions;
  const arms: SQL[] = [];
  if (person.numbers.length) arms.push(inArray(i.toNumber, [...person.numbers]));
  if (person.recordId) arms.push(eq(i.recordId, person.recordId));
  if (!arms.length) return false;
  const rows = await db
    .select({ id: i.id })
    .from(i)
    .innerJoin(s, eq(s.id, i.sessionId))
    .where(and(eq(s.orgId, orgId), ne(s.id, sessionId), inArray(s.status, ['active', 'paused']), inArray(i.status, ['dialing', 'connected']), or(...arms)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The connect, on the log: the number that reached them is the one to lead with.
 *
 * Scoped to `toNumber`, not just the item: ONE item can own several attempt rows
 * — a true no-answer rolls the same item onto its Phone (engine.ts
 * handleDialOutcome) and that re-dial appends a second row. Stamping by item
 * alone would mark the number that RANG OUT as connected too, which then makes
 * `preferredNumbersFor` pick between two equally-"connected" numbers and tells
 * the cadence history the person answered on a number they never did.
 */
export async function stampConnected(tx: Pick<Db, 'update'>, itemId: string, toNumber: string, at: Date): Promise<void> {
  await tx
    .update(schema.dialerDialAttempts)
    .set({ connectedAt: at })
    .where(and(eq(schema.dialerDialAttempts.itemId, itemId), eq(schema.dialerDialAttempts.toNumber, toNumber)));
}

/** For queue creation: one read for every pair's two numbers → primary → preferred. */
export async function preferredNumbersFor(db: Db, orgId: string, pairs: ReadonlyArray<readonly [string, string]>): Promise<Map<string, string>> {
  if (pairs.length === 0) return new Map();
  const a = schema.dialerDialAttempts;
  const all = [...new Set(pairs.flatMap(([primary, secondary]) => [primary, secondary]))];
  const rows = await db
    .select({ toNumber: a.toNumber, connectedAt: a.connectedAt })
    .from(a)
    .where(and(eq(a.orgId, orgId), inArray(a.toNumber, all), isNotNull(a.connectedAt)))
    .orderBy(desc(a.connectedAt));
  // Defensive: the query already filters to connected_at is not null, but map
  // from connectedAt rather than hardcoding `connected` so a row that somehow
  // arrives without one (a stale mock, a relaxed query) never counts as a connect.
  const dials: Dial[] = rows
    .filter((r): r is typeof r & { connectedAt: Date } => r.connectedAt != null)
    .map((r) => ({ userId: '', sessionId: null, toNumber: r.toNumber, at: r.connectedAt, connected: true, source: 'dialer' }));
  const out = new Map<string, string>();
  for (const [primary, secondary] of pairs) {
    const pref = preferredNumber(dials, [primary, secondary]);
    if (pref) out.set(primary, pref);
  }
  return out;
}
