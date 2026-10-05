/**
 * Every read and write of `ai_calls` (plus the AI call's `opt_outs` upsert and
 * hand-off-user lookup), behind one `AiCallStore` interface so the service and
 * routes are tested with an in-memory fake. The query builders are exported
 * so their SQL is pinned by rendering it (store.test.ts) — no database needed.
 *
 * Writes that race a live call are conditional: status moves only out of the
 * states named, `do_not_call` is never overwritten, and finalize is a
 * compare-and-swap on `ended_at is null`.
 */
import { and, desc, eq, inArray, isNotNull, isNull, gte, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import {
  failTransfer,
  markTransferredQuery,
  recordCtiCall,
  setSfTaskId,
  staleOpenQuery,
  type NewCtiCall,
  type TransferFail,
} from './store-end.js';

type Db = ReturnType<typeof getDb>;
const t = schema.aiCalls;

/** One `ai_calls` row (the db package does not re-export its `AiCallRow`). */
export type AiCallRow = typeof t.$inferSelect;

export type AiCallStatus =
  | 'queued'
  | 'ringing'
  | 'in_progress'
  | 'transferring'
  | 'transferred'
  | 'completed'
  | 'failed'
  | 'blocked';

export type AiCallOutcome =
  | 'qualified_transferred'
  | 'qualified_callback'
  | 'not_interested'
  | 'do_not_call'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'wrong_number'
  | 'hung_up'
  | 'transfer_failed'
  | 'blocked'
  | 'other';

export interface TranscriptEntry {
  role: 'agent' | 'caller' | 'system';
  text: string;
  /** ISO 8601. */
  at: string;
}

export type NewAiCall = typeof t.$inferInsert;
export type AiCallPatch = Partial<
  Pick<
    NewAiCall,
    'status' | 'outcome' | 'callSid' | 'fromE164' | 'answeredBy' | 'summary' | 'callbackAt' | 'startedAt' | 'endedAt' | 'sfTaskId'
  >
>;

export interface FinalizeWrite {
  /** Used only when no tool/webhook set an outcome first. */
  derivedOutcome: AiCallOutcome;
  durationSeconds: number | null;
  endedAt: Date;
  answeredBy: string | null;
  /** Twilio's CallSid from the callback: stored only when the row never got one. */
  callSid: string | null;
}

/** Statuses of a call that is still on (or about to be on) the line. */
export const LIVE_STATUSES: readonly AiCallStatus[] = ['queued', 'ringing', 'in_progress', 'transferring'];

export interface AiCallStore {
  insert(values: NewAiCall): Promise<AiCallRow>;
  get(id: string): Promise<AiCallRow | null>;
  getInOrg(orgId: string, id: string): Promise<AiCallRow | null>;
  list(orgId: string, opts: { startedBy?: string; limit: number }): Promise<AiCallRow[]>;
  update(id: string, patch: AiCallPatch): Promise<void>;
  /** Apply `patch` only while the row is live and in one of `from`; true when it moved. */
  updateWhereStatus(id: string, from: readonly AiCallStatus[], patch: AiCallPatch): Promise<boolean>;
  /** Set the outcome (never over `do_not_call`); the summary only when given. */
  setOutcome(id: string, outcome: AiCallOutcome, summary: string | null): Promise<void>;
  /** Replace one outcome with another only if the row still has `from`. */
  replaceOutcome(id: string, from: AiCallOutcome, to: AiCallOutcome): Promise<void>;
  appendSummary(id: string, line: string): Promise<void>;
  appendTranscript(id: string, entries: readonly TranscriptEntry[]): Promise<void>;
  mergeQualification(id: string, fields: Record<string, string>): Promise<void>;
  /** A live row whose call went wrong: status failed, outcome failed unless one is set. */
  markFailed(id: string): Promise<void>;
  /** The CAS end of a call; null when it was already finalized. */
  finalize(id: string, w: FinalizeWrite): Promise<AiCallRow | null>;
  upsertOptOut(orgId: string, e164: string, note: string): Promise<void>;
  /** users.id of the human in `orgId` whose Salesforce user is `sfUserId`. */
  handoffUserFor(orgId: string, sfUserId: string): Promise<string | null>;
  orgName(orgId: string): Promise<string | null>;
  /** Is an AI call to `e164` still live in this org (created since `since`)? */
  activeCallTo(orgId: string, e164: string, since: Date): Promise<boolean>;
  /** Placed AI calls to `e164` since `since` that have no `calls` row yet (so the daily cap counts them). */
  uncountedPlaced(orgId: string, e164: string, since: Date): Promise<number>;
  /** The rep answered the transfer: status `transferred` (a live transferring row, or a just-completed one). */
  markTransferred(id: string): Promise<boolean>;
  /** The transfer did not connect: `qualified_transferred` → `transfer_failed`; says whether finalize already ran. */
  failTransfer(id: string): Promise<TransferFail>;
  /** Insert (or find) the call's `calls` row and set `cti_call_id`, atomically; returns calls.id. */
  recordCtiCall(aiCallId: string, values: NewCtiCall): Promise<string>;
  /** The Salesforce Task id, on ai_calls and on its `calls` row. */
  setSfTaskId(aiCallId: string, taskId: string): Promise<void>;
  /** Unfinished rows: placed ones created before `placedBefore`, never-placed ones before `unplacedBefore`. */
  staleOpen(placedBefore: Date, unplacedBefore: Date, limit: number): Promise<AiCallRow[]>;
}

export type { NewCtiCall, TransferFail } from './store-end.js';

const touched = { updatedAt: sql`now()` };

export const updateQuery = (db: Db, id: string, patch: AiCallPatch) =>
  db.update(t).set({ ...patch, ...touched }).where(eq(t.id, id));

export const updateWhereStatusQuery = (db: Db, id: string, from: readonly AiCallStatus[], patch: AiCallPatch) =>
  db
    .update(t)
    .set({ ...patch, ...touched })
    .where(and(eq(t.id, id), inArray(t.status, [...from]), isNull(t.endedAt)))
    .returning({ id: t.id });

export const setOutcomeQuery = (db: Db, id: string, outcome: AiCallOutcome, summary: string | null) =>
  db
    .update(t)
    .set({
      outcome: sql`case when ${t.outcome} = 'do_not_call' then ${t.outcome} else ${outcome} end`,
      ...(summary !== null ? { summary } : {}),
      ...touched,
    })
    .where(eq(t.id, id));

export const replaceOutcomeQuery = (db: Db, id: string, from: AiCallOutcome, to: AiCallOutcome) =>
  db.update(t).set({ outcome: to, ...touched }).where(and(eq(t.id, id), eq(t.outcome, from)));

export const appendSummaryQuery = (db: Db, id: string, line: string) =>
  db
    .update(t)
    .set({ summary: sql`concat_ws(E'\\n', ${t.summary}, ${line}::text)`, ...touched })
    .where(eq(t.id, id));

export const appendTranscriptQuery = (db: Db, id: string, entries: readonly TranscriptEntry[]) =>
  db
    .update(t)
    .set({ transcript: sql`${t.transcript} || ${JSON.stringify(entries)}::jsonb`, ...touched })
    .where(eq(t.id, id));

export const mergeQualificationQuery = (db: Db, id: string, fields: Record<string, string>) =>
  db
    .update(t)
    .set({ qualification: sql`${t.qualification} || ${JSON.stringify(fields)}::jsonb`, ...touched })
    .where(eq(t.id, id));

export const markFailedQuery = (db: Db, id: string) =>
  db
    .update(t)
    .set({ status: sql`'failed'`, outcome: sql`coalesce(${t.outcome}, 'failed')`, ...touched })
    .where(and(eq(t.id, id), inArray(t.status, [...LIVE_STATUSES]), isNull(t.endedAt)));

export const finalizeQuery = (db: Db, id: string, w: FinalizeWrite) => {
  const final = () => sql`coalesce(${t.outcome}, ${w.derivedOutcome})`;
  return db
    .update(t)
    .set({
      outcome: final(),
      // `transferred` is set ONLY by the transfer-result (the rep answered);
      // finalize keeps it, and never infers it from the outcome.
      status: sql`case when ${t.status} = 'transferred' then 'transferred' when ${final()} = 'failed' then 'failed' else 'completed' end`,
      callSid: sql`coalesce(${t.callSid}, ${w.callSid})`,
      durationSeconds: w.durationSeconds,
      endedAt: w.endedAt,
      answeredBy: sql`coalesce(${t.answeredBy}, ${w.answeredBy})`,
      ...touched,
    })
    .where(and(eq(t.id, id), isNull(t.endedAt)))
    .returning();
};

export const upsertOptOutQuery = (db: Db, orgId: string, e164: string, note: string) =>
  db.insert(schema.optOuts).values({ orgId, e164, source: 'ai_call', note }).onConflictDoNothing();

export const handoffUserQuery = (db: Db, orgId: string, sfUserId: string) =>
  db
    .select({ userId: schema.users.id })
    .from(schema.salesforceConnections)
    .innerJoin(schema.users, eq(schema.users.id, schema.salesforceConnections.userId))
    .where(
      and(
        eq(schema.salesforceConnections.sfUserId, sfUserId),
        eq(schema.users.orgId, orgId),
        eq(schema.users.kind, 'human'),
      ),
    )
    .limit(1);

export const listQuery = (db: Db, orgId: string, opts: { startedBy?: string; limit: number }) =>
  db
    .select()
    .from(t)
    .where(and(eq(t.orgId, orgId), opts.startedBy ? eq(t.startedBy, opts.startedBy) : undefined))
    .orderBy(desc(t.createdAt))
    .limit(opts.limit);

export const activeCallToQuery = (db: Db, orgId: string, e164: string, since: Date) =>
  db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.toE164, e164),
        inArray(t.status, [...LIVE_STATUSES]),
        isNull(t.endedAt),
        gte(t.createdAt, since),
      ),
    )
    .limit(1);

