export interface DialerTelephony {
  originate(a: { sessionId: string; itemId: string; fromE164: string; toE164: string; userId: string }): Promise<{ callId: string }>;
  bridgeToRep(callId: string, userId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
}

/** Placeholder until Plan 3 supplies the Twilio implementation. */
export const noopTelephony: DialerTelephony = {
  async originate() { throw new Error('DialerTelephony not configured (Plan 3)'); },
  async bridgeToRep() { /* noop */ },
  async hangup() { /* noop */ },
};
