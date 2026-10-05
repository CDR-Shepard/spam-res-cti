/**
 * The SQL of an AI call's end (Task 7): the transfer-result's status writes,
 * the `calls` row that makes the dialer's caps count the call, the Salesforce
 * Task id, and the stale-row sweep. Builders only — `drizzleAiCallStore`
 * (store.ts) runs them; store-end.test.ts pins the rendered SQL.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;
/** A transaction handle — the same builders run inside `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

const t = schema.aiCalls;
const c = schema.calls;
const touched = { updatedAt: sql`now()` };

/** One `calls` row, as inserted for an AI call. */
export type NewCtiCall = typeof c.$inferInsert;
/** What a not-connected transfer-result found: no transfer to fail, or one on a live / already-finalized row. */
export type TransferFail = 'none' | 'live' | 'ended';

/** The rep answered the transfer: the one write that makes a row `transferred` (also after finalize). */
export const markTransferredQuery = (db: Conn, id: string) =>
  db
    .update(t)
    .set({ status: 'transferred', ...touched })
    .where(and(eq(t.id, id), eq(t.outcome, 'qualified_transferred'), inArray(t.status, ['transferring', 'completed'])))
    .returning({ id: t.id });

/** The transfer rang out. RETURNING ended_at says whether finalize already closed the row. */
export const failTransferQuery = (db: Conn, id: string) =>
  db
    .update(t)
    .set({ outcome: 'transfer_failed', ...touched })
    .where(and(eq(t.id, id), eq(t.outcome, 'qualified_transferred')))
    .returning({ endedAt: t.endedAt });

/** Bare ON CONFLICT DO NOTHING: `calls_provider_call_id_unique` is partial (see routes/inbound.ts). */
export const insertCtiCallQuery = (db: Conn, values: NewCtiCall) =>
  db.insert(c).values(values).onConflictDoNothing().returning({ id: c.id });

export const existingCtiCallQuery = (db: Conn, callSid: string) =>
  db
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.provider, 'twilio'), eq(c.providerCallId, callSid)))
    .limit(1);

export const linkCtiCallQuery = (db: Conn, aiCallId: string, ctiCallId: string) =>
  db
    .update(t)
    .set({ ctiCallId, ...touched })
    .where(and(eq(t.id, aiCallId), isNull(t.ctiCallId)));

export const sfTaskOnAiCallQuery = (db: Conn, aiCallId: string, taskId: string) =>
  db.update(t).set({ sfTaskId: taskId, ...touched }).where(eq(t.id, aiCallId)).returning({ ctiCallId: t.ctiCallId });

export const sfTaskOnCtiCallQuery = (db: Conn, ctiCallId: string, taskId: string) =>
  db
    .update(c)
    .set({ salesforceTaskId: taskId, updatedAt: new Date() })
    .where(and(eq(c.id, ctiCallId), isNull(c.salesforceTaskId)));

/** Unfinished rows the status callback should have closed by now. */
export const staleOpenQuery = (db: Conn, placedBefore: Date, unplacedBefore: Date, limit: number) =>
  db
    .select()
    .from(t)
    .where(
      and(
        isNull(t.endedAt),
        or(
          and(isNotNull(t.callSid), lt(t.createdAt, placedBefore)),
          and(isNull(t.callSid), lt(t.createdAt, unplacedBefore)),
        ),
      ),
    )
    .orderBy(asc(t.createdAt))
    .limit(limit);

/** Insert (or find) the `calls` row and link it to the AI call in ONE transaction, so the cap never counts it twice. */
export async function recordCtiCall(db: Db, aiCallId: string, values: NewCtiCall): Promise<string> {
  return db.transaction(async (tx) => {
    const [inserted] = await insertCtiCallQuery(tx, values);
    let id = inserted?.id;
    if (!id && values.providerCallId) id = (await existingCtiCallQuery(tx, values.providerCallId))[0]?.id;
    if (!id) throw new Error('calls row was neither inserted nor found');
    await linkCtiCallQuery(tx, aiCallId, id);
    return id;
  });
}

export async function setSfTaskId(db: Db, aiCallId: string, taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await sfTaskOnAiCallQuery(tx, aiCallId, taskId);
    if (row?.ctiCallId) await sfTaskOnCtiCallQuery(tx, row.ctiCallId, taskId);
  });
}

export async function failTransfer(db: Db, id: string): Promise<TransferFail> {
  const [row] = await failTransferQuery(db, id);
  if (!row) return 'none';
  return row.endedAt ? 'ended' : 'live';
}
