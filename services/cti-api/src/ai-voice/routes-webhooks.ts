/**
 * Twilio's callbacks for an AI call, all signature-checked over the FULL URL
 * (query string included — telephony/webhooks.ts) and keyed by `?aiCallId=`:
 *
 *   amd              async AMD: a machine after the beep gets the voicemail
 *                    (silence the agent, redirect to <Say>); a fax is opted
 *                    out (source ai_call, note 'fax') and hung up.
 *   status           call progress; a terminal status finalizes (idempotent;
 *                    the summary / Salesforce work runs after the reply).
 *   transfer-result  the transfer's <Dial action>: rep answered → status
 *                    `transferred` (the ONLY place that sets it, even after
 *                    finalize), hang up when done; otherwise outcome
 *                    `transfer_failed` and the caller hears a callback promise.
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
import { claimClose, getActiveCall } from './registry.js';
import { localTimeFor } from './service.js';
import { finalizeAiCall, isTerminalCallStatus, mapCallStatus, type AfterCall } from './service-finalize.js';
import type { ToolCtx, ToolEffects } from './service-tools.js';
import type { AiCallRow, AiCallStore } from './store.js';
import { AMD_PATH, STATUS_PATH, TRANSFER_RESULT_PATH, noRepTwiml, voicemailTwiml, type AiVoiceTwilio } from './twilio.js';

export interface WebhookDeps {
  store: AiCallStore;
  twilio: AiVoiceTwilio;
  effects: ToolEffects;
  now: () => Date;
  log: BridgeLog;
  /** Summary + Salesforce after finalize (detached). */
  afterCall?: AfterCall;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
const HANGUP_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const REJECT_TWIML = '<Response><Reject/></Response>';
const LIVE_FOR_VOICEMAIL = ['ringing', 'in_progress'];
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
  return { store: deps.store, aiCallId: row.id, orgId: row.orgId, toE164: row.toE164, log: deps.log, now: deps.now };
}

async function hangUp(callSid: string, deps: WebhookDeps, aiCallId: string): Promise<void> {
  await deps.twilio.hangup(callSid).catch((e: unknown) => deps.log.error({ aiCallId, err: errText(e) }, 'ai-voice: hangup failed'));
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
    await deps.store
      .upsertOptOut(row.orgId, row.toE164, 'fax')
      .catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: fax opt-out write failed'));
    await hangUp(callSid, deps, row.id);
    return;
  }
  if (!answeredBy.startsWith('machine_end')) return; // human / unknown: the agent carries on

  const entry = getActiveCall(row.id);
  if (!entry || !claimClose(row.id)) return; // a tool (or a failure) already owns the end of the call
  entry.bridge?.silence();
  const text = voicemailText({ ...entry.prompt, localTime: localTimeFor(entry.toE164, deps.now()) });
  try {
    await deps.twilio.redirect(callSid, voicemailTwiml(text));
    await deps.store.setOutcome(row.id, 'voicemail', null);
    deps.log.info({ aiCallId: row.id }, 'ai-voice: voicemail left');
  } catch (e) {
    deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: voicemail redirect failed, hanging up');
    await hangUp(callSid, deps, row.id);
  }
}

export async function onStatus(row: AiCallRow, body: unknown, deps: WebhookDeps): Promise<void> {
  const callStatus = field(body, 'CallStatus');
  const callSid = field(body, 'CallSid') || null;
  if (isTerminalCallStatus(callStatus)) {
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
}
