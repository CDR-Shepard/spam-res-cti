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

/**
 * A `<Client>` noun that can ALSO carry an `<Identity>` child — the
 * documented way to set the client identity when `<Parameter>` children are
 * also attached (see `dialClientWithCallerParams` below). Confirmed in the
 * installed twilio-node types:
 * node_modules/twilio/lib/twiml/VoiceResponse.d.ts:1776 (`Client#identity`).
 */
export interface ClientLike extends ParameterAttachable {
  identity(clientIdentity: string): unknown;
}

/**
 * Minimal shape of whatever `t.dial(...)` returns from twilio-node — real
 * callers pass the actual `VoiceResponse.Dial`. Confirmed in the installed
 * twilio-node types: node_modules/twilio/lib/twiml/VoiceResponse.d.ts:1918
 * (`Dial#client`).
 */
export interface DialLike {
  client(attributes?: object, identity?: string): ClientLike;
}

const LEAD_ID_PREFIX = '00Q';
const CONTACT_ID_PREFIX = '003';
const OPPORTUNITY_ID_PREFIX = '006';

/** XML 1.0 forbids these control characters outright (everything except tab
 *  #x9, LF #xA, and CR #xD) — Salesforce-sourced values are user-controlled,
 *  so one of these getting through would not just look wrong, it would
 *  break the ring's TwiML. Cap length too: these are display values for a
 *  ring screen, not a payload. */
const XML_ILLEGAL_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const MAX_PARAMETER_VALUE_LENGTH = 200;

function sanitizeParameterValue(value: string): string {
  return value.replace(XML_ILLEGAL_CONTROL_CHARS_RE, '').slice(0, MAX_PARAMETER_VALUE_LENGTH);
}

function setParameter(client: ParameterAttachable, name: string, value: string): void {
  client.parameter({ name, value: sanitizeParameterValue(value) });
}

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

/** Whether `matched` carries anything `attachCallerParameters` would actually attach. */
function hasCallerParameters(matched: MatchedCaller | null | undefined): matched is MatchedCaller {
  return !!matched && !!(matched.name || matched.whoId || matched.whatId);
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
  if (matched.name) setParameter(client, 'callerName', matched.name);
  const recordId = matched.whoId ?? matched.whatId;
  if (!recordId) return;
  setParameter(client, 'recordId', recordId);
  setParameter(client, 'recordType', recordTypeForId(recordId));
}

/**
 * Build the ringing `<Dial><Client>` for a rep, choosing the TwiML shape
 * Twilio actually documents. Twilio does NOT document `<Client>` text
 * content mixed with `<Parameter>` children — when there are caller
 * parameters to attach, the identity must instead be set via the
 * `<Identity>` noun:
 *   `<Client><Identity>rep_x</Identity><Parameter .../></Client>`
 * With no Salesforce match (nothing to attach), this stays byte-identical
 * to how the ring has always looked — identity as `<Client>` text content,
 * no `<Identity>`, no `<Parameter>`:
 *   `<Client>rep_x</Client>`
 * Both ring sites in inbound.ts call this so the branch can't drift between them.
 */
export function dialClientWithCallerParams(
  dial: DialLike,
  identity: string,
  matched: MatchedCaller | null | undefined,
): ClientLike {
  if (!hasCallerParameters(matched)) return dial.client({}, identity);
  const client = dial.client({});
  client.identity(identity);
  attachCallerParameters(client, matched);
  return client;
}
