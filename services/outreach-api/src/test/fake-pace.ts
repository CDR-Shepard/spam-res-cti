/** Stand-ins for the `ai_call.place` tick tests: a scripted CtiClient and a Salesforce client that answers the record, Task and Event reads. */
import type { InternalAiCallRequest, InternalAiCallResponse } from '@cti/contracts';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import type { CtiClient } from '../ai-calls/cti-client.js';
import { placeDueAiCalls } from '../ai-calls/pace.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { seedAiCall } from './ai-call-seed.js';
import { seedAiCallCampaign } from './call-plan-seed.js';
import { seedConnection, TEST_FIELD_MAP } from './outreach-fixtures.js';

type Row = Record<string, unknown>;

export interface FakeSfState {
  /** Per record id: fields to change on the default Lead row; `null` = Salesforce does not return the record. */
  records: Map<string, Row | null>;
  tasks: Row[];
  events: Row[];
  /** Thrown by every query when set. */
  error: Error | null;
  /** Thrown by the Task and Event queries only when set. */
  activityError: Error | null;
  soql: string[];
}

export function fakePaceSalesforce(): { client: SalesforceClient; state: FakeSfState } {
  const state: FakeSfState = { records: new Map(), tasks: [], events: [], error: null, activityError: null, soql: [] };
  const client = {
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
        return [{ Id: id, Name: 'Pat Seller', OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-01T12:00:00.000+0000', IsConverted: false, MobilePhone: '+15125550100', DoNotCall: false, ...over }];
      });
    },
  } as unknown as SalesforceClient;
  return { client, state };
}

export interface FakeCti {
  cti: CtiClient;
  requests: InternalAiCallRequest[];
  /** Answers in order; when they run out every trigger is placed. A `blocked`/`placed`/`failed` result writes its ai_calls row. */
  answers: Array<{ result: 'placed' } | { result: 'blocked'; reason: string } | { result: 'failed'; reason: string; withCall?: boolean } | { transport: string }>;
}

/** A CtiClient that records each request and answers from the script, writing the ai_calls row cti-api would write (its FK needs one). */
export function fakeCti(db: Db): FakeCti {
  const fake: FakeCti = {
    requests: [],
    answers: [],
    cti: {
      async trigger(req) {
        fake.requests.push(req);
        const a = fake.answers.shift() ?? { result: 'placed' as const };
        if ('transport' in a) return { kind: 'transport', error: a.transport };
        if (a.result === 'failed' && !a.withCall) return { kind: 'response', response: { result: 'failed', reason: a.reason, aiCallId: null } as InternalAiCallResponse };
        const status = a.result === 'placed' ? 'queued' : a.result;
        const aiCallId = await seedAiCall(db, req.orgId, req.userId, { status, ...(req.target.kind === 'record' ? { sfObject: req.target.objectType, sfRecordId: req.target.recordId } : {}) });
        const response = a.result === 'placed' ? { result: 'placed', aiCallId } : { ...a, aiCallId };
        return { kind: 'response', response: response as InternalAiCallResponse };
      },
      async availability() {
        return { available: true, testNumbers: [] };
      },
    },
  };
  return fake;
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
export async function paceHarness(db: Db, settings: Record<string, unknown> = {}) {
  const base = await seedAiCallCampaign(db, 'active');
  await db.update(schema.organizations).set({ settings }).where(eq(schema.organizations.id, base.orgId));
  await seedConnection(db, base.orgId, {
    ...TEST_FIELD_MAP,
    Lead: { ...TEST_FIELD_MAP.Lead, skipOnDialer: 'Skip_On_Dialer__c' },
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
  const run = (now: Date) => placeDueAiCalls({ db, clients, cti: cti.cti, now, log, clock: () => 0 });
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
