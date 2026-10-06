/**
 * Service-to-service AI call trigger (plan 1C). Reachable only on Railway's private network,
 * HMAC-signed by outreach-api, idempotent per key (internal-auth.ts, request-store.ts).
 *
 *   POST /internal/ai-calls               place (or refuse) one AI call
 *   GET  /internal/ai-calls/availability  is AI calling on; the admin test numbers
 *
 * Everything the engine checks for a rep's call it checks here too: gateAiCall runs inside
 * startAiCall, unchanged (consent read fresh from Salesforce, opt-outs, block list, federal
 * DNC, state caps, the per-customer ceiling, calling hours, the ai_pool caller ID). The record
 * is loaded through the tenant's integration connection, and the plan text must pass the
 * CF-9 check or the call is refused as `plan_rejected` before anything is reserved or dialed.
 *
 * Plan 1D: a record target may carry `slots` (appointment times, structured, never plan text) and
 * `context.returning`; a `practice` target rings an admin's test number with a real record's plan and
 * context (service-target.ts). Every switch on the target kind below is explicit (D-2).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AiCallBlockReason,
  INTERNAL_AI_AVAILABILITY_PATH,
  INTERNAL_AI_CALLS_PATH,
  InternalAiCallRequest,
  InternalAiCallResponse,
  agentPlanTextIssues,
  type AiAvailability,
  type AiCallFailReason,
} from '@cti/contracts';
import type { SessionUser } from '@cti/auth';
import { toE164 } from '@cti/phone';
import { aiVoiceAvailable, loadConfig, parseTestNumbers, type AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import type { BridgeLog } from './bridge.js';
import { checkInternalRequest, checkInternalTransport, INTERNAL_RATE_MAX } from './internal-auth.js';
import type { AiCallRecord } from './record.js';
import { requestHash, STALE_REQUEST_MS, type AiCallRequestRow, type AiCallRequestStore, type CallLookup, type FoundCall } from './request-store.js';
import type { StartDeps, StartInput, StartResult } from './service.js';

export interface InternalAiDeps {
  db: () => Db;
  cfg?: () => AppConfig;
  now: () => Date;
  requests: AiCallRequestStore;
  session: (db: Db, orgId: string, userId: string) => Promise<SessionUser | null>;
  loadIntegrationRecord: (db: Db, orgId: string, objectType: 'Lead' | 'Opportunity', recordId: string) => Promise<AiCallRecord | null>;
  start: (i: StartInput) => Promise<StartResult>;
  startDeps: Omit<StartDeps, 'loadRecord'>;
  log: BridgeLog;
}

type RawRequest = FastifyRequest & { rawBody?: string };
type Body = InternalAiCallRequest;

const BLOCK_REASONS: ReadonlySet<string> = new Set(AiCallBlockReason.options);
const BODY_LIMIT = 32 * 1024;
/** A crashed request's ai_calls row may predate its reservation by a little clock skew. */
const FIND_SLACK_MS = 5_000;

const failed = (reason: AiCallFailReason, aiCallId: string | null = null): InternalAiCallResponse => ({ result: 'failed', reason, aiCallId });

export function toInternalResponse(r: StartResult): InternalAiCallResponse {
  if (r.ok) return { result: 'placed', aiCallId: r.aiCallId };
  if (BLOCK_REASONS.has(r.reason) && 'aiCallId' in r) return { result: 'blocked', reason: r.reason as AiCallBlockReason, aiCallId: r.aiCallId };
  return failed(r.reason as AiCallFailReason, 'aiCallId' in r ? r.aiCallId : null);
}

/** The answer a crashed request would have given, from the ai_calls row it left. Never "not placed" unless sure. */
function rebuilt(row: FoundCall): InternalAiCallResponse {
  if (row.status === 'blocked' && row.blockReason && BLOCK_REASONS.has(row.blockReason)) {
    return { result: 'blocked', reason: row.blockReason as AiCallBlockReason, aiCallId: row.id };
  }
  if (row.status === 'failed' && row.callSid === null) return failed('twilio_error', row.id);
  return { result: 'placed', aiCallId: row.id };
}

