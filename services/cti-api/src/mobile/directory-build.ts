/**
 * Salesforce sweep + versioned snapshot worker for the caller-ID directory.
 *
 * `sweepRawEntries` pulls every phone-bearing Lead, primary Opportunity
 * contact/account, and Deal__c (its describe-discovered phone fields) as
 * `RawEntry` rows; `buildDirectorySnapshot` merges them (directory-merge.ts's
 * stage-precedence rule), hashes the result, and — only when the hash has
 * moved since the last published version — publishes a new
 * caller_directory_versions/entries snapshot atomically. `startDirectoryLoop`
 * drives this on a timer per connected org, the same shape as
 * followup-worker.ts's ticks: warn and move on, never throw, never publish a
 * partial snapshot.
 */
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { normalize } from '@cti/phone';
import { sfFetch, soqlEscape, soqlQuery } from '../salesforce/client.js';
import { contentHash, mergeDirectory, type RawEntry } from './directory-merge.js';

type Db = ReturnType<typeof getDb>;

export interface SweepDeps {
  soqlQuery: typeof soqlQuery;
  sfFetch: typeof sfFetch;
}

/** SOQL LIMIT per page. The client's `soqlQuery` returns a plain array with no
 *  queryMore surface, so every object is paged by Id-cursor batches instead. */
const PAGE_SIZE = 2000;

/** Max rows per `INSERT ... VALUES`. `callerDirectoryEntries` has 5 notNull
 *  columns, so 1000 rows is 5000 bind parameters — comfortably under
 *  Postgres's 65535-parameter statement cap even with room to spare. */
const ENTRY_INSERT_CHUNK_SIZE = 1000;

/** Hard bound on cursor pages per object. At PAGE_SIZE 2000 that is a million
 *  records — far past any real org — so hitting it means the cursor is
 *  malfunctioning, not that the org is large. */
const MAX_CURSOR_PAGES = 500;

/**
 * Hard ceiling on how many entries one published version may carry.
 *
 * This used to be the phone's memory bound: the Call Directory extension
 * decoded the whole JSON snapshot before it could publish anything, costing
 * ~0.5 KB of footprint per entry against an app extension's ~12 MB budget, so
 * 15,000 was the last safe round number. That bound is gone — the extension now
 * STREAMS a binary snapshot in fixed-size chunks (`apps/cti-ios/App/
 * DirectoryStore.swift`), making its footprint O(chunk) rather than
 * O(entries); measured, 250,000 entries stream in single-digit MB.
 *
 * What the ceiling still is: reload-time practicality — CallKit ingests every
 * entry on each `reloadExtension`, and each version bump makes every paired
 * phone re-download the whole feed — plus a safety valve, so a sweep that goes
 * wrong cannot publish an unbounded directory. The live org publishes 149,800,
 * comfortably inside it, so this must NOT fire in normal operation; a warn here
 * means the sweep or the org has changed shape and wants looking at.
 *
 * Truncation keeps the ASCENDING-LOWEST prefix of the already-sorted merge, so
 * the snapshot stays sorted, the feed's page order is unchanged, and the same
 * sweep always yields the same snapshot. The hash is taken AFTER the cap, so
 * churn above the ceiling never bumps the version for a byte-identical
 * published directory.
 *
 * Recorded, with the measurements, in docs/runbooks/caller-id-app.md
 * § "Known limits".
 */
export const MAX_DIRECTORY_ENTRIES = 250_000;

/**
 * A cursor-paging invariant broke: a page whose last row carried no `Id`, a
 * cursor that failed to advance, or the hard page bound. Its own class because
 * `sweepDeals` deliberately swallows Deal-side QUERY failures (an unreadable
 * field the describe still advertised is Deal's problem alone) — but a paging
 * fault is not a "this org has no readable Deals" signal. Swallowed, it would
 * publish a silently Deal-less directory as a NEW version and prune the good
 * one, making the documented fail-safe posture untrue on that path. Rethrown,
 * the org's tick fails, nothing is published, and the next tick tries again.
 */
export class CursorPagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorPagingError';
  }
}

