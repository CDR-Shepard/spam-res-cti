/**
 * iPhone caller-ID app: pairing, device auth, and the caller-directory feed.
 *
 *  POST   /mobile/pair/start          (softphone session auth) → mint a
 *         6-digit pairing code the rep types into the phone.
 *  POST   /mobile/pair/claim          (no auth, IP rate-limited) → exchange a
 *         still-valid code for a long-lived device token.
 *  GET    /mobile/caller-directory    (device token auth) → the org's
 *         caller-ID directory, paged ascending, deterministic.
 *  POST   /mobile/apns-token          (device token auth) → store the
 *         device's push token for the push fast-follow.
 *  GET    /mobile/devices             (softphone session auth) → the rep's
 *         own paired devices.
 *  DELETE /mobile/devices/:id         (softphone session auth, own devices
 *         only) → revoke a device.
 *
 * Device tokens mirror auth/session.ts's pattern (random token, sha256 hash
 * at rest) but authenticate a PHONE, not a rep — resolveDevice below is the
 * device-token analogue of resolveSession.
 */
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { randomToken, sha256 } from '../crypto.js';

/** 6 random digits, 5-minute TTL, single-use (spec). */
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** Device tokens: 32 random bytes, sha256 hash stored (spec). */
const DEVICE_TOKEN_BYTES = 32;
/** Feed pages of ≤10,000 entries (spec). Exported so `paginate` can be unit
 *  tested with a small injected size without waiting on a 10k-row fixture. */
export const FEED_PAGE_SIZE = 10_000;
/** Pairing-code insert retries on a `codeHash` primary-key collision before
 *  giving up (see pair/start). */
const MAX_CODE_GENERATION_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Claim rate limiter: 3 attempts/min/IP, simple in-process Map (spec), plus a
// global backstop against a spoofed-X-Forwarded-For attack. This app is
// single-instance (see server.ts) — a per-process Map is enough; a
// multi-instance deploy would need a shared store (e.g. Redis) instead.
//
// The per-IP key alone is not a real defense: server.ts sets `trustProxy:
// true`, so `req.ip` is whatever the client's leftmost `X-Forwarded-For`
// entry says — an attacker can mint a fresh one on every request and never
// hit the same bucket twice. Fixing trustProxy's hop-trust is a server.ts
// (app-wide) change outside this route's scope, so instead this route adds
// a GLOBAL backstop (`claimAttemptsGlobal`, below) that isn't keyed by
// anything the caller controls — spoofing X-Forwarded-For cannot split it.
//
// The global backstop counts only FAILED claim attempts (invalid body, or a
// code that doesn't exist / is expired / is already used) — see
// `recordClaimFailureGlobal`. A SUCCESSFUL claim proves the caller already
// had the right code and shouldn't spend shared budget, so any number of
// legitimate concurrent pairings can never themselves trip the backstop and
// lock every rep out — only a sustained flood of failed guesses can. The cap
// (300/min) sits well above any plausible legitimate-mistake burst but still
// bounds worst-case brute-force guessing to a low fraction of the
// 1,000,000-value code space over any one code's 5-minute life, no matter
// how many distinct `X-Forwarded-For` values an attacker cycles through.
//
// Exported so mobile.test.ts can clear them between tests (otherwise
// attempts from one test would bleed into the next via this module state).
// ---------------------------------------------------------------------------
const CLAIM_RATE_LIMIT = 3;
const CLAIM_RATE_WINDOW_MS = 60_000;
export const claimAttemptsByIp = new Map<string, number[]>();

export const CLAIM_RATE_LIMIT_GLOBAL = 300;
export const claimAttemptsGlobal: number[] = [];

/** Sweep timestamps keyed by MAP IDENTITY rather than one shared module
 *  variable, so the periodic full-map sweep below is scoped to whichever
 *  map instance is actually being used — this keeps unit tests that build
 *  their own local Map fully isolated from each other and from the shared
 *  production map, instead of one test's clock silently suppressing the
 *  next test's sweep. */
const lastSweepByMap = new WeakMap<Map<string, number[]>, number>();

/** Not pure — mutates `map` (prunes stale entries, records the new attempt)
 *  as a documented side effect. True when `ip` has room for another claim
 *  attempt right now. Prunes the CURRENT key inline on every call — O(1)
 *  amortized regardless of map size — and sweeps the WHOLE map at most once
 *  per rate-limit window (not on every call), so a Map fed a constant stream
 *  of never-repeated keys — e.g. one spoofed `X-Forwarded-For` per request —
 *  still gets emptied back out once those entries age past the window,
 *  without every request paying an O(map.size) filter+allocate cost that
 *  grows with the very flood it exists to survive. */
