/**
 * iPhone caller-ID app: pairing, device auth, and the caller-directory feed.
 *
 *  POST   /mobile/pair/start          (softphone session auth) → mint a
 *         6-digit pairing code the rep types into the phone.
 *  POST   /mobile/pair/claim          (no auth, IP rate-limited) → exchange a
 *         still-valid code for a long-lived device token.
 *  POST   /mobile/register            (softphone session auth) → mint a
 *         device token directly for a signed-in rep, skipping the pairing
 *         code (the Callsign app already has a session proving who's signed
 *         in).
 *  GET    /mobile/caller-directory    (device token auth) → the org's
 *         caller-ID directory, paged ascending, deterministic.
 *  POST   /mobile/apns-token          (device token auth) → store the
 *         device's push token for the push fast-follow.
 *  POST   /mobile/voip-token          (device token auth) → store the
 *         device's PushKit VoIP token (Callsign incoming-call ring).
 *  GET    /mobile/devices             (softphone session auth) → the rep's
 *         own paired devices.
 *  DELETE /mobile/devices/:id         (softphone session auth, own devices
 *         only) → revoke a device.
 *
 * Device tokens mirror auth/session.ts's pattern (random token, sha256 hash
 * at rest) but authenticate a PHONE, not a rep — resolveDevice below is the
 * device-token analogue of resolveSession. They never expire on their own,
 * so two things bound how many can pile up per user: MAX_ACTIVE_DEVICES_PER_USER
 * caps how many a rep may hold at once (register/claim both 409 at the cap),
 * and revokeDevicesForDeactivatedUser cascades an admin's user-deactivation
 * into revoking every one of them at once (see that function's doc for why a
 * routine web logout must never trigger the same cascade).
 */
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession, revokeAllSessionsForUser } from '@cti/auth';
import { getDb, schema, type Db } from '@cti/db';
import { randomToken, sha256 } from '@cti/auth';

/** 6 random digits, 5-minute TTL, single-use (spec). */
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** Device tokens: 32 random bytes, sha256 hash stored (spec). */
const DEVICE_TOKEN_BYTES = 32;
/**
 * Hard ceiling on how many non-revoked device tokens one user may hold at
 * once. Device tokens never expire (see the module doc), so without a cap
 * every re-install or re-sign-in leaves one more permanently-valid credential
 * behind and the fleet of live tokens only grows. Enforced identically in
 * both places that mint one: POST /mobile/register (a signed-in rep
 * re-registering) and POST /mobile/pair/claim (a fresh pairing). Revoking a
 * device from the softphone's device list (DELETE /mobile/devices/:id) frees
 * a slot.
 */
export const MAX_ACTIVE_DEVICES_PER_USER = 5;
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
// server.ts sets `trustProxy: 1` (trust exactly the one Railway edge hop), so
// `req.ip` is the address that proxy actually observed and a spoofed
// `X-Forwarded-For` cannot move it — the per-IP bucket is a real 3/min cap
// again. It is still not the whole defense: a botnet, or anyone with a pool
// of source addresses, gets three guesses per address. So this route also
// keeps a GLOBAL backstop (`claimAttemptsGlobal`, below) that isn't keyed by
// anything the caller controls at all.
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
// how many distinct source addresses an attacker spreads the guesses over.
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

/** Pure — states the rule the claim's atomic `UPDATE ... WHERE` encodes: a
 *  pairing-code row is claimable only if it exists, was never used, and has
 *  not expired. Exactly at `expiresAt` is treated as expired (no grace
 *  window). The route does NOT evaluate this — enforcing single-use in JS
 *  between a read and a write is exactly the race the atomic claim closes —
 *  it is the executable documentation of what that WHERE clause means, unit
 *  tested here so the rule itself can't drift unnoticed. */
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
    .sort((a, b) => {
      if (a.v !== b.v) return a.v < b.v ? -1 : 1;
      // Two DIFFERENT e164 texts can share one digit value ("+1555…" vs
      // "1555…"). Falling back to input order there would leave paging at the
      // mercy of whatever order the database happened to return the rows in —
      // a client could then see one of the pair twice across two page fetches
      // and the other never. The text tiebreaker makes the total order a
      // function of the data alone.
      if (a.e.e164 !== b.e.e164) return a.e.e164 < b.e.e164 ? -1 : 1;
      return a.i - b.i;
    })
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

