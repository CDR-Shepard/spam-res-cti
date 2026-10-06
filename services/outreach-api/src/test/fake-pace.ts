/**
 * Stand-ins for the `ai_call.place` tick tests: a scripted CtiClient and a Salesforce client that answers the record, Task and
 * Event reads (`queryAll`), and the appointment offer's User and busy-calendar reads (`query`, plan 1D).
 */
import { createHash } from 'node:crypto';
import type { AiAvailability, InternalAiCallRequest, InternalAiCallResponse } from '@cti/contracts';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import type { BrowserTokenOutcome, CtiClient } from '../ai-calls/cti-client.js';
import { placeDueAiCalls } from '../ai-calls/pace.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { seedAiCall, seedAiCallRequest } from './ai-call-seed.js';
import { seedAiCallCampaign } from './call-plan-seed.js';
import { seedConnection, TEST_FIELD_MAP } from './outreach-fixtures.js';

type Row = Record<string, unknown>;

/** The harness tenant's AI call consent checkbox: the fake record answers `true` unless a test says otherwise. */
export const CONSENT_FIELD = 'AI_Call_Consent__c';

export interface FakeSfState {
  /** Per record id: fields to change on the default Lead row; `null` = Salesforce does not return the record. */
  records: Map<string, Row | null>;
  tasks: Row[];
  events: Row[];
  /** Thrown by every query when set. */
  error: Error | null;
  /** Thrown by the Task and Event queries only when set. */
  activityError: Error | null;
  /** Plan 1D: what the appointment owner list's User query answers. */
  users: Row[];
  /** Plan 1D: the owner's busy Events (the offer's calendar read, not the CF-1 activity check). */
  busy: Row[];
  /** Thrown by the User query only when set. */
  userError: Error | null;
  soql: string[];
}

