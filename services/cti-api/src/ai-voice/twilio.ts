/**
 * Twilio for AI calls: the TwiML the call runs, the stream's auth token, and a
 * narrow REST port (place / redirect / hang up) that tests replace with a fake.
 *
 * Every TwiML document is built with `twilio.twiml.VoiceResponse`, which
 * escapes attribute values and text — record values (names, ids) are
 * user-controlled and are never concatenated into XML by hand.
 *
 * The `<Stream url>` carries NO query string (Twilio does not support one):
 * the call id and its token travel as `<Parameter>`s and come back in the
 * stream's `start` frame (`customParameters`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import type { AppConfig } from '../config.js';
import { attachCallerParameters, type MatchedCaller } from '../routes/inbound-caller-params.js';
import { repClientIdentity } from '../dialer/twilio-telephony.js';

export const AI_VOICE_TWILIO_PREFIX = '/telephony/twilio/ai-voice';
export const STREAM_PATH = `${AI_VOICE_TWILIO_PREFIX}/stream`;
export const AMD_PATH = `${AI_VOICE_TWILIO_PREFIX}/amd`;
export const STATUS_PATH = `${AI_VOICE_TWILIO_PREFIX}/status`;
export const TRANSFER_RESULT_PATH = `${AI_VOICE_TWILIO_PREFIX}/transfer-result`;

/** How long a transfer rings the rep's softphone before the caller hears NO_REP_TEXT. */
export const TRANSFER_RING_SECONDS = 25;
/** A transferred call is a normal rep conversation: lift the AI call's time limit (Twilio's max, 4 h). */
export const TRANSFER_TIME_LIMIT_SECONDS = 4 * 60 * 60;
/** Extra seconds Twilio allows past the agent's own cap, so the bridge ends the call first. */
const TIME_LIMIT_SLACK_SECONDS = 60;
const RING_TIMEOUT_SECONDS = 30;
const SAY_VOICE = 'Polly.Joanna-Neural';
export const NO_REP_TEXT = "Sorry, our specialist just stepped away — they'll call you right back. Thanks!";

/** Domain separator so a stream token can never double as any other SESSION_SECRET HMAC. */
const TOKEN_CONTEXT = 'ai-voice-stream:';
const TOKEN_RE = /^[0-9a-f]{64}$/;

type Say = { voice: never };
const sayVoice = { voice: SAY_VOICE } as unknown as Say;

/** `wss://<public host>/telephony/twilio/ai-voice/stream` — the URL Twilio connects to and signs. */
export function streamWssUrl(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/^http/, 'ws')}${STREAM_PATH}`;
}

/** A signed Twilio callback URL for one AI call. */
export function callbackUrl(apiPublicUrl: string, path: string, aiCallId: string): string {
  return `${apiPublicUrl}${path}?aiCallId=${encodeURIComponent(aiCallId)}`;
}

export function streamTwiml(i: { wssUrl: string; aiCallId: string; token: string }): string {
  const res = new twilio.twiml.VoiceResponse();
  const stream = res.connect().stream({ url: i.wssUrl });
  stream.parameter({ name: 'aiCallId', value: i.aiCallId });
  stream.parameter({ name: 'token', value: i.token });
  return res.toString();
}

/** HMAC-SHA256 (hex) of the call id: proves a stream `start` frame came from the TwiML we issued. */
export function streamToken(aiCallId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${TOKEN_CONTEXT}${aiCallId}`).digest('hex');
}

