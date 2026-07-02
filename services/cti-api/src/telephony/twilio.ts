/**
 * Twilio provider implementation.
 *
 * For MVP we use:
 *   - Voice Access Tokens minted on the backend (TWILIO_API_KEY_SID/SECRET)
 *     so the Twilio Voice JS SDK in the renderer can place an outbound call.
 *   - A TwiML Application (TWILIO_TWIML_APP_SID) whose Voice Request URL points
 *     to our /telephony/twilio/voice endpoint; that endpoint returns the <Dial>
 *     verb for the rep-supplied To number.
 *   - Status callbacks POSTed to /telephony/twilio/status, validated using
 *     X-Twilio-Signature against TWILIO_AUTH_TOKEN.
 */
import twilio from 'twilio';
import { loadConfig } from '../config.js';
import type {
  ClientTokenRequest,
  ClientTokenResponse,
  NormalizedCallEvent,
  NormalizedStatus,
  TelephonyProvider,
  WebhookValidation,
} from './types.js';

const STATUS_MAP: Record<string, NormalizedStatus> = {
  queued: 'queued',
  initiated: 'initiating',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
};

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio' as const;

  async createClientToken(req: ClientTokenRequest): Promise<ClientTokenResponse> {
    const cfg = loadConfig();
    const required = [
      cfg.TWILIO_ACCOUNT_SID,
      cfg.TWILIO_API_KEY_SID,
      cfg.TWILIO_API_KEY_SECRET,
      cfg.TWILIO_TWIML_APP_SID,
    ];
    if (required.some((v) => !v)) {
      throw new Error(
        'Twilio is not fully configured (need TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID)',
      );
    }
    const ttl = req.ttlSeconds ?? 3600;
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const accessToken = new AccessToken(
      cfg.TWILIO_ACCOUNT_SID!,
      cfg.TWILIO_API_KEY_SID!,
      cfg.TWILIO_API_KEY_SECRET!,
      { identity: req.identity, ttl },
    );
    const grant = new VoiceGrant({
      outgoingApplicationSid: cfg.TWILIO_TWIML_APP_SID!,
      // Allow the browser softphone to RECEIVE calls: the inbound webhook dials
      // <Client>rep_<userId></Client>, which rings this registered identity. The
      // per-user identity (rep_<userId>) means only the assigned rep's client
      // rings for a callback to their DID.
      incomingAllow: true,
    });
    accessToken.addGrant(grant);

    return {
      token: accessToken.toJwt(),
      identity: req.identity,
      provider: 'twilio',
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  validateWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    url: string,
  ): WebhookValidation {
    const cfg = loadConfig();
    if (!cfg.TWILIO_AUTH_TOKEN) return { valid: false, reason: 'TWILIO_AUTH_TOKEN not set' };
    const sigHeader = headers['x-twilio-signature'];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!signature) return { valid: false, reason: 'Missing X-Twilio-Signature' };

    // Twilio signs application/x-www-form-urlencoded body as sorted key+value concat.
    const params: Record<string, string> = {};
    new URLSearchParams(rawBody).forEach((v, k) => {
      params[k] = v;
    });
    const ok = twilio.validateRequest(cfg.TWILIO_AUTH_TOKEN, signature, url, params);
    return ok ? { valid: true } : { valid: false, reason: 'Bad signature' };
  }

  normalizeWebhook(body: Record<string, unknown>): NormalizedCallEvent | null {
    const callSid = String(body.CallSid ?? '');
    if (!callSid) return null;
    const rawStatus = String(body.CallStatus ?? body.DialCallStatus ?? '');
    const status = STATUS_MAP[rawStatus] ?? 'in_progress';
    // On the parent <Dial action> callback the connected child-leg duration
    // arrives as DialCallDuration, not CallDuration. Without this fallback the
    // sub-6-second robocall-fingerprint signal is blind for bridged calls.
    const durationRaw = body.CallDuration ?? body.DialCallDuration;
    const duration = durationRaw != null ? Number(durationRaw) : undefined;
    const recordingUrl = body.RecordingUrl ? String(body.RecordingUrl) : undefined;
    return {
      providerCallId: callSid,
      status,
      rawStatus,
      durationSeconds: Number.isFinite(duration) ? duration : undefined,
      recordingUrl,
      fromNumber: body.From ? String(body.From) : undefined,
      toNumber: body.To ? String(body.To) : undefined,
      raw: body,
    };
  }
}
