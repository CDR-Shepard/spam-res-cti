/**
 * Pure helpers for attaching the inbound caller's Salesforce match to the
 * ringing `<Dial><Client>` as Twilio custom parameters, so the Voice JS SDK
 * client can show a name/record type on the ring screen and screen-pop on
 * accept — instead of the match evaporating once the softphone starts
 * ringing (it's already used server-side for the voicemail greeting + Task
 * attachment, see inbound.ts).
 *
 * Isolated from the Fastify/DB plumbing in inbound.ts (same pattern as
 * inbound-forward.ts) so this is unit-testable without a live Twilio call.
 *
 * These parameter values (name, record id) come straight from Salesforce and
 * are user-controlled — the twilio-node TwiML builder escapes attribute
 * values for us, so we always go through `.parameter(...)`, never hand-build
 * the `<Parameter>` XML ourselves.
 */

/** The caller-match shape produced by `findByPhone` (services/cti-api/src/salesforce/client.ts). */
export interface MatchedCaller {
  whoId?: string;
  whatId?: string;
  name?: string;
}

/**
 * Minimal shape of whatever `dial.client(...)` returns from twilio-node —
 * real callers pass the actual `VoiceResponse.Dial.Client`, whose
 * `.parameter(...)` emits an escaped `<Parameter name=".." value=".."/>`
 * child. Confirmed in the installed twilio-node types:
 * node_modules/twilio/lib/twiml/VoiceResponse.d.ts:1764 (`export class Client`)
 * and :1783 (`Client#parameter`).
 */
export interface ParameterAttachable {
  parameter(attributes: { name: string; value: string }): unknown;
}

const LEAD_ID_PREFIX = '00Q';
const CONTACT_ID_PREFIX = '003';
const OPPORTUNITY_ID_PREFIX = '006';

/**
 * Salesforce id prefix -> human label for the ring screen. Custom-object
 * prefixes (e.g. an org's Deal__c) vary per org and aren't enumerable here,
 * so anything we don't recognize gets the honest "Record" fallback rather
 * than a hardcoded guess.
 */
export function recordTypeForId(id: string): string {
  if (id.startsWith(LEAD_ID_PREFIX)) return 'Lead';
  if (id.startsWith(CONTACT_ID_PREFIX)) return 'Contact';
  if (id.startsWith(OPPORTUNITY_ID_PREFIX)) return 'Opportunity';
  return 'Record';
}

/**
 * Attach `callerName` / `recordId` / `recordType` custom parameters to a
 * `<Client>` noun when the caller matched a Salesforce record. An unmatched
 * caller (`matched` is null/undefined, or has neither id) gets NO
 * parameters at all — identical TwiML to before this feature existed.
 */
export function attachCallerParameters(
  client: ParameterAttachable,
  matched: MatchedCaller | null | undefined,
): void {
  if (!matched) return;
  if (matched.name) client.parameter({ name: 'callerName', value: matched.name });
  const recordId = matched.whoId ?? matched.whatId;
  if (!recordId) return;
  client.parameter({ name: 'recordId', value: recordId });
  client.parameter({ name: 'recordType', value: recordTypeForId(recordId) });
}
