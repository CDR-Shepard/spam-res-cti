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
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
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

/** Page a SOQL query by ascending Id, calling `buildSoql` with the last Id
 *  seen (null on the first page) until a page comes back empty. A page
 *  shorter than PAGE_SIZE does NOT mean the sweep is done — Salesforce's REST
 *  batch size can be smaller than the SOQL LIMIT for wide/relationship
 *  queries (`done: false` with fewer records than requested), so the only
 *  safe stop condition is "the cursor found nothing left to page over". The
 *  cost is one extra empty query per object per sweep. */
async function pageByIdCursor<T extends { Id: string }>(
  deps: SweepDeps,
  userId: string,
  buildSoql: (lastId: string | null) => string,
): Promise<T[]> {
  const out: T[] = [];
  let last: string | null = null;
  for (;;) {
    const rows: T[] = await deps.soqlQuery<T>(userId, buildSoql(last));
    if (rows.length === 0) break;
    out.push(...rows);
    last = rows[rows.length - 1]!.Id;
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
 * hardcoded), and the object itself may not exist in every org. Per the
 * brief, only a PERMANENT "no Deal__c here" signal is tolerated: describe
 * returning 404, or a 200 with no `type === 'phone'` field. Either skips the
 * Deal sweep with exactly one warning — Leads/Opps are swept independently
 * and unaffected. Any OTHER failure — a non-404 error status (5xx, 401/403,
 * ...) or a network error/thrown rejection — is a TRANSIENT condition, not
 * "this org lacks Deal__c", so it propagates instead of being swallowed:
 * `sweepRawEntries` rejects, `buildDirectorySnapshot` publishes nothing for
 * that org this tick, and `runDirectoryTick`'s per-org catch warns and moves
 * on — never a partial snapshot with every Deal-stage contact silently
 * downgraded.
 */
async function sweepDeals(deps: SweepDeps, userId: string): Promise<RawEntry[]> {
  const res = await deps.sfFetch(userId, '/sobjects/Deal__c/describe');
  if (res.status === 404) {
    console.warn('[directory-build] Deal__c describe returned 404; skipping Deal sweep (org has no Deal__c)');
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

  const rows = await pageByIdCursor<Record<string, unknown> & { Id: string }>(deps, userId, (last) =>
    `SELECT Id, Name, ${phoneFields.join(', ')} FROM Deal__c` +
    `${last ? ` WHERE Id > '${soqlEscape(last)}'` : ''} ORDER BY Id LIMIT ${PAGE_SIZE}`);
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
 *  dropped silently. A PERMANENT Deal__c describe outcome (404, or no
 *  phone-type fields) skips Deals only — Leads and Opportunities are
 *  unaffected. A TRANSIENT describe failure instead rejects the whole sweep
 *  (see `sweepDeals`). */
export async function sweepRawEntries(deps: SweepDeps, userId: string): Promise<RawEntry[]> {
  const leads = await sweepLeads(deps, userId);
  const opps = await sweepOpportunities(deps, userId);
  const deals = await sweepDeals(deps, userId);
  return [...leads, ...opps, ...deals];
}

/**
 * Sweep -> merge -> hash -> publish, for one org. Publishing is a version
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
  opts: { orgId: string; userId: string },
  sf: SweepDeps = { soqlQuery, sfFetch },
): Promise<{ version: number; entryCount: number; changed: boolean }> {
  const raw = await sweepRawEntries(sf, opts.userId);
  const merged = mergeDirectory(raw);
  const hash = contentHash(merged);

  const latest = await db.query.callerDirectoryVersions.findFirst({
    where: eq(schema.callerDirectoryVersions.orgId, opts.orgId),
    orderBy: (t, { desc }) => [desc(t.version)],
  });
  if (latest && latest.contentHash === hash) {
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
  for (const target of pickActingUsers(candidates)) {
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

/** Drive from server.ts. Single-flight — a slow tick is never overlapped. */
export function startDirectoryLoop(intervalMs = 1_800_000): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDirectoryTick(getDb())
      .catch((err) => console.error('[directory-build] tick error', err))
      .finally(() => { running = false; });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