/** Page a SOQL query by ascending Id, calling `buildSoql` with the last Id
 *  seen (null on the first page) until a page comes back empty. A page
 *  shorter than PAGE_SIZE does NOT mean the sweep is done — Salesforce's REST
 *  batch size can be smaller than the SOQL LIMIT for wide/relationship
 *  queries (`done: false` with fewer records than requested), so the only
 *  safe stop condition is "the cursor found nothing left to page over". The
 *  cost is one extra empty query per object per sweep.
 *
 *  Every page must make strict progress. A last row without an `Id` would
 *  otherwise leave the cursor where it was (re-fetching page one forever),
 *  and a cursor that repeats or moves backwards would page the same rows
 *  forever — both of which, in an unattended 30-minute worker, mean an
 *  ever-growing `out` array and a wedged process rather than a failed tick.
 *  So both conditions throw, as does the max-page bound: the tick's catch
 *  turns any of them into one warn, and the next tick tries again. */
async function pageByIdCursor<T extends { Id: string }>(
  deps: SweepDeps,
  userId: string,
  buildSoql: (lastId: string | null) => string,
): Promise<T[]> {
  const out: T[] = [];
  let last: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_CURSOR_PAGES) {
      throw new CursorPagingError(`Id-cursor paging hit the max page bound (${MAX_CURSOR_PAGES}) after ${out.length} rows`);
    }
    const rows: T[] = await deps.soqlQuery<T>(userId, buildSoql(last));
    if (rows.length === 0) break;
    const next = rows[rows.length - 1]!.Id;
    if (typeof next !== 'string' || next === '') {
      throw new CursorPagingError('Id-cursor paging: a page came back with no Id on its last row, so the cursor cannot advance');
    }
    // Salesforce Ids are ASCII and compare case-sensitively, so JS string
    // ordering matches the `ORDER BY Id` / `Id > :last` ordering the query
    // itself relies on. A non-advancing cursor therefore means overlapping or
    // repeated pages, not a collation mismatch.
    if (last !== null && next <= last) {
      throw new CursorPagingError(`Id-cursor paging: the cursor did not advance past '${last}'`);
    }
    out.push(...rows);
    last = next;
  }
  return out;
}

interface LeadRow {
  Id: string;
  Name: string | null;
  Phone: string | null;
  MobilePhone: string | null;
}

async function sweepLeads(deps: SweepDeps, userId: string): Promise<RawEntry[]> {
  const rows = await pageByIdCursor<LeadRow>(deps, userId, (last) =>
    `SELECT Id, Name, Phone, MobilePhone FROM Lead WHERE (Phone != null OR MobilePhone != null)` +
    `${last ? ` AND Id > '${soqlEscape(last)}'` : ''} ORDER BY Id LIMIT ${PAGE_SIZE}`);
  const out: RawEntry[] = [];
  for (const r of rows) {
    const name = r.Name ?? '';
    for (const raw of [r.Phone, r.MobilePhone]) {
      if (!raw) continue;
      const n = normalize(raw);
      if (n.ok && n.value) out.push({ e164: n.value.e164, name, stage: 'lead' });
    }
  }
  return out;
}

interface OpportunityContactRoleRow {
  Id: string;
  Opportunity?: { Name?: string | null; Account?: { Phone?: string | null } | null } | null;
  Contact?: { Phone?: string | null; MobilePhone?: string | null } | null;
}

async function sweepOpportunities(deps: SweepDeps, userId: string): Promise<RawEntry[]> {
  const rows = await pageByIdCursor<OpportunityContactRoleRow>(deps, userId, (last) =>
    `SELECT Id, Opportunity.Name, Contact.Phone, Contact.MobilePhone, Opportunity.Account.Phone ` +
    `FROM OpportunityContactRole WHERE IsPrimary = true` +
    `${last ? ` AND Id > '${soqlEscape(last)}'` : ''} ORDER BY Id LIMIT ${PAGE_SIZE}`);
  const out: RawEntry[] = [];
  for (const r of rows) {
    const name = r.Opportunity?.Name ?? '';
    const phones = [r.Contact?.Phone, r.Contact?.MobilePhone, r.Opportunity?.Account?.Phone];
    for (const raw of phones) {
      if (!raw) continue;
      const n = normalize(raw);
      if (n.ok && n.value) out.push({ e164: n.value.e164, name, stage: 'opp' });
    }
  }
  return out;
}

interface DescribeField {
  name?: string;
  type?: string;
}

