/**
 * Telephony provider abstraction.
 * The MVP wires Twilio; Telnyx implements the same interface.
 */

export type NormalizedStatus =
  | 'queued'
  | 'initiating'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'canceled';

export interface ClientTokenRequest {
  userId: string;
  /** Identity string presented in the JWT (sub). Should be stable per rep. */
  identity: string;
  /** TTL in seconds. */
  ttlSeconds?: number;
}

export interface ClientTokenResponse {
  token: string;
  identity: string;
  provider: 'twilio' | 'telnyx';
  expiresAt: string;
}

export interface WebhookValidation {
  valid: boolean;
  reason?: string;
}

export interface NormalizedCallEvent {
  providerCallId: string;
  status: NormalizedStatus;
  rawStatus: string;
  durationSeconds?: number;
  recordingUrl?: string;
  startedAt?: Date;
  answeredAt?: Date;
  endedAt?: Date;
  fromNumber?: string;
  toNumber?: string;
  raw: unknown;
}

export interface TelephonyProvider {
  readonly name: 'twilio' | 'telnyx';

  /** Mint a short-lived WebRTC/access token for the desktop SDK. */
  createClientToken(req: ClientTokenRequest): Promise<ClientTokenResponse>;

  /**
   * Validate an inbound webhook (signature, etc).
   * Returns { valid:false } if signature is missing or wrong.
   */
  validateWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, url: string): WebhookValidation;

  /** Normalize a provider webhook body into a generic event. */
  normalizeWebhook(body: Record<string, unknown>): NormalizedCallEvent | null;
}
