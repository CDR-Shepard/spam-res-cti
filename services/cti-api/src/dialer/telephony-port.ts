export interface DialerTelephony {
  originate(a: { sessionId: string; itemId: string; fromE164: string; toE164: string; userId: string }): Promise<{ callId: string }>;
  bridgeToRep(callId: string, userId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  /**
   * End the rep's power-dialer conference when their run ends. Normally the
   * rep's own softphone leg collapses it (that leg joins with
   * `endConferenceOnExit=true`), so this is the server-side backstop for when
   * the client never disconnects — tab switched away mid-run, asleep, or
   * polling stalled. Without it the leg (and its billing) lingers and the rep's
   * single Twilio Device stays busy, failing their next call. Idempotent: a
   * no-op when no conference for this rep is in progress.
   */
  endConference(userId: string): Promise<void>;
}

/** Placeholder until Plan 3 supplies the Twilio implementation. */
export const noopTelephony: DialerTelephony = {
  async originate() { throw new Error('DialerTelephony not configured (Plan 3)'); },
  async bridgeToRep() { /* noop */ },
  async hangup() { /* noop */ },
  async endConference() { /* noop */ },
};