export function allowClaimAttempt(map: Map<string, number[]>, ip: string, now: number): boolean {
  const fresh = (map.get(ip) ?? []).filter((t) => now - t < CLAIM_RATE_WINDOW_MS);
  if (fresh.length >= CLAIM_RATE_LIMIT) {
    map.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  map.set(ip, fresh);

  const lastSweep = lastSweepByMap.get(map) ?? 0;
  if (now - lastSweep >= CLAIM_RATE_WINDOW_MS) {
    lastSweepByMap.set(map, now);
    for (const [key, timestamps] of map) {
      const freshEntries = timestamps.filter((t) => now - t < CLAIM_RATE_WINDOW_MS);
      if (freshEntries.length === 0) map.delete(key);
      else map.set(key, freshEntries);
    }
  }
  return true;
}

/** Not pure — prunes stale entries out of `bucket` (mutates it) and reports
 *  whether the global backstop still has room, WITHOUT recording this call
 *  as an attempt. Peek-only by design: merely checking capacity must never
 *  itself consume it — callers record separately, and only for a claim that
 *  actually fails (see `recordClaimFailureGlobal`). */
export function globalBudgetAvailable(bucket: number[], now: number): boolean {
  const fresh = bucket.filter((t) => now - t < CLAIM_RATE_WINDOW_MS);
  bucket.splice(0, bucket.length, ...fresh);
  return bucket.length < CLAIM_RATE_LIMIT_GLOBAL;
}

/** Not pure — mutates `bucket` in place. Records one FAILED claim attempt
 *  against the global backstop (invalid body, or a code that doesn't exist /
 *  is expired / is already used). Never called on a successful claim. */
export function recordClaimFailureGlobal(bucket: number[], now: number): void {
  const fresh = bucket.filter((t) => now - t < CLAIM_RATE_WINDOW_MS);
  fresh.push(now);
  bucket.splice(0, bucket.length, ...fresh);
}

/** Pure — a random 6-digit pairing code, zero-padded ("000000"–"999999"). */
export function generatePairCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Pure — single source of truth for "is this pairing-code row still
 *  claimable": exists, never used, not yet expired. Exactly at `expiresAt` is
 *  treated as expired (no grace window). */
export function pairCodeClaimable(
  row: { usedAt: Date | null; expiresAt: Date } | undefined,
  now: Date,
): boolean {
  return !!row && row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}

/** Pure — the numeric value of an e164's digits, for ascending sort. */
function digitsValue(e164: string): bigint {
  const digits = e164.replace(/\D/g, '');
  return digits ? BigInt(digits) : 0n;
}

/**
 * Pure — ascending by the NUMERIC value of e164, not the text column.
 * `ORDER BY e164` on the raw text is wrong once two numbers have a different
 * digit count: lexicographic comparison comes down to the first differing
 * character, which stops tracking magnitude the moment the strings' lengths
 * diverge (e.g. "+15550000000" < "+25550000" as text, but 15.55 BILLION is
 * not less than 25.55 MILLION). `mergeDirectory` (directory-merge.ts) already
 * sorts the worker's published snapshot this same way, so the feed's order
 * matches what was actually published. Stable for equal keys.
 */
export function sortEntriesByDigits<T extends { e164: string }>(entries: readonly T[]): T[] {
  return entries
    .map((e, i) => ({ e, i, v: digitsValue(e.e164) }))
    .sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.i - b.i))
    .map(({ e }) => e);
}

/** Pure — page window math. `page` is 1-indexed; a page past the end of the
 *  directory (e.g. a stale client polling a directory that just shrank)
 *  comes back empty rather than erroring. pageCount is always ≥1 so an empty
 *  directory still reports one (empty) page. */
export function paginate<T>(
  sorted: readonly T[],
  page: number,
  pageSize: number = FEED_PAGE_SIZE,
): { entries: T[]; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const start = (Math.max(1, page) - 1) * pageSize;
  return { entries: sorted.slice(start, start + pageSize), pageCount };
}

// ---------------------------------------------------------------------------
// Device-token auth — the mobile-device analogue of auth/session.ts's
// resolveSession. The bearer is the device's raw token; a missing/unknown/
// revoked token all resolve to null (401 at the call site).
// ---------------------------------------------------------------------------
async function resolveDevice(
  bearer: string | undefined,
): Promise<{ id: string; userId: string; revokedAt: Date | null } | null> {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  if (!token) return null;
  const db = getDb();
  const row = await db.query.mobileDevices.findFirst({
    where: eq(schema.mobileDevices.tokenHash, sha256(token)),
  });
  if (!row || row.revokedAt) return null;
  return row;
}

