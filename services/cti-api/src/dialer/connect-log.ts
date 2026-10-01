/**
 * The bridged-call log, write side (design: docs/superpowers/specs/
 * 2026-10-01-power-dialer-recording-design.md).
 *
 * The engine calls `recordBridgedCall` right after `bridgeToRep` succeeds —
 * never before, so a bridge that failed never becomes a Task for a call that
 * did not happen. Order inside: the row FIRST, then the recording, because the
 * recording's callback is keyed by the row id and must always find its row.
 *
 * Nothing here may break a live call: every recording problem is stamped on
 * the row and logged, never thrown. (A failed row insert does throw — the
 * engine catches and logs it; with no row there is nothing to record into.)
 *
 * The hang-up stamp and the recording URL are written by the dialer's webhooks
 * (routes/dialer.ts) through `stampConnectEnded` / `storeConnectRecording`.
 * salesforce/dialer-connect-worker.ts turns each row into one Call Task.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, schema, type DialerConnectRecordingState } from '@cti/db';

type Db = ReturnType<typeof getDb>;
const c = schema.dialerConnects;

export interface BridgedCall {
  orgId: string;
  userId: string;
  /** The rep's Salesforce user id (dialer_sessions.sf_owner_id). */
  sfUserId: string;
  sessionId: string;
  itemId: string;
  /** The prospect's leg — the call that was just bridged. */
  callSid: string;
  objectType: string;
  recordId: string;
  fromNumber: string | null;
  toNumber: string | null;
}

export interface ConnectLogDeps {
  db: Db;
  now: () => Date;
  /** TWILIO_RECORD_CALLS && DIALER_RECORDING === 'on' (live-deps.ts). */
  recordingEnabled: boolean;
  /** Is the org's default campaign set to the automated two-party disclosure? */
  isTwoParty: (orgId: string) => Promise<boolean>;
  startRecording: (callSid: string, connectId: string) => Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function insertConnect(
  db: Db,
  call: BridgedCall & { fromNumber: string; toNumber: string },
  at: Date,
) {
  return db
    .insert(c)
    .values({
      orgId: call.orgId,
      userId: call.userId,
      sfUserId: call.sfUserId,
      sessionId: call.sessionId,
      itemId: call.itemId,
      callSid: call.callSid,
      objectType: call.objectType,
      recordId: call.recordId,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      bridgedAt: at,
    })
    // BARE on purpose: the call_sid index is full, and a target clause is what
    // turned every insert into 42P10 on the calls table's partial index.
    .onConflictDoNothing()
    .returning({ id: c.id });
}

export function setRecordingState(db: Db, id: string, state: DialerConnectRecordingState, at: Date) {
  return db.update(c).set({ recordingState: state, updatedAt: at }).where(eq(c.id, id));
}

/** The prospect's leg ended: stamp it once. Talk time runs from the bridge. */
export function stampConnectEnded(db: Db, callSid: string, at: Date) {
  const iso = at.toISOString();
  return db
    .update(c)
    .set({
      endedAt: at,
      talkSeconds: sql`greatest(0, round(extract(epoch from (${iso}::timestamptz - ${c.bridgedAt}))))::int`,
      updatedAt: at,
    })
    .where(and(eq(c.callSid, callSid), isNull(c.endedAt)));
}

/**
 * Store a finished recording. Matches the row id AND the call sid: the id is
 * public (it is in the playback link), so an id alone must not be enough to
 * point a row at someone else's audio. A row that already has its Task is
 * pulled forward so the worker attaches the link on its next tick; a row whose
 * Task is still pending keeps its clock — moving it could hand an in-flight
 * Task attempt's lease to a second worker.
 */
export function storeConnectRecording(db: Db, connectId: string, callSid: string, recordingUrl: string, at: Date) {
  return db
    .update(c)
    .set({
      recordingUrl,
      nextAttemptAt: sql`case when ${c.taskState} = 'created' then ${at.toISOString()}::timestamptz else ${c.nextAttemptAt} end`,
      updatedAt: at,
    })
    .where(and(eq(c.id, connectId), eq(c.callSid, callSid)))
    .returning({ id: c.id });
}

/** The same campaign the click-to-dial path reads (routes/telephony.ts). */
export async function orgIsTwoParty(db: Db, orgId: string): Promise<boolean> {
  const campaign = await db.query.campaignConfigs.findFirst({
    where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')),
  });
  return campaign?.recordingConsentMode === 'two_party';
}

async function recordingDecision(orgId: string, connectId: string, deps: ConnectLogDeps): Promise<DialerConnectRecordingState> {
  if (!deps.recordingEnabled) return 'skipped_switch';
  try {
    return (await deps.isTwoParty(orgId)) ? 'skipped_consent' : 'requested';
  } catch (err) {
    console.error('[dialer] consent lookup failed — not recording', { connectId, err: errText(err) });
    return 'skipped_consent';
  }
}

export async function recordBridgedCall(call: BridgedCall, deps: ConnectLogDeps): Promise<void> {
  const { fromNumber, toNumber } = call;
  if (!fromNumber || !toNumber) {
    console.warn('[dialer] bridged call not logged: no number', { itemId: call.itemId });
    return;
  }
  const [row] = await insertConnect(deps.db, { ...call, fromNumber, toNumber }, deps.now());
  if (!row) return; // already logged — a re-delivered AMD "human" for this call
  const decision = await recordingDecision(call.orgId, row.id, deps);
  if (decision !== 'requested') {
    await setRecordingState(deps.db, row.id, decision, deps.now());
    return;
  }
  try {
    await deps.startRecording(call.callSid, row.id);
  } catch (err) {
    console.error('[dialer] recording did not start', { connectId: row.id, err: errText(err) });
    await setRecordingState(deps.db, row.id, 'start_failed', deps.now());
    return;
  }
  await setRecordingState(deps.db, row.id, 'requested', deps.now());
}
