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
import type { AppointmentSlot, Consultations, PriorityOffer } from '@cti/contracts';
import { DAILY_CAP_WINDOW_MS, dailyDialCount, timezoneForNumber } from '@cti/firewall';
import type { AppConfig } from '../config.js';
import { blockedTargets } from '../dialer/consent-check.js';
import { withinCallingHours, type Db } from '../dialer/pick-did.js';
import type { BridgeLog } from './bridge.js';
import { gateAiCall, type AiGateBlock, type AiGateInput, type AiGateResult, type GateDeps } from './gate.js';
import { localTimeFor } from './local-time.js';
import { peekAiCallerId, pickAiDid } from './number-pool.js';
import { voicemailText, type PromptInput } from './prompt.js';
import { loadAgentPrompts, logTemplateError } from './prompt-saved.js';
import { testPhoneNumbers } from './test-phones.js';
import type { AiCallObject, AiCallRecord } from './record.js';
import { dropActiveCall, registerActiveCall, updateActiveCall, type ActiveAiCall } from './registry.js';
import { gateTarget, handoffUser, loadTarget, rowTarget, targetKind, typedNumber, type StartTarget } from './service-target.js';
import type { AiCallStore } from './store.js';
import type { VoicemailAudio } from './voicemail-audio.js';
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

export type { StartTarget } from './service-target.js';

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
  /** Sam's voicemail (voicemail-audio.ts): its render starts once Twilio has the call; null = `<Say>` only. */
  voicemail: Pick<VoicemailAudio, 'prepare'> | null;
}

export interface StartInput {
  db: Db;
  cfg: AppConfig;
  session: SessionUser;
  target: StartTarget;
  /** The approved call plan (plan 1C internal trigger); the prompt fences it as data. */
  plan?: string | null;
  /** Plan 1D: appointment times the agent may offer (record and practice calls); stored as ai_calls.offered_slots. */
  slots?: AppointmentSlot[];
  /** Plan 1D: we have spoken with this seller before (the trigger's context). */
  returning?: boolean;
  /** Task 14: what already happened with this seller (record calls only); the prompt fences it as data after the instructions. */
  history?: string;
  /** Routing step 1: the high-priority offer (Grant), which may come with no slots; null or absent = none. */
  priority?: PriorityOffer | null;
  /** Routing step 1: the seller's earlier and upcoming consultations (the trigger's context); null or absent = none known. */
  consultations?: Consultations | null;
  deps: StartDeps;
}

/** A live AI call older than this no longer blocks a new one (a crashed call must not block forever). */
const ACTIVE_CALL_WINDOW_MS = 60 * 60 * 1000;
/** Registry entries expire after the longest a call can last, plus margin (inbound calls too: inbound-call.ts). */
export const REGISTRY_MARGIN_SECONDS = 30 + 60 + 300;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const realGateDeps: GateDeps = { blockedTargets, dailyDialCount, withinCallingHours, pickAiDid, peekAiCallerId, testPhoneNumbers };

/** Both practice kinds (plan 1D phone, plan 1E browser) must sound exactly as the seller would hear the call. */
const isPractice = (i: StartInput): boolean => {
  const kind = targetKind(i.target);
  return kind === 'practice' || kind === 'practice_browser';
};

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


async function companyName(i: StartInput): Promise<string> {
  try {
    return (await i.deps.store.orgName(i.session.orgId)) ?? '';
  } catch (e) {
    i.deps.log.warn({ err: errText(e) }, 'ai-voice: org name lookup failed');
    return '';
  }
}

/**
 * Plan 1D prompt fields, only when set, so a first call without slots has exactly the 1C prompt. Times are said in the
 * seller's zone: the number dialed, except for a practice call, which rings a test number but must sound exactly as the
 * seller would hear it, so it takes the record's phone (Fix 1, M-5), falling back to the dialed number. Routing step 1: a
 * priority offer brings the seller's zone too, even with no slots; consultations come only when one is known, and bring the
 * zone as well, so an earlier or booked consultation is said in the seller's time.
 */
function bookingPrompt(
  i: StartInput,
  record: AiCallRecord | null,
  to: string,
): Pick<PromptInput, 'returning' | 'slots' | 'sellerTimeZone' | 'priority' | 'consultations'> {
  const slots = i.slots && i.slots.length > 0 ? i.slots : null;
  const priority = i.priority ?? null;
  const consultations = i.consultations && (i.consultations.last !== null || i.consultations.next !== null) ? i.consultations : null;
  return {
    ...(i.returning ? { returning: true } : {}),
    ...(slots ? { slots } : {}),
    ...(priority ? { priority } : {}),
    ...(slots || priority || consultations ? { sellerTimeZone: timezoneForNumber(sellerNumber(i, record, to))?.timezone ?? null } : {}),
    ...(consultations ? { consultations } : {}),
  };
}

