/**
 * The AI voice agent's OWN caller-ID pool (`outbound_numbers.kind = 'ai_pool'`).
 *
 * Hard invariant: the AI dials only from an `ai_pool` number — never a rep's
 * `agent` number, never the power dialer's `dialer_pool`, never
 * TWILIO_DEFAULT_CALLER_ID — and no rep path dials from one (they filter on
 * `REP_NUMBER_KINDS`). No AI number free means the call is refused
 * (`no_caller_id`); nothing falls back.
 *
 * The pick reuses the power dialer's safety machinery unchanged
 * (`pickPoolDid` with `kind: 'ai_pool'`): sticky per recipient, then the pool
 * in order, each claim the atomic warmup-cap + 10/min velocity UPDATE pinned to
 * `ai_pool`; plus the shared per-customer ceiling first. The AI's sticky is
 * the number its newest AI call to this person came from (`ai_calls`) — the
 * rep's `sticky_numbers` row is the rep's, and the AI never writes it.
 *
 * Plan 1E: `peekAiCallerId` reads (never claims) the caller ID a browser test
 * leg shows: no phone number is dialed, so no warmup or velocity dial is spent.
 *
 * Also here: who a callback to an AI number rings (routes/inbound.ts and the
 * inbound-text router), from the same `ai_calls` rows.
 */
import { and, desc, eq, gte, isNotNull, notInArray, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import {
  atCeiling,
  customerAttemptState,
  type AttemptState,
  type PickDidResult,
} from '../dialer/pick-agent-did.js';
import { pickPoolDid } from '../dialer/pick-did.js';
import { poolNumbersWhere } from '../dialer/pool.js';

type Db = ReturnType<typeof getDb>;
const t = schema.aiCalls;

/** How far back an AI call still decides who a callback to an AI number rings (the dialer's window). */
export const AI_CALLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface AiPickArgs {
  orgId: string;
  userId: string;
  toE164: string;
}

export interface AiPickDeps {
  attemptState: (db: Db, orgId: string, toE164: string) => Promise<AttemptState>;
  pickPool: typeof pickPoolDid;
  lastFrom: (db: Db, orgId: string, toE164: string) => Promise<string | undefined>;
}

export const lastAiFromQuery = (db: Db, orgId: string, toE164: string) =>
  db
    .select({ fromE164: t.fromE164 })
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.toE164, toE164), isNotNull(t.fromE164)))
    .orderBy(desc(t.createdAt))
    .limit(1);

/** The number the AI last called this person from, if any. Re-read as `ai_pool` before use. */
export async function lastAiFrom(db: Db, orgId: string, toE164: string): Promise<string | undefined> {
  const [row] = await lastAiFromQuery(db, orgId, toE164);
  return row?.fromE164 ?? undefined;
}

const liveDeps: AiPickDeps = { attemptState: customerAttemptState, pickPool: pickPoolDid, lastFrom: lastAiFrom };

/** Ceiling → sticky AI number → the AI pool in order; null when no AI number is claimable. */
export async function pickAiDid(db: Db, args: AiPickArgs, deps: AiPickDeps = liveDeps): Promise<PickDidResult> {
  if (atCeiling(await deps.attemptState(db, args.orgId, args.toE164))) return { skip: 'customer_ceiling' };
  return deps.pickPool(
    db,
    { ...args, kind: 'ai_pool' },
    { stickyE164: () => deps.lastFrom(db, args.orgId, args.toE164) },
  );
}

/**
 * The org's first usable `ai_pool` number, READ ONLY (plan 1E browser tests): the pool listing pickPoolDid walks for
 * `kind = 'ai_pool'` (`poolNumbersWhere`: this org, active, this kind, in the listing's own order) plus the claim's
 * health filter, LIMIT 1, and no claim UPDATE. A browser leg dials no phone number, so no dial is counted against it.
 */
export const peekAiCallerIdQuery = (db: Db, orgId: string) =>
  db
    .select({ e164: schema.outboundNumbers.e164 })
    .from(schema.outboundNumbers)
    .where(and(poolNumbersWhere(orgId, 'ai_pool'), notInArray(schema.outboundNumbers.health, ['spam_likely', 'degraded'])))
    .limit(1);

export async function peekAiCallerId(db: Db, orgId: string): Promise<string | null> {
  const [row] = await peekAiCallerIdQuery(db, orgId);
  return row?.e164 ?? null;
}

/**
 * Who a call (or text) from `callerE164` to the AI number `dialedE164` should
 * reach: the hand-off user (record owner, else the starter) of the newest
 * PLACED AI call to that caller in the last 14 days, preferring calls made
 * from the very number they rang back. Only a human user, so a service
 * account can never be rung.
 */
export const aiCallbackRepQuery = (db: Db, orgId: string, callerE164: string, dialedE164: string, now: Date) =>
  db
    .select({ userId: sql<string>`coalesce(${t.handoffUserId}, ${t.startedBy})` })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.toE164, callerE164),
        isNotNull(t.callSid),
        gte(t.createdAt, new Date(now.getTime() - AI_CALLBACK_WINDOW_MS)),
        sql`exists (select 1 from "users" where "users"."id" = coalesce(${t.handoffUserId}, ${t.startedBy}) and "users"."kind" = ${'human'})`,
      ),
    )
    .orderBy(desc(eq(t.fromE164, dialedE164)), desc(t.createdAt))
    .limit(1);

export async function aiCallbackRep(
  db: Db,
  orgId: string,
  callerE164: string,
  dialedE164: string,
  now: Date = new Date(),
): Promise<string | null> {
  const [row] = await aiCallbackRepQuery(db, orgId, callerE164, dialedE164, now);
  return row?.userId ?? null;
}