export function verifyStreamToken(aiCallId: string, token: string, secret: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const want = Buffer.from(streamToken(aiCallId, secret), 'hex');
  const got = Buffer.from(token, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The rep's softphone identity — shared with the Voice token route (routes/telephony.ts). */
export { repClientIdentity };

export interface TransferTwimlInput {
  /** The hand-off rep's users.id. */
  userId: string;
  /** What the rep's softphone shows as the caller. */
  callerId: string;
  /** The `<Dial action>`: the transfer-result webhook. */
  actionUrl: string;
  /** Name + record for the ring screen (same params the inbound ring uses). */
  caller: MatchedCaller | null;
  /** Why the agent handed off; shown as "AI transfer". */
  reason: string;
}

/**
 * Ring the rep's softphone. Always the `<Identity>` form, because the
 * `aiTransfer` parameter is always attached (Twilio documents `<Parameter>`
 * children only alongside `<Identity>`; see inbound-caller-params.ts).
 */
export function transferTwiml(i: TransferTwimlInput): string {
  const res = new twilio.twiml.VoiceResponse();
  const dial = res.dial({
    callerId: i.callerId,
    timeout: TRANSFER_RING_SECONDS,
    action: i.actionUrl,
    method: 'POST',
  });
  const client = dial.client({});
  client.identity(repClientIdentity(i.userId));
  attachCallerParameters(client, i.caller);
  client.parameter({ name: 'aiTransfer', value: i.reason.slice(0, 64) });
  return res.toString();
}

/** The transfer rang out: a short callback promise, then hang up. */
export function noRepTwiml(): string {
  const res = new twilio.twiml.VoiceResponse();
  res.say(sayVoice, NO_REP_TEXT);
  res.hangup();
  return res.toString();
}

/** Leave the voicemail (text from prompt.ts `voicemailText`) after the beep, then hang up. */
export function voicemailTwiml(text: string): string {
  const res = new twilio.twiml.VoiceResponse();
  res.pause({ length: 1 });
  res.say(sayVoice, text);
  res.hangup();
  return res.toString();
}

/** The slice of the twilio REST client this module uses (a fake in tests). */
export interface AiVoiceTwilioClient {
  calls: ((callSid: string) => {
    update(args: Record<string, unknown>): Promise<unknown>;
    fetch(): Promise<{ status: string; duration?: string | null; answeredBy?: string | null; endTime?: Date | null }>;
  }) & {
    create(args: Record<string, unknown>): Promise<{ sid: string }>;
  };
}

export interface PlaceCallInput {
  to: string;
  from: string;
  twiml: string;
  statusCallback: string;
  amdCallback: string;
  /** Answering-machine detection (default true). Plan 1E: false for a browser leg, which is never a machine. */
  amd?: boolean;
}

export interface AiVoiceTwilio {
  placeCall(i: PlaceCallInput): Promise<{ callSid: string }>;
  /** Replace the call's TwiML. Replacing `<Connect><Stream>` ends the stream (Twilio sends `stop`). */
  redirect(callSid: string, twiml: string, opts?: { timeLimit?: number }): Promise<void>;
  hangup(callSid: string): Promise<void>;
  /** Twilio's record of the call (the stale-call sweep's source of truth). */
  fetchCall(callSid: string): Promise<FetchedCall>;
}

export interface FetchedCall {
  /** Twilio CallStatus: queued | ringing | in-progress | completed | busy | no-answer | failed | canceled. */
  status: string;
  durationSeconds: number | null;
  answeredBy: string | null;
  endTime: Date | null;
}

export function createAiVoiceTwilio(
  cfg: Pick<AppConfig, 'AI_VOICE_MAX_CALL_SECONDS'> & Partial<Pick<AppConfig, 'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN'>>,
  clientFactory: () => AiVoiceTwilioClient = () =>
    twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN) as unknown as AiVoiceTwilioClient,
): AiVoiceTwilio {
  let client: AiVoiceTwilioClient | null = null;
  const rest = (): AiVoiceTwilioClient => (client ??= clientFactory());
  return {
    async placeCall(i) {
      const call = await rest().calls.create({
        to: i.to,
        from: i.from,
        twiml: i.twiml,
        timeout: RING_TIMEOUT_SECONDS,
        ...(i.amd === false
          ? {}
          : {
              machineDetection: 'DetectMessageEnd',
              machineDetectionSpeechThreshold: 1900,
              machineDetectionSpeechEndThreshold: 1400,
              asyncAmd: 'true',
              asyncAmdStatusCallback: i.amdCallback,
              asyncAmdStatusCallbackMethod: 'POST',
            }),
        statusCallback: i.statusCallback,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        timeLimit: cfg.AI_VOICE_MAX_CALL_SECONDS + TIME_LIMIT_SLACK_SECONDS,
      });
      return { callSid: call.sid };
    },
    async redirect(callSid, twiml, opts = {}) {
      await rest().calls(callSid).update({ twiml, ...(opts.timeLimit ? { timeLimit: opts.timeLimit } : {}) });
    },
    async hangup(callSid) {
      await rest().calls(callSid).update({ status: 'completed' });
    },
    async fetchCall(callSid) {
      const c = await rest().calls(callSid).fetch();
      const seconds = Number.parseInt(c.duration ?? '', 10);
      return {
        status: c.status,
        durationSeconds: Number.isFinite(seconds) ? seconds : null,
        answeredBy: c.answeredBy ?? null,
        endTime: c.endTime ?? null,
      };
    },
  };
}