const ClaimBody = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  deviceLabel: z.string().trim().min(1).max(120),
});

const ApnsTokenBody = z.object({
  token: z.string().trim().min(1),
});

const FeedQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export async function registerMobileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mobile/pair/start', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });

    const db = getDb();
    const now = new Date();
    // A rep who hits "pair" twice should only ever have ONE live code — prior
    // UNUSED codes of theirs are superseded. Used codes are left alone (across
    // every user): they're already claimed, so keeping them until they expire
    // is harmless and preserves the audit trail. Separately, ANY row (used or
    // not, any user) that has already expired is purged here too — codeHash
    // is the table's PRIMARY KEY with no per-user scoping, so an unreaped row
    // still occupies part of the 1,000,000-value code space forever and its
    // collision odds on the insert below only grow over time. Purging on
    // every pair/start bounds the table to roughly "codes minted in the last
    // five minutes" instead of letting it grow without limit.
    await db
      .delete(schema.mobilePairCodes)
      .where(
        or(
          and(eq(schema.mobilePairCodes.userId, authed.userId), isNull(schema.mobilePairCodes.usedAt)),
          lt(schema.mobilePairCodes.expiresAt, now),
        ),
      );

    const expiresAt = new Date(now.getTime() + PAIR_CODE_TTL_MS);
    // codeHash is the PRIMARY KEY (a shared, global key space — not scoped
    // per user), so a genuine collision with another still-live code is
    // possible even after the purge above. Retry with a freshly generated
    // code instead of letting the unique-violation surface as an unhandled
    // 500; at this table size the loop exits on the first attempt in
    // practice; the cap only guards against a truly pathological run.
    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
      const code = generatePairCode();
      const [inserted] = await db
        .insert(schema.mobilePairCodes)
        .values({ codeHash: sha256(code), userId: authed.userId, expiresAt })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        // The raw code is minted ONLY here, in the response the rep reads
        // off their screen to type into the phone — never logged, never
        // stored.
        return { code, expiresAt: expiresAt.toISOString() };
      }
    }
    req.log.error('mobile_pair_code_generation_exhausted');
    return reply.code(503).send({ error: 'Could not generate a pairing code — try again' });
  });

  app.post('/mobile/pair/claim', async (req, reply) => {
    // Rate-limit BEFORE touching the DB, so brute-forcing codes can't even
    // spend a query per guess once a bucket is exhausted.
    const nowMs = Date.now();
    // Per-IP: spec-mandated 3/min/IP, evaluated on every attempt (success or
    // fail alike) before any DB work.
    if (!allowClaimAttempt(claimAttemptsByIp, req.ip, nowMs)) {
      return reply.code(429).send({ error: 'Too many attempts — try again in a minute' });
    }
    // Global backstop: checked here (not recorded) so a request is never
    // gated by attempts it hasn't made yet — only claims that actually FAIL
    // below record against the shared budget (see the two
    // recordClaimFailureGlobal call sites), so a burst of legitimate
    // successful pairings can never trip it.
    if (!globalBudgetAvailable(claimAttemptsGlobal, nowMs)) {
      return reply.code(429).send({ error: 'Too many attempts — try again in a minute' });
    }

    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) {
      recordClaimFailureGlobal(claimAttemptsGlobal, nowMs);
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const db = getDb();
    const now = new Date();
    const codeHash = sha256(parsed.data.code);
    const row = await db.query.mobilePairCodes.findFirst({ where: eq(schema.mobilePairCodes.codeHash, codeHash) });
    if (!row || !pairCodeClaimable(row, now)) {
      recordClaimFailureGlobal(claimAttemptsGlobal, nowMs);
      return reply.code(401).send({ error: 'Invalid or expired code' });
    }
    // Single-use: mark it claimed before minting the device, so a retried
    // request with the same code (a flaky network) can't mint two devices. A
    // genuinely CONCURRENT double-claim of the same code is a narrow,
    // low-severity race — both callers would already need the correct code —
    // not guarded with an advisory lock the way dialer/handoff-store.ts's
    // supersede is, since the worst outcome is two devices paired off one
    // code, not an authorization bypass.
    await db.update(schema.mobilePairCodes).set({ usedAt: now }).where(eq(schema.mobilePairCodes.codeHash, codeHash));

    const token = randomToken(DEVICE_TOKEN_BYTES);
    await db.insert(schema.mobileDevices).values({
      userId: row.userId,
      tokenHash: sha256(token),
      label: parsed.data.deviceLabel,
    });
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, row.userId) });
    // The raw device token is minted ONLY here — the phone stores it in its
    // keychain and sends it as Bearer on every later request; never logged.
    return { deviceToken: token, user: { displayName: user?.displayName ?? null } };
  });

  app.get('/mobile/caller-directory', async (req, reply) => {
    const device = await resolveDevice(req.headers.authorization);
    if (!device) return reply.code(401).send({ error: 'Unauthorized' });

    const db = getDb();
    // Presence signal for the rep's device list — best-effort, mirroring
    // dialer.ts's session presence stamp: never fail the read over it.
    try {
      await db.update(schema.mobileDevices).set({ lastSeenAt: new Date() }).where(eq(schema.mobileDevices.id, device.id));
    } catch (err) {
      req.log.warn({ err }, 'mobile_device_presence_stamp_failed');
    }

    const query = FeedQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });

    const user = await db.query.users.findFirst({ where: eq(schema.users.id, device.userId) });
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });

    const latest = await db.query.callerDirectoryVersions.findFirst({
      where: eq(schema.callerDirectoryVersions.orgId, user.orgId),
      orderBy: (t, { desc }) => [desc(t.version)],
    });
    const version = latest?.version ?? 0;

    if (query.data.since !== undefined && query.data.since === version) {
      return { version, unchanged: true };
    }
    if (!latest) {
      return { version, page: 1, pageCount: 0, entries: [] };
    }

    // Ordering decision (see the task brief): `callerDirectoryEntries` has no
    // insertion-order id to page by — its primary key is (orgId, version,
    // e164) — and `ORDER BY e164` on the raw text column is WRONG once two
    // numbers have a different digit count (see sortEntriesByDigits). Rather
    // than push a numeric-cast expression into the SQL `ORDER BY` (untestable
    // against this package's fake-DB test style, and one more thing that has
    // to agree with mergeDirectory's own sort), fetch the whole version's
    // rows and sort/page in JS with the SAME comparator the worker already
    // uses to publish the snapshot. A version is capped by ordinary CRM data
    // volume (the worker itself chunks inserts at 1,000 rows) and this only
    // runs on an actual resync — a `since` match short-circuits above — so
    // trading a bit of memory for one obviously-correct, unit-tested sort is
    // the right side of that trade for this feed.
    const rows = await db.query.callerDirectoryEntries.findMany({
      where: and(
        eq(schema.callerDirectoryEntries.orgId, user.orgId),
        eq(schema.callerDirectoryEntries.version, latest.version),
      ),
    });
    const { entries, pageCount } = paginate(sortEntriesByDigits(rows), query.data.page);
    return {
      version,
      page: query.data.page,
      pageCount,
      entries: entries.map((e) => ({ e164: e.e164, label: e.label })),
    };
  });

  app.post('/mobile/apns-token', async (req, reply) => {
    const device = await resolveDevice(req.headers.authorization);
    if (!device) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = ApnsTokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    await db.update(schema.mobileDevices).set({ apnsToken: parsed.data.token }).where(eq(schema.mobileDevices.id, device.id));
    return { ok: true };
  });

  app.get('/mobile/devices', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    // Only the still-active devices — once revoked there is nothing left for
    // the rep to do with the row (revoke isn't reversible), so it drops off
    // the list rather than showing as a dead entry with a disabled button.
    const rows = await db.query.mobileDevices.findMany({
      where: and(eq(schema.mobileDevices.userId, authed.userId), isNull(schema.mobileDevices.revokedAt)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return {
      devices: rows.map((d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt })),
    };
  });

  app.delete('/mobile/devices/:id', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as { id: string };
    const db = getDb();
    // Scoped to the caller in the lookup itself (never leaks another rep's
    // device via a 404-vs-403 timing/response difference) — same shape as
    // dialer.ts's loadOwnedSession.
    const device = await db.query.mobileDevices.findFirst({
      where: and(eq(schema.mobileDevices.id, id), eq(schema.mobileDevices.userId, authed.userId)),
    });
    if (!device) return reply.code(404).send({ error: 'Not found' });
    await db.update(schema.mobileDevices).set({ revokedAt: new Date() }).where(eq(schema.mobileDevices.id, id));
    return { ok: true };
  });
}
