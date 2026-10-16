/**
 * The start of an INBOUND AI call (plan docs/superpowers/plans/2026-10-16-inbound-agent-testing.md): a phone on the
 * org's test-phones list calls one of the AI's own numbers and gets the AI agent ("Sam", the `inbound` prompt)
 * instead of a rep or voicemail.
 *
 * routes/inbound.ts asks `tryInboundAiCall` for every call to an `ai_pool` number. It answers null — and the route
 * carries on with today's routing exactly — when AI_VOICE_INBOUND is off, AI voice is unavailable, the caller is
 * anonymous or not a strict E.164 number, the phone is not on the org's list, or anything throws. Each of those except
 * "not on the list" (every real caller) logs a warning with a reason code only: never the number or an error's text.
 *
 * Otherwise it writes an inbound test row (`direction 'inbound'`, `is_test`, the caller in `to_e164`, the AI number in
 * `from_e164`, started by the admin who listed the phone), registers the live call with its prompt input, and returns
 * the same `<Connect><Stream>` TwiML an outbound call runs. The stream session (stream-session.ts) accepts it like any
 * placed call and finalizes it when the conversation ends. No `calls` row, Salesforce work or opt-out ever follows,
 * and no audio is stored.
 */
import { toE164 } from '@cti/phone';
import { aiVoiceAvailable, type AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import { TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';
import type { BridgeLog } from './bridge.js';
import { loadAgentPrompts } from './prompt-saved.js';
import { registerActiveCall, type ActiveAiCall } from './registry.js';
import { REGISTRY_MARGIN_SECONDS } from './service.js';
import type { AgentPromptTemplates, AiCallStore } from './store.js';
import { findTestPhone as realFindTestPhone, type TestPhoneMatch } from './test-phones.js';
import { streamToken, streamTwiml, streamWssUrl } from './twilio.js';

export const INBOUND_NOT_STARTED = 'ai-voice: inbound test call not started';

/** Why a call to an AI number was not given the agent (logged; "not listed" is the normal case and is not). */
type NotStarted = 'switched_off' | 'ai_unavailable' | 'bad_caller' | 'bad_call_sid' | 'lookup_failed' | 'start_failed';

export interface InboundAiDeps {
  cfg: Pick<
    AppConfig,
    'AI_VOICE_INBOUND' | 'OPENAI_API_KEY' | 'AI_VOICE' | 'OUTREACH_KILL_SWITCH' | 'API_PUBLIC_URL' | 'SESSION_SECRET' | 'AI_VOICE_AGENT_NAME' | 'AI_VOICE_MAX_CALL_SECONDS'
  >;
  db: Db;
  store: AiCallStore;
  log: BridgeLog;
  now: () => Date;
  /** The list lookup (default test-phones.ts); a test seam. */
  findTestPhone?: (db: Db, orgId: string, e164: string) => Promise<TestPhoneMatch | null>;
}

export interface InboundAiCall {
  orgId: string;
  /** The caller as the route has it: E.164 when it parsed, else the raw From (e.g. "anonymous"). */
  callerE164: string;
  /** The AI number they dialed (the `ai_pool` DID). */
  aiNumber: string;
  callSid: string;
}

/** Why this call cannot get the agent before any lookup, or null when it may. */
function refusal(deps: InboundAiDeps, caller: string | null, callSid: string): NotStarted | null {
  if (deps.cfg.AI_VOICE_INBOUND !== 'on') return 'switched_off';
  if (!aiVoiceAvailable(deps.cfg)) return 'ai_unavailable';
  if (!caller) return 'bad_caller';
  return TWILIO_CALL_SID_RE.test(callSid) ? null : 'bad_call_sid';
}

/** The agent's TwiML for a listed phone; null = route the call as today (see the header). Never throws. */
export async function tryInboundAiCall(deps: InboundAiDeps, call: InboundAiCall): Promise<string | null> {
  const notStarted = (reason: NotStarted): null => {
    deps.log.warn({ reason }, INBOUND_NOT_STARTED);
    return null;
  };
  const caller = toE164(call.callerE164);
  const refused = refusal(deps, caller, call.callSid);
  if (refused !== null || caller === null) return notStarted(refused ?? 'bad_caller');
  let phone: TestPhoneMatch | null;
  try {
    phone = await (deps.findTestPhone ?? realFindTestPhone)(deps.db, call.orgId, caller);
  } catch {
    return notStarted('lookup_failed');
  }
  if (!phone) return null;
  try {
    return await startInboundAiCall(deps, { ...call, callerE164: caller, addedBy: phone.addedBy });
  } catch {
    return notStarted('start_failed');
  }
}

/** The org's name as the agent says it ('' when it cannot be read: the call still starts). */
async function companyName(deps: InboundAiDeps, orgId: string): Promise<string> {
  try {
    return (await deps.store.orgName(orgId)) ?? '';
  } catch {
    deps.log.warn({ reason: 'db_error' }, 'ai-voice: org name lookup failed');
    return '';
  }
}

type StartCall = InboundAiCall & { addedBy: string };

/** The live call's registry entry: the caller is `toE164`, the AI number `fromE164`, and the prompt input has no record. */
function inboundEntry(cfg: InboundAiDeps['cfg'], call: StartCall, aiCallId: string, company: string, templates: AgentPromptTemplates): ActiveAiCall {
  return {
    aiCallId,
    orgId: call.orgId,
    startedBy: call.addedBy,
    // Never rung: an inbound call is not offered transfer_to_rep.
    handoffUserId: call.addedBy,
    callSid: call.callSid,
    toE164: call.callerE164,
    fromE164: call.aiNumber,
    isTest: true,
    direction: 'inbound',
    record: null,
    prompt: {
      agentName: cfg.AI_VOICE_AGENT_NAME,
      companyName: company,
      firstName: null,
      address: null,
      notes: '',
      isTest: true,
      callbackNumber: null,
      callerNumber: call.callerE164,
      templates,
    },
    bridge: null,
    transcript: null,
    closing: false,
  };
}

/** Write the inbound row, register the live call, and return its stream TwiML. Throws when the row cannot be written. */
export async function startInboundAiCall(deps: InboundAiDeps, call: StartCall): Promise<string> {
  const { cfg, store } = deps;
  // The org's saved prompts are read per call, never cached, so a saved inbound version applies to the next call.
  const [templates, company] = await Promise.all([loadAgentPrompts(store, call.orgId, deps.log), companyName(deps, call.orgId)]);
  const row = await store.insert({
    orgId: call.orgId,
    startedBy: call.addedBy,
    direction: 'inbound',
    isTest: true,
    practice: false,
    sfObject: null,
    toE164: call.callerE164,
    fromE164: call.aiNumber,
    status: 'queued',
    callSid: call.callSid,
  });
  const ttlMs = (cfg.AI_VOICE_MAX_CALL_SECONDS + REGISTRY_MARGIN_SECONDS) * 1000;
  registerActiveCall(inboundEntry(cfg, call, row.id, company, templates), ttlMs, deps.log);
  deps.log.info({ aiCallId: row.id }, 'ai-voice: inbound test call answered');
  return streamTwiml({ wssUrl: streamWssUrl(cfg.API_PUBLIC_URL), aiCallId: row.id, token: streamToken(row.id, cfg.SESSION_SECRET) });
}