/** A fresh device token + the hash we store; the raw token is returned to
 *  the phone once and never persisted. Shared by /mobile/pair/claim and
 *  /mobile/register — both mint the SAME kind of device token, just from
 *  different auth (a pairing code vs. an already-signed-in session). */
function mintDeviceToken(): { raw: string; hash: string } {
  const raw = randomToken(DEVICE_TOKEN_BYTES);
  return { raw, hash: sha256(raw) };
}

/** How many non-revoked device tokens `userId` currently holds — the value
 *  MAX_ACTIVE_DEVICES_PER_USER caps. Shared by /mobile/register and
 *  /mobile/pair/claim so both insert paths enforce the exact same ceiling
 *  the exact same way. Counts by fetching the rows (rather than a SQL
 *  `count(*)`) to match this file's existing `db.query.*.findMany` style —
 *  the row count at this table size is trivially small either way. */
async function countActiveDevices(db: Db, userId: string): Promise<number> {
  const rows = await db.query.mobileDevices.findMany({
    where: and(eq(schema.mobileDevices.userId, userId), isNull(schema.mobileDevices.revokedAt)),
  });
  return rows.length;
}

/**
 * Admin-initiated user deactivation cascade: revoke every one of the user's
 * still-active device tokens, plus (via `revokeAllSessionsForUser`) every
 * live web-softphone session. This is the ONLY event that should ever call
 * this function.
 *
 * A routine web-softphone logout revokes exactly the ONE session the browser
 * tab was holding (`revokeSession(bearer)` in @cti/auth) and must NEVER reach
 * here. The rep's phone is a separate, independent device — signing out of a
 * browser tab must not brick the device token the phone relies on to receive
 * incoming-call pushes and read the caller directory. Only an admin
 * deactivating or removing the user's account should cut off every device
 * and session at once.
 *
 * No admin route in this codebase deactivates or removes a user yet (see the
 * accompanying report) — this is the reusable primitive that route should
 * call once it exists, so the cascade logic isn't duplicated or reinvented
 * at that call site. Exported and unit tested here in isolation.
 *
 * FOLLOW-UP(callsign-followups #1): NOT CALLED from production code yet. No
 * user-deactivation feature exists to invoke it — see
 * docs/superpowers/plans/2026-09-04-callsign-followups.md. Do not read this
 * as a live safeguard: today nothing revokes a departing rep's devices
 * automatically.
 */
export async function revokeDevicesForDeactivatedUser(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.mobileDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.mobileDevices.userId, userId), isNull(schema.mobileDevices.revokedAt)));
  await revokeAllSessionsForUser(userId);
}

const ClaimBody = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  deviceLabel: z.string().trim().min(1).max(120),
});

const RegisterBody = z.object({ deviceLabel: z.string().trim().min(1).max(120) });

const ApnsTokenBody = z.object({
  // APNs device tokens are 64 hex characters today; the cap is deliberately
  // generous room for a future format change while still refusing to persist
  // an unbounded blob a compromised/hostile device could post.
  token: z.string().trim().min(1).max(4096),
});