/**
 * Deal__c's phone fields are org-specific (discovered via describe, not
 * hardcoded), and the object itself may not exist — or may not be readable —
 * in every org. Deal__c support never breaks the baseline: a PERMANENT
 * Deal-side failure skips Deals with exactly one warning while Leads/Opps
 * publish as usual. Permanent means:
 *   - describe 404 (the org has no Deal__c),
 *   - describe 403 (the acting admin's profile cannot read it — this will not
 *     fix itself on the next tick, and must not stall the org's directory),
 *   - a 200 describe with no `type === 'phone'` field,
 *   - the Deal SOQL query itself failing (e.g. INVALID_FIELD on a field the
 *     describe advertised but the acting user cannot actually read).
 * Any OTHER describe outcome — a 5xx/401, or a network error thrown by
 * `sfFetch` — is TRANSIENT: it propagates, `buildDirectorySnapshot` publishes
 * nothing for that org this tick, and `runDirectoryTick`'s per-org catch
 * warns and moves on. That distinction matters because a transient blip must
 * not silently downgrade every Deal-stage contact in a published snapshot,
 * whereas a permanent condition must not blank the whole sweep forever.
 */
async function sweepDeals(deps: SweepDeps, userId: string): Promise<RawEntry[]> {
  const res = await deps.sfFetch(userId, '/sobjects/Deal__c/describe');
  if (res.status === 404 || res.status === 403) {
    console.warn(`[directory-build] Deal__c describe returned ${res.status}; skipping Deal sweep (org has no readable Deal__c)`);
    return [];
  }
  if (res.status >= 400) {
    // Transient failure — not "no Deal__c here". Rethrow so the whole
    // snapshot aborts for this org this tick rather than publishing without
    // Deals.
    throw new Error(`Deal__c describe failed (${res.status})`);
  }
  const fields = (res.json as { fields?: DescribeField[] } | null)?.fields ?? [];
  const phoneFields = fields
    .filter((f): f is { name: string; type: string } => f.type === 'phone' && typeof f.name === 'string')
    .map((f) => f.name);
  if (phoneFields.length === 0) {
    console.warn('[directory-build] Deal__c has no phone-type fields; skipping Deal sweep');
    return [];
  }

  let rows: Array<Record<string, unknown> & { Id: string }>;
  try {
    rows = await pageByIdCursor<Record<string, unknown> & { Id: string }>(deps, userId, (last) =>
      `SELECT Id, Name, ${phoneFields.join(', ')} FROM Deal__c` +
      `${last ? ` WHERE Id > '${soqlEscape(last)}'` : ''} ORDER BY Id LIMIT ${PAGE_SIZE}`);
  } catch (err) {
    // A cursor-paging fault is NOT "this org has no readable Deals" — it means
    // the sweep never saw all of them. Swallowing it here would publish a
    // silently Deal-less directory as a new version and prune the good one,
    // downgrading every Deal-stage label in the org to Opp/Lead (or to no
    // label at all) with nothing but a warn to show for it. Let it out: the
    // org publishes nothing this tick and tries again on the next.
    if (err instanceof CursorPagingError) throw err;
    // Anything else on the Deal side (an unreadable field the describe still
    // advertised, an INVALID_FIELD) is Deal's problem alone: skip Deals with
    // one warn so Leads and Opportunities still publish.
    console.warn('[directory-build] Deal__c query failed; skipping Deal sweep', { err: (err as Error).message });
    return [];
  }
  const out: RawEntry[] = [];
  for (const r of rows) {
    const name = typeof r.Name === 'string' ? r.Name : '';
    for (const field of phoneFields) {
      const raw = r[field];
      if (typeof raw !== 'string' || !raw) continue;
      const n = normalize(raw);
      if (n.ok && n.value) out.push({ e164: n.value.e164, name, stage: 'deal' });
    }
  }
  return out;
}

/** Sweep every stage source (Lead, primary OpportunityContactRole, Deal__c)
 *  into raw entries. Every phone goes through `normalize`; invalid ones are
 *  dropped silently. A PERMANENT Deal-side failure (describe 404/403, no
 *  phone-type fields, or the Deal query itself failing) skips Deals only —
 *  Leads and Opportunities are unaffected. A TRANSIENT describe failure or a
 *  non-advancing Deal cursor (`CursorPagingError`) instead rejects the whole
 *  sweep, so no Deal-less snapshot is ever published as a new version (see
 *  `sweepDeals`). */
export async function sweepRawEntries(deps: SweepDeps, userId: string): Promise<RawEntry[]> {
  const leads = await sweepLeads(deps, userId);
  const opps = await sweepOpportunities(deps, userId);
  const deals = await sweepDeals(deps, userId);
  return [...leads, ...opps, ...deals];
}

