/**
 * Placing an AI call: load the record, gate it, write the `ai_calls` row,
 * dial with `<Connect><Stream>` TwiML, and cache everything the live call
 * needs in the registry (registry.ts). The stream session (stream-session.ts)
 * picks the call up when it is answered; the webhooks (routes.ts) and
 * finalize (service-finalize.ts) take it from there.
 *
 * Nothing is dialed unless `gateAiCall` says so. Its daily-cap count is
 * widened (`aiGateDeps`) to include AI calls already placed that have no
 * `calls` row yet, and a number already on a live AI call is refused, so a
 * double click cannot ring someone twice.
 */
import type { SessionUser } from '@cti/auth';
import { DAILY_CAP_WINDOW_MS, dailyDialCount, timezoneForNumber } from '@cti/firewall';
import { toE164 } from '@cti/phone';
import type { AppConfig } from '../config.js';
import { blockedTargets } from '../dialer/consent-check.js';
import { pickDidForRun } from '../dialer/pick-agent-did.js';
import { withinCallingHours, type Db } from '../dialer/pick-did.js';
import type { BridgeLog } from './bridge.js';
import { gateAiCall, type AiGateBlock, type AiGateInput, type AiGateResult, type GateDeps } from './gate.js';
import type { AiCallObject, AiCallRecord } from './record.js';
import { dropActiveCall, registerActiveCall, updateActiveCall } from './registry.js';
import type { AiCallStore } from './store.js';
import {
  AMD_PATH,
  STATUS_PATH,
  callbackUrl,
  streamToken,
  streamTwiml,
  streamWssUrl,
  type AiVoiceTwilio,
} from './twilio.js';

export { claimClose, dropActiveCall, getActiveCall, registerActiveCall, type ActiveAiCall } from './registry.js';

export type StartTarget = { objectType: AiCallObject; recordId: string } | { testTo: string };

export type StartBlock = AiGateBlock | 'call_in_progress';

export type StartResult =
  | { ok: true; aiCallId: string; status: 'ringing' }
  | { ok: false; reason: StartBlock; aiCallId: string }
  | { ok: false; reason: 'twilio_error'; aiCallId: string }
  | { ok: false; reason: 'record_not_found' | 'salesforce_error' | 'gate_error' };

export interface StartDeps {
  store: AiCallStore;
  twilio: AiVoiceTwilio;
  loadRecord: (userId: string, objectType: AiCallObject, recordId: string) => Promise<AiCallRecord | null>;
  gate: (db: Db, input: AiGateInput, deps?: GateDeps) => Promise<AiGateResult>;
  now: () => Date;
  log: BridgeLog;
}

export interface StartInput {
  db: Db;
  cfg: AppConfig;
  session: SessionUser;
  target: StartTarget;
  deps: StartDeps;
}

/** A live AI call older than this no longer blocks a new one (a crashed call must not block forever). */
const ACTIVE_CALL_WINDOW_MS = 60 * 60 * 1000;
/** Registry entries expire after the longest a call can last, plus margin. */
const REGISTRY_MARGIN_SECONDS = 30 + 60 + 300;
const FALLBACK_TIME_ZONE = 'America/Chicago';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const realGateDeps: GateDeps = { blockedTargets, dailyDialCount, withinCallingHours, pickDidForRun };

/** The dialer's gate deps, with the daily count widened to placed AI calls not yet in `calls`. */
export function aiGateDeps(store: AiCallStore, base: GateDeps = realGateDeps): GateDeps {
  return {
    ...base,
    dailyDialCount: async (db, orgId, e164, now) => {
      const since = new Date(now.getTime() - DAILY_CAP_WINDOW_MS);
      const [dialer, ai] = await Promise.all([base.dailyDialCount(db, orgId, e164, now), store.uncountedPlaced(orgId, e164, since)]);
      return dialer + ai;
    },
  };
}

/** "Monday 4:12 PM" in the recipient's zone (from the area code, as the dialer's calling hours derive it). */
export function localTimeFor(e164: string, now: Date): string {
  const timeZone = timezoneForNumber(e164)?.timezone ?? FALLBACK_TIME_ZONE;
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(now);
}

async function loadTarget(
  i: StartInput,
): Promise<{ record: AiCallRecord | null; candidate: string | null } | { fail: 'record_not_found' | 'salesforce_error' }> {
  if ('testTo' in i.target) return { record: null, candidate: toE164(i.target.testTo) };
  try {
    const record = await i.deps.loadRecord(i.session.userId, i.target.objectType, i.target.recordId);
    return record ? { record, candidate: record.phones[0] ?? null } : { fail: 'record_not_found' };
  } catch (e) {
    i.deps.log.warn({ userId: i.session.userId, err: errText(e) }, 'ai-voice: record load failed');
    return { fail: 'salesforce_error' };
  }
}

async function handoffUser(i: StartInput, record: AiCallRecord | null): Promise<string> {
  if (!record?.ownerSfUserId) return i.session.userId;
  try {
    return (await i.deps.store.handoffUserFor(i.session.orgId, record.ownerSfUserId)) ?? i.session.userId;
  } catch (e) {
    i.deps.log.warn({ err: errText(e) }, 'ai-voice: hand-off user lookup failed, using the starter');
    return i.session.userId;
  }
}

async function companyName(i: StartInput): Promise<string> {
  try {
    return (await i.deps.store.orgName(i.session.orgId)) ?? '';
  } catch (e) {
    i.deps.log.warn({ err: errText(e) }, 'ai-voice: org name lookup failed');
    return '';
  }
}

