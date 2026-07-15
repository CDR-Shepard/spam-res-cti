/**
 * Real Twilio implementation of `DialerTelephony` (Plan 3): the power dialer
 * originates the call server-side (no rep leg yet), waits for async AMD to
 * classify human vs. machine/fax, then — only on a human connect —
 * `bridgeToRep` re-points the live call at a per-rep <Conference> so the
 * rep's already-registered softphone (Voice SDK `Client` identity
 * `rep_<userId>`, see routes/telephony.ts `/telephony/token`) can join it.
 *
 * The rep's own join happens from the OTHER side: their softphone calls
 * `device.connect({ params: { DialerConference: '1' } })`, which hits
 * `/telephony/twilio/voice` and (via the additive branch there) returns
 * `bridgeTwiml` for that rep's own conference — see routes/telephony.ts.
 */
import twilio from 'twilio';
import { loadConfig } from '../config.js';
import type { DialerTelephony } from './telephony-port.js';

/**
 * Minimal shape of the twilio REST client surface this module needs. Kept
 * deliberately narrower than the full `Twilio` SDK type so tests can inject a
 * lightweight fake (a stub `calls.create` + callable `calls(sid).update`)
 * without having to satisfy twilio's entire client interface. Mirrors the
 * real SDK's `CallListInstance` shape: callable to get a call's context, plus
 * a `.create()` method.
 */
export interface TwilioDialerClient {
  calls: ((callSid: string) => { update(args: Record<string, unknown>): Promise<unknown> }) & {
    create(args: Record<string, unknown>): Promise<{ sid: string }>;
  };
}

/** PURE: the per-rep power-dialer conference name. Dashes are stripped so the
 *  same transform applied to a full UUID or an already-stripped id is a
 *  no-op — routes/telephony.ts's conference-join branch relies on this. */
export function conferenceName(userId: string): string {
  return `pd_${userId.replace(/-/g, '')}`;
}

/** PURE: TwiML that bridges whichever leg it's applied to into the rep's
 *  power-dialer conference. `startConferenceOnEnter` so the conference goes
 *  live as soon as either party (prospect or rep) joins. `endOnExit` controls
 *  `endConferenceOnExit` and MUST differ per leg: the rep leg ends the
 *  conference when the rep leaves (that's what ends the dialer run), but the
 *  prospect leg must NOT end it when the prospect hangs up — otherwise the
 *  very first prospect to hang up destroys the conference out from under the
 *  rep, who only joins once and has no rejoin-on-connect. See
 *  `dialerConferenceTwiml` (rep leg, endOnExit=true) and `bridgeToRep`
 *  (prospect leg, endOnExit=false). Built via `twilio.twiml.VoiceResponse` so
 *  attribute escaping matches what Twilio itself expects. */
export function bridgeTwiml(userId: string, endOnExit: boolean): string {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    { startConferenceOnEnter: true, endConferenceOnExit: endOnExit },
    conferenceName(userId),
  );
  return twiml.toString();
}

/** The bridge TwiML for a rep joining their own dialer conference, derived from
 *  Twilio's signed `From: client:rep_<id>` field. Returns null when From isn't a
 *  valid rep-client identity (caller should render an error instead).
 *  `endOnExit: true` — the rep leaving is what ends the dialer run/conference. */
export function dialerConferenceTwiml(from: string): string | null {
  const m = /^client:rep_([0-9a-f]+)$/i.exec(from);
  return m ? bridgeTwiml(m[1]!, true) : null;
}

export class TwilioDialerTelephony implements DialerTelephony {
  constructor(
    private clientFactory: () => TwilioDialerClient = () => {
      const cfg = loadConfig();
      return twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN) as unknown as TwilioDialerClient;
    },
  ) {}

  /**
   * Server-originate the screening call: no rep leg yet, just Twilio calling
   * the recipient with async AMD enabled so the human/machine classification
   * happens off the critical path (asyncAmd) and posts back to
   * `/telephony/twilio/dialer-amd`. `/telephony/twilio/dialer-answer` is the
   * TwiML the call plays while AMD runs (hold music / silence) until
   * `bridgeToRep` re-points it.
   */
  async originate(a: {
    sessionId: string;
    itemId: string;
    fromE164: string;
    toE164: string;
    userId: string;
  }): Promise<{ callId: string }> {
    const cfg = loadConfig();
    const client = this.clientFactory();
    const result = await client.calls.create({
      to: a.toE164,
      from: a.fromE164,
      machineDetection: 'Enable',
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${cfg.API_PUBLIC_URL}/telephony/twilio/dialer-amd?itemId=${a.itemId}`,
      asyncAmdStatusCallbackMethod: 'POST',
      url: `${cfg.API_PUBLIC_URL}/telephony/twilio/dialer-answer`,
      statusCallback: `${cfg.API_PUBLIC_URL}/telephony/twilio/dialer-status?itemId=${a.itemId}`,
      statusCallbackEvent: ['completed'],
      // NOTE: dialer recording is a separate, deliberate decision — the screening leg must NOT be recorded (prospect answers before a rep is present / disclosed to).
    } as never);
    return { callId: result.sid };
  }

  /** Re-point the already-live call at the rep's conference once AMD confirms a
   *  human. `endOnExit: false` — the prospect hanging up must NOT tear down the
   *  conference; the rep is waiting there across the whole run and only the
   *  rep leaving (dialerConferenceTwiml, endOnExit=true) should end it. */
  async bridgeToRep(callId: string, userId: string): Promise<void> {
    const client = this.clientFactory();
    await client.calls(callId).update({ twiml: bridgeTwiml(userId, false) } as never);
  }

  /** Hang up (skip/stop): end the call outright rather than routing it anywhere. */
  async hangup(callId: string): Promise<void> {
    const client = this.clientFactory();
    await client.calls(callId).update({ status: 'completed' } as never);
  }
}
