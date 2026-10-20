/**
 * Twilio's callbacks for an AI call, all signature-checked over the FULL URL
 * (query string included — telephony/webhooks.ts) and keyed by `?aiCallId=`:
 *
 *   amd              async AMD: a machine after the beep gets the voicemail
 *                    (silence the agent, redirect to <Play> of Sam's recorded
 *                    voicemail when it is ready, else <Say>); a fax is opted
 *                    out (source ai_call, note 'fax') and hung up.
 *   status           call progress; a terminal status finalizes (idempotent;
 *                    the summary / Salesforce work runs after the reply) and
 *                    drops the call's voicemail audio.
 *   transfer-result  the transfer's <Dial action>: rep answered → status
 *                    `transferred` (the ONLY place that sets it, even after
 *                    finalize), hang up when done; otherwise outcome
 *                    `transfer_failed` and the caller hears a callback promise.
 *   inbound-stream-ended  after an inbound call's <Connect><Stream>: a stream
 *                    that never connected (Twilio 31901 while a deploy swapped
 *                    containers, 2026-10-19: the caller heard nothing) ends the
 *                    row as failed and goes to today's inbound routing; any
 *                    other call hangs up.
 *
 * A callback without a CallSid is refused 400, one whose CallSid is not the
 * row's 403 (both `<Reject/>`, nothing changes). Every response is valid
 * TwiML; the bad-signature response is 403 `<Reject/>`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../config.js';
import { getProvider } from '../telephony/index.js';
import { signedCallbackUrl, UUID_RE } from '../telephony/webhooks.js';
import type { BridgeLog } from './bridge.js';
import { voicemailText } from './prompt.js';
import { logTemplateError } from './prompt-saved.js';
import { claimClose, getActiveCall } from './registry.js';
import { localTimeFor } from './local-time.js';
import { finalizeAiCall, isTerminalCallStatus, mapCallStatus, type AfterCall } from './service-finalize.js';
import type { ToolCtx, ToolEffects } from './service-tools.js';
import type { AiCallRow, AiCallStore } from './store.js';
import {
  AMD_PATH,
  INBOUND_STREAM_ENDED_PATH,
  STATUS_PATH,
  TRANSFER_RESULT_PATH,
  inboundRoutingTwiml,
  noRepTwiml,
  voicemailPlayTwiml,
  voicemailTwiml,
  type AiVoiceTwilio,
} from './twilio.js';
import { VOICEMAIL_READY_WAIT_MS, type VoicemailAudio } from './voicemail-audio.js';

export interface WebhookDeps {
  store: AiCallStore;
  twilio: AiVoiceTwilio;
  effects: ToolEffects;
  now: () => Date;
  log: BridgeLog;
  /** Summary + Salesforce after finalize (detached). */
  afterCall?: AfterCall;
  /** Sam's recorded voicemail (voicemail-audio.ts); null = always `<Say>`. */
  voicemail: Pick<VoicemailAudio, 'playUrl' | 'forget'> | null;
  /** Waits `ms` (DRAINED_CALL_SETTLE_MS); tests pass a fake. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long the end of a talking call this process is not running waits before it is finalized: the call was live on the
 * old process a deploy is draining (drain.ts), which writes the transcript's last lines as its stream closes, and the
 * summary and Salesforce Task read the transcript the finalize returns.
 */
export const DRAINED_CALL_SETTLE_MS = 3_000;
const timerSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const HANGUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const REJECT_TWIML = '<Response><Reject/></Response>';
const LIVE_FOR_VOICEMAIL = ['ringing', 'in_progress'];
/** An inbound row's statuses before its conversation starts (markFailed leaves `failed` with no end time). */
const NOT_STARTED_STATUSES: readonly string[] = ['queued', 'ringing', 'failed'];
const DIAL_CONNECTED = new Set(['completed', 'answered']);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const field = (body: unknown, key: string): string => {
  const v = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
};

function validSignature(req: FastifyRequest): boolean {
  const cfg = loadConfig();
  if (cfg.TWILIO_SKIP_SIGNATURE_CHECK) return true;
  const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
  const headers = req.headers as Record<string, string | string[] | undefined>;
  return getProvider().validateWebhook(headers, rawBody, signedCallbackUrl(cfg.API_PUBLIC_URL, req)).valid;
}

const xml = (reply: FastifyReply, body: string) => reply.type('text/xml').send(body);

/** The callback's row (null: bad or unknown id), or the status to refuse it with (no CallSid / another call's). */
type RowLookup = { row: AiCallRow | null } | { refuse: 400 | 403 };