/** Not pure — warns when it truncates. Caps a merged directory at `ceiling` by
 *  keeping the ascending-lowest prefix, so a published version stays inside
 *  what a CallKit reload can practically ingest (see the constant). The
 *  ceiling is a parameter with the production default so the cap's own tests
 *  cost a handful of rows instead of a quarter of a million; every caller in
 *  the app takes `MAX_DIRECTORY_ENTRIES`. Deterministic: the merge is already
 *  sorted, so the same sweep always drops the same tail. */
export function capDirectory<T>(merged: T[], orgId: string, ceiling: number = MAX_DIRECTORY_ENTRIES): T[] {
  if (merged.length <= ceiling) return merged;
  console.warn('[directory-build] directory exceeds the Call Directory publish ceiling; publishing the lowest-numbered entries only', {
    orgId,
    swept: merged.length,
    published: ceiling,
    dropped: merged.length - ceiling,
  });
  return merged.slice(0, ceiling);
}

/**
 * Sweep -> merge -> cap -> hash -> publish, for one org. Publishing is a version
 * bump ONLY when the merged content actually changed: the new hash is
 * compared against the latest `caller_directory_versions` row for the org,
 * and an unchanged hash is a no-op (`changed: false`) — no new rows, nothing
 * pruned.
 *
 * On a change, the new version's entries + its version row are inserted in
 * ONE `db.transaction` (an atomic publish — a client polling mid-write never
 * sees a half-written version), then entry rows older than the PREVIOUS
 * version are pruned (keeping 2 versions of entries: this one and the one
 * before it). The version rows themselves are never pruned — cheap metadata,
 * useful history.
 */
export async function buildDirectorySnapshot(
  db: Db,
  opts: { orgId: string; userId: string; maxEntries?: number },
  sf: SweepDeps = { soqlQuery, sfFetch },
): Promise<{ version: number; entryCount: number; changed: boolean }> {
  const raw = await sweepRawEntries(sf, opts.userId);
  // `maxEntries` exists so the ceiling's own tests can drive this whole
  // pipeline against a handful of rows; production never passes it.
  const merged = capDirectory(mergeDirectory(raw), opts.orgId, opts.maxEntries ?? MAX_DIRECTORY_ENTRIES);
  const hash = contentHash(merged);

  const latest = await db.query.callerDirectoryVersions.findFirst({
    where: eq(schema.callerDirectoryVersions.orgId, opts.orgId),
    orderBy: (t, { desc }) => [desc(t.version)],
  });
  if (latest && latest.contentHash === hash) {
    return { version: latest.version, entryCount: latest.entryCount, changed: false };
  }

  // An empty merged directory on top of a live one is treated as an anomaly,
  // never as "this org now has zero contacts": a sharing-rule change, a
  // half-migrated object, or a Salesforce hiccup that still returned 200s
  // would otherwise blank every rep's caller ID in one unattended tick. Keep
  // the last good version and warn; the next tick republishes the moment the
  // sweep comes back with rows. An empty FIRST build still publishes — there
  // is no directory to blank, and it establishes version 1.
  if (merged.length === 0 && latest) {
    console.warn('[directory-build] sweep produced an empty directory but a published version exists; keeping it', {
      orgId: opts.orgId,
      keptVersion: latest.version,
      keptEntryCount: latest.entryCount,
    });
    return { version: latest.version, entryCount: latest.entryCount, changed: false };
  }

  const version = (latest?.version ?? 0) + 1;
  await db.transaction(async (tx) => {
    // Chunked so an org-wide directory (which can run well past Postgres's
    // 65535 bind-parameter cap as one multi-row INSERT) never fails the
    // publish. Every chunk is still inside this one transaction, so the
    // atomicity guarantee — a reader never sees a half-written version —
    // holds regardless of how many chunks it takes.
    for (let i = 0; i < merged.length; i += ENTRY_INSERT_CHUNK_SIZE) {
      const chunk = merged.slice(i, i + ENTRY_INSERT_CHUNK_SIZE);
      await tx.insert(schema.callerDirectoryEntries).values(
        chunk.map((m) => ({ orgId: opts.orgId, version, e164: m.e164, label: m.label, stage: m.stage })),
      );
    }
    await tx.insert(schema.callerDirectoryVersions).values({
      orgId: opts.orgId,
      version,
      entryCount: merged.length,
      contentHash: hash,
    });
  });

  if (latest) {
    await db.delete(schema.callerDirectoryEntries).where(
      and(eq(schema.callerDirectoryEntries.orgId, opts.orgId), lt(schema.callerDirectoryEntries.version, latest.version)),
    );
  }

  return { version, entryCount: merged.length, changed: true };
}