/** How a crashed request's call is found again: by the record for a record call; by the number it rang otherwise. */
function targetKeys(body: Body): Pick<CallLookup, 'sfRecordId' | 'toE164' | 'kind'> {
  const t = body.target;
  switch (t.kind) {
    case 'record':
      return { sfRecordId: t.recordId, toE164: null, kind: 'record' };
    case 'test':
    case 'practice':
      // A practice call rings the admin's test number (its row also carries the record id, but so may a real call's).
      return { sfRecordId: null, toE164: toE164(t.to) ?? t.to.slice(0, 20), kind: t.kind };
  }
}

/** The service's target, and the plan 1D extras (slots and the returning flag) for record and practice calls. */
function startTarget(t: Body['target']): Pick<StartInput, 'target' | 'slots' | 'returning'> {
  switch (t.kind) {
    case 'record':
      return { target: { objectType: t.objectType, recordId: t.recordId }, slots: t.slots, returning: t.context?.returning ?? false };
    case 'practice':
      return {
        target: { practice: { objectType: t.objectType, recordId: t.recordId, to: t.to } },
        slots: t.slots,
        returning: t.context?.returning ?? false,
      };
    case 'test':
      return { target: { testTo: t.to } };
  }
}

/** Raw JSON for this scope only: the signature covers the exact bytes. */
function rawJsonParser(req: FastifyRequest, body: string | Buffer, done: (err: Error | null, value?: unknown) => void): void {
  (req as RawRequest).rawBody = body as string;
  try {
    done(null, JSON.parse(body as string));
  } catch {
    done(Object.assign(new Error('invalid_body'), { statusCode: 400 }), undefined);
  }
}

export async function registerInternalAiCallRoutes(app: FastifyInstance, deps: InternalAiDeps): Promise<void> {
  const cfgOf = deps.cfg ?? loadConfig;
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT }, rawJsonParser);
    scope.setErrorHandler(async (err, _req, reply) => {
      if (err.statusCode === 400) return reply.code(400).send({ error: 'invalid_body' });
      deps.log.error({ err: err.message }, 'ai-voice internal: request failed');
      return reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: 'internal_error' });
    });
    // Secret, host and Origin need no body: refuse before it is read.
    scope.addHook('onRequest', async (req, reply) => {
      const guard = checkInternalTransport(req.headers, cfgOf());
      if (guard.ok) return;
      // A 404 is the framework's own not-found reply: byte for byte what a route that does not exist answers (S-4).
      if (guard.status === 404) return reply.callNotFound();
      return reply.code(guard.status).send({ error: guard.error });
    });
    scope.addHook('preHandler', async (req, reply) => {
      const raw = (req as RawRequest).rawBody ?? '';
      const guard = checkInternalRequest({ method: req.method, url: req.url, headers: req.headers, rawBody: raw }, cfgOf(), deps.now());
      if (guard.ok) return;
      if (guard.status === 401) deps.log.warn({ url: req.url, reason: guard.reason }, 'ai-voice internal: signature refused');
      return reply.code(guard.status).send({ error: guard.error });
    });
    const rateLimit = { max: INTERNAL_RATE_MAX, timeWindow: '1 minute', keyGenerator: () => 'internal-outreach' };

    scope.get(INTERNAL_AI_AVAILABILITY_PATH, { config: { rateLimit } }, async (): Promise<AiAvailability> => {
      const cfg = cfgOf();
      return { available: aiVoiceAvailable(cfg), testNumbers: [...parseTestNumbers(cfg.AI_VOICE_TEST_NUMBERS)] };
    });

    scope.post(INTERNAL_AI_CALLS_PATH, { config: { rateLimit } }, async (req, reply) => {
      const parsed = InternalAiCallRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const answer = await handleTrigger(deps, cfgOf, parsed.data, requestHash((req as RawRequest).rawBody ?? ''));
      return 'conflict' in answer ? reply.code(409).send({ error: 'idempotency_conflict' }) : answer;
    });
  });
}

type Outcome = InternalAiCallResponse | { conflict: true };