export function fakePaceSalesforce(): { client: SalesforceClient; state: FakeSfState } {
  const state: FakeSfState = { records: new Map(), tasks: [], events: [], error: null, activityError: null, users: [], busy: [], userError: null, soql: [] };
  const client = {
    async query(q: string): Promise<Row[]> {
      state.soql.push(q);
      if (state.error) throw state.error;
      if (/ FROM User /.test(q)) {
        if (state.userError) throw state.userError;
        return state.users;
      }
      if (/ FROM Event /.test(q)) return state.busy;
      throw new Error(`fakePaceSalesforce: no query route for ${q}`);
    },
    async queryAll(q: string): Promise<Row[]> {
      state.soql.push(q);
      if (state.error) throw state.error;
      if (state.activityError && / FROM (Task|Event) /.test(q)) throw state.activityError;
      if (/ FROM Task /.test(q)) return state.tasks;
      if (/ FROM Event /.test(q)) return state.events;
      const ids = [...q.matchAll(/'([A-Za-z0-9]{15,18})'/g)].map((m) => m[1]!);
      return ids.flatMap((id) => {
        const over = state.records.get(id);
        if (over === null) return [];
        return [{ Id: id, Name: 'Pat Seller', OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-01T12:00:00.000+0000', IsConverted: false, MobilePhone: '+15125550100', DoNotCall: false, [CONSENT_FIELD]: true, ...over }];
      });
    },
  } as unknown as SalesforceClient;
  return { client, state };
}

export interface FakeCti {
  cti: CtiClient;
  requests: InternalAiCallRequest[];
  /**
   * Answers in order; when they run out every trigger is placed. A `blocked`/`placed`/`failed` result writes its ai_calls row.
   * `lostPlaced`: cti-api reserved the key, placed the call and stored `placed` under the key (ai_calls and ai_call_requests
   * rows), but the answer never reached outreach-api (a timeout).
   */
  answers: Array<
    | { result: 'placed' }
    | { result: 'blocked'; reason: string }
    | { result: 'failed'; reason: string; withCall?: boolean }
    | { transport: string }
    | { conflict: true }
    | { lostPlaced: true; createdAt: Date }
    /** `store` mode: cti-api reserved the key and stored this refusal, but the answer never arrived (a timeout). */
    | { lostAnswer: { result: 'blocked'; reason: string } }
    /** `store` mode: cti-api reserved the key and crashed before answering or dialing (a timeout; the row stays unanswered). */
    | { reservedNoAnswer: true }
  >;
  /**
   * Fix 1 (I-2): model cti-api's request store (request-store.ts) in ai_call_requests. A key it holds answers by the body:
   * a different body is a 409, the same body replays the stored answer (or `in_flight` while unanswered). A key it does not
   * hold takes the next scripted answer: a transport failure reserves nothing; any answer is stored with the body's hash.
   */
  store: boolean;
  /** The tick's clock (paceHarness sets it each run): when `store` mode reserves a key. */
  now: Date;
  /** The tick clock at each trigger, in order (beside `requests`). */
  sentAt: Date[];
  /** What `availability()` answers (null: cti-api did not answer); on with no test numbers unless a test says otherwise. */
  available: AiAvailability | null;
  availabilityCalls: number;
  /** Plan 1E: what `browserToken()` answers (a token for the asking user unless a test says otherwise), and each request. */
  token: BrowserTokenOutcome | null;
  tokenRequests: Array<{ orgId: string; userId: string }>;
}

/** A CtiClient that records each request and answers from the script, writing the ai_calls row cti-api would write (its FK needs one). */
export function fakeCti(db: Db): FakeCti {
  const fake: FakeCti = {
    requests: [],
    answers: [],
    available: { available: true, testNumbers: [] },
    availabilityCalls: 0,
    token: null,
    tokenRequests: [],
    store: false,
    now: new Date(0),
    sentAt: [],
    cti: {
      async trigger(req) {
        fake.requests.push(req);
        fake.sentAt.push(fake.now);
        if (fake.store) return storedTrigger(db, fake, req);
        const a = fake.answers.shift() ?? { result: 'placed' as const };
        if ('lostAnswer' in a || 'reservedNoAnswer' in a) throw new Error('fakeCti: this answer needs store mode');
        if ('transport' in a) return { kind: 'transport', error: a.transport };
        if ('conflict' in a) return { kind: 'conflict' };
        if ('lostPlaced' in a) {
          const aiCallId = await seedAiCall(db, req.orgId, req.userId, { status: 'queued', createdAt: a.createdAt, ...seededTarget(req) });
          const response = { result: 'placed', aiCallId } as InternalAiCallResponse;
          await seedAiCallRequest(db, { orgId: req.orgId, key: req.idempotencyKey, userId: req.userId, response, createdAt: a.createdAt });
          return { kind: 'transport', error: 'timeout' };
        }
        if (a.result === 'failed' && !a.withCall) return { kind: 'response', response: { result: 'failed', reason: a.reason, aiCallId: null } as InternalAiCallResponse };
        const status = a.result === 'placed' ? 'queued' : a.result;
        const aiCallId = await seedAiCall(db, req.orgId, req.userId, { status, ...seededTarget(req) });
        const response = a.result === 'placed' ? { result: 'placed', aiCallId } : { ...a, aiCallId };
        return { kind: 'response', response: response as InternalAiCallResponse };
      },
      async availability() {
        fake.availabilityCalls += 1;
        return fake.available;
      },
      async browserToken(req) {
        fake.tokenRequests.push(req);
        return fake.token ?? { kind: 'token', token: 'fake.jwt.token', identity: `aitest_${req.userId.replace(/-/g, '')}_000000000000`, expiresAt: '2030-01-01T00:00:00.000Z' };
      },
    },
  };
  return fake;
}

/** The ai_calls columns cti-api writes for the target: the record's ids; a browser leg (plan 1E) as is_test + practice to client:<identity>. */
function seededTarget(req: InternalAiCallRequest): Partial<typeof schema.aiCalls.$inferInsert> {
  const t = req.target;
  if (t.kind === 'record') return { sfObject: t.objectType, sfRecordId: t.recordId };
  if (t.kind === 'practice_browser') return { sfObject: t.objectType, sfRecordId: t.recordId, toE164: `client:${t.clientIdentity}`, isTest: true, practice: true };
  return {};
}

const bodyHash = (req: InternalAiCallRequest): string => createHash('sha256').update(JSON.stringify({ userId: req.userId, target: req.target })).digest('hex');

/**
 * `store` mode (see FakeCti.store). Not modelled (sweep D-14): cti-api's stale takeover, where a reservation still
 * unanswered after STALE_REQUEST_MS (10 min, a crashed request) and re-sent with the same body is taken over and run
 * again. Here a held key with no answer always reads `in_flight`; a test of the takeover belongs to cti-api
 * (request-store), and the pacer only ever sees one of the answers modelled here.
 */
async function storedTrigger(db: Db, fake: FakeCti, req: InternalAiCallRequest): Promise<Awaited<ReturnType<CtiClient['trigger']>>> {
  const r = schema.aiCallRequests;
  const hash = bodyHash(req);
  const [held] = await db.select().from(r).where(and(eq(r.orgId, req.orgId), eq(r.idempotencyKey, req.idempotencyKey)));
  if (held) {
    if (held.requestHash !== hash) return { kind: 'conflict' };
    const stored = held.response as InternalAiCallResponse | null;
    return { kind: 'response', response: stored ?? { result: 'failed', reason: 'in_flight', aiCallId: null } };
  }
  const a = fake.answers.shift() ?? { result: 'placed' as const };
  if ('transport' in a) return { kind: 'transport', error: a.transport };
  if ('conflict' in a || 'lostPlaced' in a) throw new Error('fakeCti: store mode derives 409s and stored answers itself');
  const target = req.target.kind === 'record' ? { sfObject: req.target.objectType, sfRecordId: req.target.recordId } : {};
  const reserve = (response: InternalAiCallResponse | null) =>
    seedAiCallRequest(db, { orgId: req.orgId, key: req.idempotencyKey, userId: req.userId, response, createdAt: fake.now, hash });
  if ('reservedNoAnswer' in a) {
    await reserve(null);
    return { kind: 'transport', error: 'timeout' };
  }
  const answer = 'lostAnswer' in a ? a.lostAnswer : a;
  const withCall = answer.result !== 'failed' || ('withCall' in answer && answer.withCall);
  const aiCallId = withCall ? await seedAiCall(db, req.orgId, req.userId, { status: answer.result === 'placed' ? 'queued' : answer.result, createdAt: fake.now, ...target }) : null;
  const response = (answer.result === 'placed' ? { result: 'placed', aiCallId } : { result: answer.result, reason: answer.reason, aiCallId }) as InternalAiCallResponse;
  await reserve(response);
  return 'lostAnswer' in a ? { kind: 'transport', error: 'timeout' } : { kind: 'response', response };
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: unknown;
  msg?: string;
}

/**
 * One tenant with an active ai_call campaign and a Salesforce connection, and `run(now)` for one tick. The tick sees every
 * tenant in the test database; any tenant but this one has no Salesforce here (CrmNotConnectedError), so it is skipped.
 */
export async function paceHarness(db: Db, settings: Record<string, unknown> = {}, opts: { defaultSpecialists?: readonly string[] } = {}) {
  const base = await seedAiCallCampaign(db, 'active');
  await db.update(schema.organizations).set({ settings }).where(eq(schema.organizations.id, base.orgId));
  await seedConnection(db, base.orgId, {
    ...TEST_FIELD_MAP,
    Lead: { ...TEST_FIELD_MAP.Lead, skipOnDialer: 'Skip_On_Dialer__c', consent: CONSENT_FIELD },
  });
  const sf = fakePaceSalesforce();
  const cti = fakeCti(db);
  const logs: LogEntry[] = [];
  const log = {
    info: (obj: unknown, msg?: string) => logs.push({ level: 'info', obj, msg }),
    warn: (obj: unknown, msg?: string) => logs.push({ level: 'warn', obj, msg }),
    error: (obj: unknown, msg?: string) => logs.push({ level: 'error', obj, msg }),
  };
  let clientError: Error | null = null;
  const clients = async (orgId: string) => {
    if (orgId !== base.orgId) throw new CrmNotConnectedError();
    if (clientError) throw clientError;
    return sf.client;
  };
  const run = (now: Date) => {
    cti.now = now;
    return placeDueAiCalls({ db, clients, cti: cti.cti, now, log, clock: () => 0, defaultSpecialists: opts.defaultSpecialists ?? [] });
  };
  return {
    base,
    sf,
    cti,
    logs,
    run,
    failClients(err: Error | null) {
      clientError = err;
    },
  };
}