/**
 * The number whose zone is the seller's: the number dialed, except for a practice call, which takes the record's phone when
 * its zone is known (Fix 1 M-5 for the slot words; Part 6 B for "their local time right now"), else the number it rings.
 */
function sellerNumber(i: StartInput, record: AiCallRecord | null, to: string): string {
  const phone = isPractice(i) ? record?.phones[0] : undefined;
  return phone && timezoneForNumber(phone) ? phone : to;
}

/**
 * Start rendering the voicemail the beep would leave (the same text onAmd builds) while the phone rings: a full one
 * takes ~3 s, too long to start at the beep. Never fails the call; the beep falls back to `<Say>`.
 */
function prepareVoicemail(deps: StartDeps, aiCallId: string, prompt: ActiveAiCall['prompt'], to: string): void {
  if (!deps.voicemail) return;
  try {
    deps.voicemail.prepare(aiCallId, voicemailText({ ...prompt, localTime: localTimeFor(to, deps.now()) }, logTemplateError(deps.log)));
  } catch (e) {
    deps.log.warn({ aiCallId, err: errText(e) }, 'ai-voice: the voicemail render could not start — the beep will use <Say>');
  }
}

async function blockedRow(i: StartInput, reason: StartBlock, to: string): Promise<StartResult> {
  const row = await i.deps.store.insert({
    orgId: i.session.orgId,
    startedBy: i.session.userId,
    ...rowTarget(i.target),
    offeredSlots: i.slots ?? [],
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
  const blockedTo = candidate ?? (typedNumber(i.target) ?? '').slice(0, 20);

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
        target: gateTarget(i.target, record),
      },
      aiGateDeps(deps.store),
    );
  } catch (e) {
    deps.log.error({ userId: session.userId, err: errText(e) }, 'ai-voice: gate failed, refusing the call');
    return { ok: false, reason: 'gate_error' };
  }
  if (!gate.ok) return blockedRow(i, gate.reason, blockedTo);

  // The org's saved prompts are read here, per call and never cached, so a saved version applies to the next call.
  const [handoffUserId, company, templates] = await Promise.all([
    handoffUser(i, record),
    companyName(i),
    loadAgentPrompts(deps.store, session.orgId, deps.log),
  ]);
  const row = await deps.store.insert({
    orgId: session.orgId,
    startedBy: session.userId,
    handoffUserId,
    ...rowTarget(i.target),
    offeredSlots: i.slots ?? [],
    toE164: gate.toE164,
    fromE164: gate.fromE164,
    status: 'queued',
  });
  const aiCallId = row.id;
  const kind = targetKind(i.target);
  // The registry's isTest (no Salesforce Task, no results) holds for test AND practice calls; the prompt's isTest (the
  // "this is a test call" line) only for a test call: a practice call lets the admin hear exactly what the seller would.
  const isTest = kind !== 'record';
  const prompt: ActiveAiCall['prompt'] = {
    agentName: cfg.AI_VOICE_AGENT_NAME,
    companyName: company,
    firstName: record?.firstName ?? null,
    address: record?.address ?? null,
    notes: record?.notes ?? '',
    isTest: kind === 'test',
    callbackNumber: gate.fromE164,
    templates,
    ...(i.plan ? { approvedPlan: i.plan } : {}),
    ...(i.history ? { history: i.history } : {}),
    ...bookingPrompt(i, record, gate.toE164),
  };
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
      direction: 'outbound',
      ...(isPractice(i) ? { localTimeE164: sellerNumber(i, record, gate.toE164) } : {}),
      record,
      prompt,
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
      // A browser leg (plan 1E) is never an answering machine.
      amd: kind !== 'practice_browser',
    }));
  } catch (e) {
    deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: Twilio refused the call');
    dropActiveCall(aiCallId);
    // Twilio may have placed the call before it errored (a timeout), so this answer must come back whatever the database
    // says: an exception here would reach the internal route, and nothing may free that request's idempotency key (S-6).
    try {
      await deps.store.update(aiCallId, { status: 'failed', outcome: 'failed', endedAt: deps.now() });
    } catch (updateErr) {
      deps.log.error({ aiCallId, err: errText(updateErr) }, 'ai-voice: the failed call could not be marked failed');
    }
    return { ok: false, reason: 'twilio_error', aiCallId };
  }

  updateActiveCall(aiCallId, { callSid });
  // A browser leg has no answering-machine detection, so it never leaves a voicemail.
  if (kind !== 'practice_browser') prepareVoicemail(deps, aiCallId, prompt, gate.toE164);
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