async function handleTrigger(deps: InternalAiDeps, cfgOf: () => AppConfig, body: Body, hash: string): Promise<Outcome> {
  const planText = body.target.planText;
  const issues = planText === null ? [] : agentPlanTextIssues(planText, { singleLine: false });
  if (issues.length > 0) {
    // CF-9: never sent to the agent. Deterministic, so nothing is reserved; the codes are logged, never the text.
    deps.log.warn({ orgId: body.orgId, issues }, 'ai-voice internal: plan rejected');
    return failed('plan_rejected');
  }
  const db = deps.db();
  const session = await deps.session(db, body.orgId, body.userId);
  if (!session) return failed('unknown_user');

  const key = { orgId: body.orgId, key: body.idempotencyKey, hash, userId: body.userId };
  const reserved = await deps.requests.reserve(key);
  if (reserved.kind === 'existing') {
    const row = reserved.row;
    if (row.requestHash !== hash) return { conflict: true };
    if (row.response) return InternalAiCallResponse.parse(row.response);
    // Stale = not reserved or taken over (updated_at) for STALE_REQUEST_MS. created_at is never restamped (M-A).
    if (deps.now().getTime() - row.updatedAt.getTime() < STALE_REQUEST_MS) return failed('in_flight');
    // Take the reservation over FIRST, then look for a call since the ORIGINAL reservation (created_at): a call the original
    // request inserted up to the takeover is seen, where looking first and taking over second could miss one inserted in
    // between. The takeover stamps only updated_at, so if this lookup throws or the process dies here, the next retry still
    // searches from the original reservation and finds that call instead of dialing a second time. One atomic UPDATE
    // decides who retries; any other concurrent retry answers in_flight (S-3).
    if (!(await deps.requests.takeOver(body.orgId, body.idempotencyKey))) return failed('in_flight');
    const found = await crashedCall(deps, body, row);
    if (found) {
      const answer = rebuilt(found);
      await deps.requests.complete(body.orgId, body.idempotencyKey, answer);
      return answer;
    }
  }
  const answer = await startReserved(deps, cfgOf, db, session, body);
  await deps.requests.complete(body.orgId, body.idempotencyKey, answer);
  return answer;
}

/**
 * The call a crashed request left. Its own call, linked to the key the moment it was inserted (final review m3), is exact.
 * A reservation with no link falls back to the lookup by record or number for record and test keys (a request reserved
 * before links existed); a practice key never does, so a newer practice call to the same test number is never adopted.
 */
async function crashedCall(deps: InternalAiDeps, body: Body, row: AiCallRequestRow): Promise<FoundCall | null> {
  if (row.aiCallId) return deps.requests.findCall(body.orgId, body.userId, row.aiCallId);
  if (body.target.kind === 'practice') return null;
  return deps.requests.findCallSince({
    orgId: body.orgId, userId: body.userId, since: new Date(row.createdAt.getTime() - FIND_SLACK_MS), ...targetKeys(body),
  });
}

/** The call store, with every inserted call linked to this request's key before anything is dialed (m3). Never throws on a failed link. */
function linkingStore(deps: InternalAiDeps, body: Body): StartDeps['store'] {
  const store = deps.startDeps.store;
  const linked: StartDeps['store'] = Object.create(store);
  linked.insert = async (values) => {
    const row = await store.insert(values);
    await deps.requests.linkCall(body.orgId, body.idempotencyKey, row.id).catch((e: unknown) =>
      deps.log.warn({ aiCallId: row.id, err: e instanceof Error ? e.message : String(e) }, 'ai-voice internal: could not link the call to its key'),
    );
    return row;
  };
  return linked;
}

/**
 * startAiCall turns Salesforce, gate and Twilio errors into results, so an exception is rare, but it can come after Twilio
 * took the call. It propagates (a 500) and the reservation is KEPT (S-6): a retry meets in_flight, and once the
 * reservation is stale the retry takes it over and then looks (from the original created_at) for the call this request
 * left, so a call is never placed twice.
 */
async function startReserved(deps: InternalAiDeps, cfgOf: () => AppConfig, db: Db, session: SessionUser, body: Body): Promise<InternalAiCallResponse> {
  const t = body.target;
  const result = await deps.start({
    db,
    cfg: cfgOf(),
    session,
    ...startTarget(t),
    plan: t.planText,
    deps: {
      ...deps.startDeps,
      store: linkingStore(deps, body),
      // The tenant's integration connection, never the approver's own Salesforce token.
      loadRecord: (_userId, objectType, recordId) => deps.loadIntegrationRecord(db, body.orgId, objectType as 'Lead' | 'Opportunity', recordId),
    },
  });
  return toInternalResponse(result);
}