async function rowFor(req: FastifyRequest, store: AiCallStore): Promise<RowLookup> {
  const sid = field(req.body, 'CallSid');
  if (!sid) return { refuse: 400 };
  const id = (req.query as Record<string, unknown> | undefined)?.aiCallId;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return { row: null };
  const row = await store.get(id);
  if (row?.callSid && row.callSid !== sid) return { refuse: 403 };
  return { row };
}

const refuse = (reply: FastifyReply, code: 400 | 403) => reply.code(code).type('text/xml').send(REJECT_TWIML);

function toolCtx(row: AiCallRow, deps: WebhookDeps): ToolCtx {
  // Webhooks never book an appointment (only the live conversation's tools do).
  return { store: deps.store, aiCallId: row.id, orgId: row.orgId, toE164: row.toE164, log: deps.log, now: deps.now, slots: [], priority: null, consultations: null, isTest: row.isTest };
}

async function hangUp(callSid: string, deps: WebhookDeps, aiCallId: string): Promise<void> {
  await deps.twilio.hangup(callSid).catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: hangup failed'));
}

/** Sam's recorded voicemail for this text when it is ready (voicemail-audio.ts), else null: the call gets `<Say>`. */
async function voicemailAudioUrl(aiCallId: string, text: string, deps: WebhookDeps): Promise<string | null> {
  if (!deps.voicemail) return null;
  try {
    return await deps.voicemail.playUrl(aiCallId, text, VOICEMAIL_READY_WAIT_MS);
  } catch (e) {
    deps.log.warn({ aiCallId, err: errText(e) }, 'ai-voice: voicemail audio lookup failed — using <Say>');
    return null;
  }
}

/** Async AMD. Voicemail only for a call this process placed (registry) and that passed the gate. */
export async function onAmd(row: AiCallRow, answeredBy: string, deps: WebhookDeps): Promise<void> {
  if (!answeredBy) return;
  await deps.store
    .update(row.id, { answeredBy })
    .catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: answered_by write failed'));
  const callSid = row.callSid;
  if (!callSid || !LIVE_FOR_VOICEMAIL.includes(row.status)) return;

  if (answeredBy === 'fax') {
    if (!claimClose(row.id)) return;
    await deps.store
      .setOutcome(row.id, 'wrong_number', null)
      .catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: fax outcome write failed'));
    // Plan 1D Part 6: a test or practice call rang the admin's own phone; never opt it out (AMD can mistake a phone for a fax).
    if (!row.isTest) {
      await deps.store
        .upsertOptOut(row.orgId, row.toE164, 'fax')
        .catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: fax opt-out write failed'));
    }
    await hangUp(callSid, deps, row.id);
    return;
  }
  if (!answeredBy.startsWith('machine_end')) return; // human / unknown: the agent carries on

  const entry = getActiveCall(row.id);
  if (!entry || !claimClose(row.id)) return; // a tool (or a failure) already owns the end of the call
  entry.bridge?.silence();
  const text = voicemailText({ ...entry.prompt, localTime: localTimeFor(entry.toE164, deps.now()) }, logTemplateError(deps.log));
  const audioUrl = await voicemailAudioUrl(row.id, text, deps);
  try {
    await deps.twilio.redirect(callSid, audioUrl ? voicemailPlayTwiml(audioUrl) : voicemailTwiml(text));
    await deps.store.setOutcome(row.id, 'voicemail', null);
    deps.log.info({ aiCallId: row.id, voice: audioUrl ? 'elevenlabs' : 'say' }, 'ai-voice: voicemail left');
  } catch (e) {
    deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: voicemail redirect failed, hanging up');
    await hangUp(callSid, deps, row.id);
  }
}

export async function onStatus(row: AiCallRow, body: unknown, deps: WebhookDeps): Promise<void> {
  const callStatus = field(body, 'CallStatus');
  const callSid = field(body, 'CallSid') || null;
  if (isTerminalCallStatus(callStatus)) {
    if (row.status === 'in_progress' && getActiveCall(row.id) === null) await (deps.sleep ?? timerSleep)(DRAINED_CALL_SETTLE_MS);
    // The call is over, so its voicemail has played (or never will): the audio and its link go now.
    try {
      deps.voicemail?.forget(row.id);
    } catch (e) {
      deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: voicemail audio could not be dropped (it expires on its own)');
    }
    const seconds = Number.parseInt(field(body, 'CallDuration'), 10);
    const fin = { store: deps.store, log: deps.log, ...(deps.afterCall ? { afterCall: deps.afterCall } : {}) };
    await finalizeAiCall(fin, row.id, {
      callStatus,
      durationSeconds: Number.isFinite(seconds) ? seconds : null,
      endedAt: deps.now(),
      answeredBy: field(body, 'AnsweredBy') || null,
      callSid,
    });
    return;
  }
  // The CallSid write after placing the call can fail (service.ts); the callback carries it.
  if (!row.callSid && callSid && !row.endedAt) await deps.store.update(row.id, { callSid });
  const next = mapCallStatus(callStatus);
  if (next) await deps.store.updateWhereStatus(row.id, next === 'ringing' ? ['queued'] : ['queued', 'ringing'], { status: next });
}

