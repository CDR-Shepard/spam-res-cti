import type { Db } from '@cti/db';

export type { Db };

export type Decision = 'ALLOW' | 'BLOCK' | 'REQUIRE_REVIEW';

export interface FirewallInput {
  orgId: string;
  userId: string;
  toNumberRaw: string;
  fromNumber?: string;
  campaignKey?: string;
  /** IANA tz (e.g. "America/Los_Angeles"). Used for calling-hours check. */
  recipientTimezone?: string;
  /**
   * Optional Salesforce record id (Lead/Contact) the click-to-dial originated
   * from. When supplied AND the rep has an active SF OAuth connection, we
   * fetch the record's State / Country and derive recipientTimezone from it.
   */
  recipientRecordId?: string;
  requestId?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  severity: 'block' | 'review' | 'info';
  reasonCode: string;
  detail?: string;
}

export interface FirewallResponse {
  decision: Decision;
  reasons: string[];
  blockReason: string | null;
  requiredScriptId: string | null;
  auditId: string;
  checks: CheckResult[];
  normalizedTo: string | null;
  fromNumber: string | null;
}

/** What the recipient-address port returns: enough to derive timezone and state. */
export interface RecipientAddress {
  state: string | null;
  country: string | null;
  postalCode?: string | null;
  /** Free-form label used in the audit detail, e.g. "Lead" or "Contact". */
  objectType: string;
}

/**
 * Outward dependencies of `evaluate`, injected by the hosting service so the
 * package has no CRM import. When `fetchRecipientAddress` is absent,
 * `FirewallInput.recipientRecordId` is ignored and timezone/state fall back to
 * the dialed number's area code exactly as when no record id is supplied.
 */
export interface FirewallDeps {
  fetchRecipientAddress?: (userId: string, recordId: string) => Promise<RecipientAddress | null>;
}