const VoipTokenBody = z.object({
  // PushKit VoIP tokens are 64 hex characters today. Tighter than ApnsTokenBody
  // on purpose: nothing shorter than 16 is a real token, and 512 leaves room for
  // a format change without accepting an unbounded blob from a hostile device.
  token: z.string().trim().min(16).max(512),
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
    // Global backstop FIRST: checked here (not recorded) so a request is
    // never gated by attempts it hasn't made yet — only claims that actually
    // FAIL below record against the shared budget (see the two
    // recordClaimFailureGlobal call sites), so a burst of legitimate
    // successful pairings can never trip it. Consulting it *before* the
    // per-IP map matters: a flood already being refused globally then can
    // neither grow that map (its keys are attacker-controlled) nor burn a
    // legitimate IP's three slots on requests that were never going to be
    // served anyway.
    if (!globalBudgetAvailable(claimAttemptsGlobal, nowMs)) {
      return reply.code(429).send({ error: 'Too many attempts — try again in a minute' });
    }
    // Per-IP: spec-mandated 3/min/IP, evaluated on every attempt that gets
    // past the backstop (success or fail alike) before any DB work.
    if (!allowClaimAttempt(claimAttemptsByIp, req.ip, nowMs)) {
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
    // SINGLE-USE, enforced by the database in one statement. The whole rule
    // (`pairCodeClaimable`: right hash, never used, not expired) lives in this
    // WHERE, and the row is claimed by the same UPDATE that tests it, so the
    // claim is atomic: of N concurrent requests carrying one leaked code,
    // exactly one gets a row back and the rest get nothing. Reading the row,
    // validating it in JS, and then updating would let all N pass validation
    // inside the gap and silently mint N device tokens off a single code.
    const [claimed] = await db
      .update(schema.mobilePairCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(schema.mobilePairCodes.codeHash, codeHash),
          isNull(schema.mobilePairCodes.usedAt),
          gt(schema.mobilePairCodes.expiresAt, now),
        ),
      )
      .returning();
    if (!claimed) {
      // No row matched: unknown code, already claimed, or expired. All three
      // are one indistinguishable answer to the caller by design.
      recordClaimFailureGlobal(claimAttemptsGlobal, nowMs);
      return reply.code(401).send({ error: 'Invalid or expired code' });
    }

    // Cap checked AFTER the code is claimed (not before): the rule the cap
    // enforces is "insert nothing past the ceiling," and the code being
    // single-use is a separate, already-atomic guarantee above. The tradeoff
    // is that a rep already at the cap burns their one-time code on a claim
    // that gets rejected — the same outcome as the code simply expiring —
    // and must generate a fresh one after freeing a slot. Checking the cap
    // first instead would mean reading the code's owning user before knowing
    // whether the code itself is even valid, which buys nothing (the cap
    // isn't a security invariant like single-use) at the cost of an extra
    // read on every claim attempt.
    if ((await countActiveDevices(db, claimed.userId)) >= MAX_ACTIVE_DEVICES_PER_USER) {
      return reply.code(409).send({ error: 'Too many active devices — revoke one in the app first' });
    }

    const { raw: token, hash: tokenHash } = mintDeviceToken();
    await db.insert(schema.mobileDevices).values({
      userId: claimed.userId,
      tokenHash,
      label: parsed.data.deviceLabel,
    });
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, claimed.userId) });
    // The raw device token is minted ONLY here — the phone stores it in its
    // keychain and sends it as Bearer on every later request; never logged.
    return { deviceToken: token, user: { displayName: user?.displayName ?? null } };
  });

  app.post('/mobile/register', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    if ((await countActiveDevices(db, session.userId)) >= MAX_ACTIVE_DEVICES_PER_USER) {
      return reply.code(409).send({ error: 'Too many active devices — revoke one in the app first' });
    }
    const { raw, hash } = mintDeviceToken();
    const [row] = await db
      .insert(schema.mobileDevices)
      .values({ userId: session.userId, tokenHash: hash, label: parsed.data.deviceLabel })
      .returning({ id: schema.mobileDevices.id });
    if (!row) {
      // Should be unreachable — a plain INSERT either returns the inserted
      // row or throws — but TypeScript can't prove that from `.returning()`'s
      // type alone, so fail loudly instead of dereferencing `undefined`.
      req.log.error({ userId: session.userId }, 'mobile_device_register_insert_returned_no_row');
      return reply.code(500).send({ error: 'Could not register device' });
    }
    req.log.info({ userId: session.userId, deviceId: row.id }, 'mobile device registered via session');
    // Same kind of device token pairing mints — the raw value is returned
    // ONLY here, once, and never persisted or logged.
    return { deviceToken: raw, deviceId: row.id };
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

  app.post('/mobile/voip-token', async (req, reply) => {
    const device = await resolveDevice(req.headers.authorization);
    if (!device) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = VoipTokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    await db.update(schema.mobileDevices).set({ voipToken: parsed.data.token }).where(eq(schema.mobileDevices.id, device.id));
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
