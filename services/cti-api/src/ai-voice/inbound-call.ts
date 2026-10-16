/**
 * The start of an INBOUND AI call (plan docs/superpowers/plans/2026-10-16-inbound-agent-testing.md): a phone on the
 * org's test-phones list calls one of the AI's own numbers and gets the AI agent ("Sam", the `inbound` prompt)
 * instead of a rep or voicemail.
 *
 * routes/inbound.ts asks `tryInboundAiCall` for every call to an `ai_pool` number. It answers null — and the route
 * carries on with today's routing exactly — when AI_VOICE_INBOUND is off, the caller is anonymous or not a strict
 * E.164 number, the phone is not on the org's list, AI voice is unavailable, or anything throws. Only a call that is
 * news to someone logs (owner ruling, final review M-1): a LISTED phone that did not get the agent (AI voice
 * unavailable, a bad CallSid, the start failing), or a list lookup that failed, warns with a reason code only (never
 * the number or an error's text). The switch being off, an anonymous caller and a caller not on the list — every real
 * caller — are silent, and with the switch off the list is not even read.
 *
 * Otherwise it writes an inbound test row (`direction 'inbound'`, `is_test`, the caller in `to_e164`, the AI number in
 * `from_e164`, started by the admin who listed the phone), registers the live call with its prompt input, and returns
 * the same `<Connect><Stream>` TwiML an outbound call runs. The stream session (stream-session.ts) accepts it like any
 * placed call and finalizes it when the conversation ends. No `calls` row, Salesforce work or opt-out ever follows,
 * and no audio is stored. A replayed webhook for a CallSid whose inbound row is still open gets the stream TwiML for
 * that same row (registered again if a restart lost it), never a second row or today's routing (final review M-3).
 */
import { toE164 } from '@cti/phone';
import { aiVoiceAvailable, type AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import { TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';
import type { BridgeLog } from './bridge.js';
import { loadAgentPrompts } from './prompt-saved.js';
import { getActiveCall, registerActiveCall, type ActiveAiCall } from './registry.js';
import { REGISTRY_MARGIN_SECONDS } from './service.js';
import type { AgentPromptTemplates, AiCallStore } from './store.js';
import { findTestPhone as realFindTestPhone, type TestPhoneMatch } from './test-phones.js';
import { streamToken, streamTwiml, streamWssUrl } from './twilio.js';

export const INBOUND_NOT_STARTED = 'ai-voice: inbound test call not started';

/** Why a listed phone's call (or a call whose caller could not be looked up) was not given the agent: logged. */
type NotStarted = 'ai_unavailable' | 'bad_call_sid' | 'lookup_failed' | 'start_failed';

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

/** Why a listed phone's call cannot get the agent, or null when it may. */
function refusal(deps: InboundAiDeps, callSid: string): NotStarted | null {
  if (!aiVoiceAvailable(deps.cfg)) return 'ai_unavailable';
  return TWILIO_CALL_SID_RE.test(callSid) ? null : 'bad_call_sid';
}

/** The agent's TwiML for a listed phone; null = route the call as today (see the header). Never throws. */
export async function tryInboundAiCall(deps: InboundAiDeps, call: InboundAiCall): Promise<string | null> {
  const notStarted = (reason: NotStarted): null => {
    deps.log.warn({ reason }, INBOUND_NOT_STARTED);
    return null;
  };
  // The operator's choice, and a caller who can never be on the list: silent, and the list is not read.
  if (deps.cfg.AI_VOICE_INBOUND !== 'on') return null;
  const caller = toE164(call.callerE164);
  if (caller === null) return null;
  let phone: TestPhoneMatch | null;
  try {
    phone = await (deps.findTestPhone ?? realFindTestPhone)(deps.db, call.orgId, caller);
  } catch {
    return notStarted('lookup_failed');
  }
  if (!phone) return null;
  const refused = refusal(deps, call.callSid);
  if (refused !== null) return notStarted(refused);
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

/**
 * The call's inbound row: a new one, or — when the insert is refused because this CallSid already has a row (a replayed
 * webhook; final review M-3) — the org's OPEN inbound row for it, so the replay streams to that row instead of falling
 * back to today's routing. Throws the insert's error when there is no such row (an outbound or ended row, or a DB error).
 */
async function inboundRow(store: AiCallStore, call: StartCall): Promise<{ id: string; startedBy: string; replayed: boolean }> {
  try {
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
    return { id: row.id, startedBy: call.addedBy, replayed: false };
  } catch (err) {
    const open = await store.openInboundByCallSid(call.orgId, call.callSid).catch(() => null);
    if (open === null) throw err;
    return { id: open.id, startedBy: open.startedBy, replayed: true };
  }
}

/**
 * Write the inbound row (or find a replay's), register the live call unless it is registered already, and return its
 * stream TwiML. Throws when the row can be neither written nor found.
 */
export async function startInboundAiCall(deps: InboundAiDeps, call: StartCall): Promise<string> {
  const { cfg, store } = deps;
  // The org's saved prompts are read per call, never cached, so a saved inbound version applies to the next call.
  const [templates, company] = await Promise.all([loadAgentPrompts(store, call.orgId, deps.log), companyName(deps, call.orgId)]);
  const row = await inboundRow(store, call);
  // A replay whose call is still registered keeps that entry (its stream may be attaching); after a restart it has none.
  if (getActiveCall(row.id) === null) {
    const ttlMs = (cfg.AI_VOICE_MAX_CALL_SECONDS + REGISTRY_MARGIN_SECONDS) * 1000;
    registerActiveCall(inboundEntry(cfg, { ...call, addedBy: row.startedBy }, row.id, company, templates), ttlMs, deps.log);
  }
  deps.log.info({ aiCallId: row.id, replayed: row.replayed }, 'ai-voice: inbound test call answered');
  return streamTwiml({ wssUrl: streamWssUrl(cfg.API_PUBLIC_URL), aiCallId: row.id, token: streamToken(row.id, cfg.SESSION_SECRET) });
}