export const uncountedPlacedQuery = (db: Db, orgId: string, e164: string, since: Date) =>
  db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.toE164, e164),
        isNotNull(t.callSid),
        isNull(t.ctiCallId),
        gte(t.createdAt, since),
      ),
    );

export function drizzleAiCallStore(db: Db): AiCallStore {
  return {
    async insert(values) {
      const [row] = await db.insert(t).values(values).returning();
      if (!row) throw new Error('ai_calls insert returned no row');
      return row;
    },
    async get(id) {
      const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      return row ?? null;
    },
    async getInOrg(orgId, id) {
      const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.orgId, orgId))).limit(1);
      return row ?? null;
    },
    list: (orgId, opts) => listQuery(db, orgId, opts),
    async update(id, patch) {
      await updateQuery(db, id, patch);
    },
    async updateWhereStatus(id, from, patch) {
      return (await updateWhereStatusQuery(db, id, from, patch)).length > 0;
    },
    async setOutcome(id, outcome, summary) {
      await setOutcomeQuery(db, id, outcome, summary);
    },
    async replaceOutcome(id, from, to) {
      await replaceOutcomeQuery(db, id, from, to);
    },
    async appendSummary(id, line) {
      await appendSummaryQuery(db, id, line);
    },
    async appendTranscript(id, entries) {
      if (entries.length > 0) await appendTranscriptQuery(db, id, entries);
    },
    async mergeQualification(id, fields) {
      if (Object.keys(fields).length > 0) await mergeQualificationQuery(db, id, fields);
    },
    async markFailed(id) {
      await markFailedQuery(db, id);
    },
    async finalize(id, w) {
      const [row] = await finalizeQuery(db, id, w);
      return row ?? null;
    },
    async upsertOptOut(orgId, e164, note) {
      await upsertOptOutQuery(db, orgId, e164, note);
    },
    async handoffUserFor(orgId, sfUserId) {
      const [row] = await handoffUserQuery(db, orgId, sfUserId);
      return row?.userId ?? null;
    },
    async orgName(orgId) {
      const [row] = await db
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);
      return row?.name ?? null;
    },
    async activeCallTo(orgId, e164, since) {
      return (await activeCallToQuery(db, orgId, e164, since)).length > 0;
    },
    async uncountedPlaced(orgId, e164, since) {
      const [row] = await uncountedPlacedQuery(db, orgId, e164, since);
      return row?.n ?? 0;
    },
    async markTransferred(id) {
      return (await markTransferredQuery(db, id)).length > 0;
    },
    failTransfer: (id) => failTransfer(db, id),
    recordCtiCall: (aiCallId, values) => recordCtiCall(db, aiCallId, values),
    setSfTaskId: (aiCallId, taskId) => setSfTaskId(db, aiCallId, taskId),
    staleOpen: (placedBefore, unplacedBefore, limit) => staleOpenQuery(db, placedBefore, unplacedBefore, limit),
  };
}