interface ActingUserCandidate {
  orgId: string;
  userId: string;
  isAdmin: boolean;
}

/** One (org, connected user) pair per tick: the org's connected ADMIN user —
 *  per the brief ("resolves the org's connected admin user"), with NO
 *  fallback to a non-admin connection. An org with no connected admin yields
 *  no acting user this tick (its directory doesn't rebuild until an admin
 *  connects), rather than letting a rep whose sharing rules hide most
 *  records become the source of truth for the whole org's directory.
 *  Deterministic regardless of input row order — if more than one admin is
 *  connected for the same org, the smallest `userId` is picked every time,
 *  so the choice never flips between ticks purely from DB row ordering
 *  (which would otherwise bump the version and prune on ordering noise
 *  alone). Pure so the preference rule is testable without a database. */
export function pickActingUsers(rows: ReadonlyArray<ActingUserCandidate>): Array<{ orgId: string; userId: string }> {
  const byOrg = new Map<string, ActingUserCandidate>();
  for (const r of rows) {
    if (!r.isAdmin) continue;
    const cur = byOrg.get(r.orgId);
    if (!cur || r.userId < cur.userId) byOrg.set(r.orgId, r);
  }
  return [...byOrg.values()].map(({ orgId, userId }) => ({ orgId, userId }));
}

/** Every connected user, for every org that has been through Salesforce
 *  login (sf_org_id set) — same join shape as followup-worker.ts's
 *  `nudgeDueRetries`. */
async function fetchActingUserCandidates(db: Db): Promise<ActingUserCandidate[]> {
  return db
    .select({ orgId: schema.users.orgId, userId: schema.users.id, isAdmin: schema.users.isAdmin })
    .from(schema.salesforceConnections)
    .innerJoin(schema.users, eq(schema.users.id, schema.salesforceConnections.userId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
    .where(isNotNull(schema.organizations.sfOrgId));
}

async function runDirectoryTick(db: Db): Promise<void> {
  const candidates = await fetchActingUserCandidates(db);
  const targets = pickActingUsers(candidates);
  // An org whose only Salesforce connections are non-admins never rebuilds
  // (see `pickActingUsers`). That is deliberate, but it used to be silent —
  // an admin whose token was revoked looked exactly like a healthy org with
  // a stale directory. Say so, once per affected org per tick.
  const covered = new Set(targets.map((t) => t.orgId));
  for (const orgId of new Set(candidates.map((c) => c.orgId))) {
    if (covered.has(orgId)) continue;
    console.warn('[directory-build] org has connected users but no connected admin; skipping its rebuild', { orgId });
  }
  for (const target of targets) {
    try {
      await buildDirectorySnapshot(db, target);
    } catch (err) {
      // One org's Salesforce trouble must not stop the rest, and must never
      // publish a half-built snapshot — buildDirectorySnapshot only writes
      // inside its own transaction, so a throw here means nothing was
      // published for this org this tick.
      console.warn('[directory-build] snapshot failed for org', { orgId: target.orgId, err: (err as Error).message });
    }
  }
}

/**
 * Drive from server.ts. Single-flight — a slow tick is never overlapped —
 * with an immediate kickoff tick so a restart rebuilds now rather than half
 * an hour from now (the shape `startFollowupLoop` uses, plus the kickoff).
 *
 * `dbFactory()` is called INSIDE the async tick body, not before it: a
 * synchronous throw out there (a pool that fails to initialise, a config
 * error) would escape the `.catch(...).finally(...)` chain entirely and leave
 * `running` pinned at true — the worker silently dead for the life of the
 * process. Inside the async body it becomes a rejected promise like any other
 * failure: logged once, flag cleared, tried again next interval. The factory
 * is a parameter only so tests can inject one without a live database.
 */
export function startDirectoryLoop(intervalMs = 1_800_000, dbFactory: () => Db = getDb): NodeJS.Timeout {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void (async () => runDirectoryTick(dbFactory()))()
      .catch((err) => console.error('[directory-build] tick error', err))
      .finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