export async function onTransferResult(row: AiCallRow, dialStatus: string, deps: WebhookDeps): Promise<string> {
  if (DIAL_CONNECTED.has(dialStatus)) {
    await deps.store
      .markTransferred(row.id)
      .catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: transferred status write failed'));
    return HANGUP_TWIML;
  }
  deps.log.info({ aiCallId: row.id, dialStatus }, 'ai-voice: transfer did not connect');
  try {
    const was = await deps.store.failTransfer(row.id);
    if (was !== 'none') await deps.effects.transferFailed(toolCtx(row, deps), { finalized: was === 'ended' });
  } catch (e) {
    deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: transfer-failed bookkeeping failed');
  }
  return noRepTwiml();
}

/**
 * An inbound call's stream ended without the call ending. One whose stream never started (no `startedAt`) and is still
 * open is ended as failed here — `endedAt` set, so the inbound webhook finds no open row to stream again — and goes to
 * today's routing, as any inbound AI failure does. A stream that ran is over: hang up.
 */
export async function onInboundStreamEnded(row: AiCallRow, deps: WebhookDeps, apiPublicUrl: string): Promise<string> {
  if (row.direction !== 'inbound' || row.endedAt !== null || streamRan(row)) return HANGUP_TWIML;
  const res = await finalizeAiCall({ store: deps.store, log: deps.log }, row.id, { callStatus: 'failed', durationSeconds: null, endedAt: deps.now() });
  if (!res.finalized) return HANGUP_TWIML; // ended meanwhile (the sweeper, a replay): nothing more to route
  deps.log.warn({ aiCallId: row.id }, 'ai-voice: inbound stream never connected — sent to the usual routing');
  return inboundRoutingTwiml(apiPublicUrl);
}

/** Signs that the conversation began: a start time, a status past ringing, any transcript, or a bridge on this server. */
function streamRan(row: AiCallRow): boolean {
  const transcript: unknown = row.transcript;
  return (
    row.startedAt !== null ||
    !NOT_STARTED_STATUSES.includes(row.status) ||
    (Array.isArray(transcript) && transcript.length > 0) ||
    getActiveCall(row.id)?.bridge != null
  );
}

export function registerAiVoiceWebhooks(app: FastifyInstance, deps: WebhookDeps): void {
  app.post(AMD_PATH, async (req, reply) => {
    if (!validSignature(req)) return reply.code(403).type('text/xml').send(REJECT_TWIML);
    const found = await rowFor(req, deps.store);
    if ('refuse' in found) return refuse(reply, found.refuse);
    if (found.row) await onAmd(found.row, field(req.body, 'AnsweredBy'), deps);
    return xml(reply, EMPTY_TWIML);
  });

  app.post(STATUS_PATH, async (req, reply) => {
    if (!validSignature(req)) return reply.code(403).type('text/xml').send(REJECT_TWIML);
    const found = await rowFor(req, deps.store);
    if ('refuse' in found) return refuse(reply, found.refuse);
    if (found.row) await onStatus(found.row, req.body, deps);
    return xml(reply, EMPTY_TWIML);
  });

  app.post(TRANSFER_RESULT_PATH, async (req, reply) => {
    if (!validSignature(req)) return reply.code(403).type('text/xml').send(REJECT_TWIML);
    const found = await rowFor(req, deps.store);
    if ('refuse' in found) return refuse(reply, found.refuse);
    if (!found.row) return xml(reply, HANGUP_TWIML);
    return xml(reply, await onTransferResult(found.row, field(req.body, 'DialCallStatus'), deps));
  });

  app.post(INBOUND_STREAM_ENDED_PATH, async (req, reply) => {
    if (!validSignature(req)) return reply.code(403).type('text/xml').send(REJECT_TWIML);
    const found = await rowFor(req, deps.store);
    if ('refuse' in found) return refuse(reply, found.refuse);
    if (!found.row) return xml(reply, HANGUP_TWIML);
    try {
      return xml(reply, await onInboundStreamEnded(found.row, deps, loadConfig().API_PUBLIC_URL));
    } catch (e) {
      deps.log.error({ aiCallId: found.row.id, err: errText(e) }, 'ai-voice: inbound stream-ended failed');
      return xml(reply, HANGUP_TWIML);
    }
  });
}