function rowTarget(target: StartTarget) {
  return 'testTo' in target
    ? { sfObject: null, sfRecordId: null, isTest: true }
    : { sfObject: target.objectType, sfRecordId: target.recordId, isTest: false };
}

async function blockedRow(i: StartInput, reason: StartBlock, to: string): Promise<StartResult> {
  const row = await i.deps.store.insert({
    orgId: i.session.orgId,
    startedBy: i.session.userId,
    ...rowTarget(i.target),
    toE164: to,
    status: 'blocked',
    outcome: 'blocked',
    blockReason: reason,
    endedAt: i.deps.now(),
  });
  i.deps.log.info({ aiCallId: row.id, reason }, 'ai-voice: call blocked');
  return { ok: false, reason, aiCallId: row.id };
}

export async function startAiCall(i: StartInput): Promise<StartResult> {
  const { cfg, session, deps } = i;
  const loaded = await loadTarget(i);
  if ('fail' in loaded) return { ok: false, reason: loaded.fail };
  const { record, candidate } = loaded;
  const blockedTo = candidate ?? ('testTo' in i.target ? i.target.testTo.slice(0, 20) : '');

  const now = deps.now();
  if (candidate && (await deps.store.activeCallTo(session.orgId, candidate, new Date(now.getTime() - ACTIVE_CALL_WINDOW_MS)))) {
    return blockedRow(i, 'call_in_progress', candidate);
  }

  let gate: AiGateResult;
  try {
    gate = await deps.gate(
      i.db,
      {
        cfg,
        orgId: session.orgId,
        userId: session.userId,
        isAdmin: session.isAdmin,
        now,
        target: record ? { kind: 'record', record } : { kind: 'test', toRaw: 'testTo' in i.target ? i.target.testTo : '' },
      },
      aiGateDeps(deps.store),
    );
  } catch (e) {
    deps.log.error({ userId: session.userId, err: errText(e) }, 'ai-voice: gate failed, refusing the call');
    return { ok: false, reason: 'gate_error' };
  }
  if (!gate.ok) return blockedRow(i, gate.reason, blockedTo);

  const [handoffUserId, company] = await Promise.all([handoffUser(i, record), companyName(i)]);
  const row = await deps.store.insert({
    orgId: session.orgId,
    startedBy: session.userId,
    handoffUserId,
    ...rowTarget(i.target),
    toE164: gate.toE164,
    fromE164: gate.fromE164,
    status: 'queued',
  });
  const aiCallId = row.id;
  const isTest = record === null;
  registerActiveCall(
    {
      aiCallId,
      orgId: session.orgId,
      startedBy: session.userId,
      handoffUserId,
      callSid: null,
      toE164: gate.toE164,
      fromE164: gate.fromE164,
      isTest,
      record,
      prompt: {
        agentName: cfg.AI_VOICE_AGENT_NAME,
        companyName: company,
        firstName: record?.firstName ?? null,
        address: record?.address ?? null,
        notes: record?.notes ?? '',
        isTest,
        callbackNumber: gate.fromE164,
      },
      bridge: null,
      transcript: null,
      closing: false,
    },
    (cfg.AI_VOICE_MAX_CALL_SECONDS + REGISTRY_MARGIN_SECONDS) * 1000,
    deps.log,
  );

  let callSid: string;
  try {
    ({ callSid } = await deps.twilio.placeCall({
      to: gate.toE164,
      from: gate.fromE164,
      twiml: streamTwiml({
        wssUrl: streamWssUrl(cfg.API_PUBLIC_URL),
        aiCallId,
        token: streamToken(aiCallId, cfg.SESSION_SECRET),
      }),
      statusCallback: callbackUrl(cfg.API_PUBLIC_URL, STATUS_PATH, aiCallId),
      amdCallback: callbackUrl(cfg.API_PUBLIC_URL, AMD_PATH, aiCallId),
    }));
  } catch (e) {
    deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: Twilio refused the call');
    dropActiveCall(aiCallId);
    await deps.store.update(aiCallId, { status: 'failed', outcome: 'failed', endedAt: deps.now() });
    return { ok: false, reason: 'twilio_error', aiCallId };
  }

  updateActiveCall(aiCallId, { callSid });
  await recordPlaced(deps, aiCallId, callSid);
  deps.log.info({ aiCallId, isTest }, 'ai-voice: call placed');
  return { ok: true, aiCallId, status: 'ringing' };
}

/**
 * The phone is already ringing: a database error here must not turn into a
 * 500 for a live call. Retried once, then logged loudly; the status callback
 * (keyed by aiCallId) still finalizes the row and stores its CallSid.
 */
async function recordPlaced(deps: StartDeps, aiCallId: string, callSid: string): Promise<void> {
  const write = async () => {
    await deps.store.update(aiCallId, { callSid });
    // A status callback may already have moved the row on; only a queued row becomes ringing.
    await deps.store.updateWhereStatus(aiCallId, ['queued'], { status: 'ringing' });
  };
  try {
    await write();
  } catch (first) {
    deps.log.warn({ aiCallId, err: errText(first) }, 'ai-voice: CallSid write failed, retrying');
    try {
      await write();
    } catch (e) {
      deps.log.error({ aiCallId, callSid, err: errText(e) }, 'ai-voice: CALL IS LIVE but its CallSid was not stored — the status callback will finalize it');
    }
  }
}
