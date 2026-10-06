/**
 * The AI call gate: may the AI agent place THIS call right now, and from which
 * caller ID?
 *
 * Consent is the hard rule — a call goes out only when the Salesforce record's
 * `AI_Call_Consent__c` is true, or when an ADMIN calls a number on the
 * `AI_VOICE_TEST_NUMBERS` list. Every call, test or not, then passes the same
 * compliance checks the power dialer applies, using the dialer's own functions
 * so the two paths cannot drift:
 *   opt-out / block list / federal DNC  (`blockedTargets`)
 *   FL/OK/WA/MD daily cap               (`dailyDialCount` + `dailyCapCheck`)
 *   recipient-local calling hours       (`withinCallingHours`, with the
 *                                        dialer's DIALER_CALLING_HOURS_EXEMPT
 *                                        allowlist; test numbers skip this)
 *   per-customer ceiling + caller ID    (`pickAiDid`, LAST — it claims a
 *                                        dial against the chosen DID)
 *
 * Every call, test or not, dials from the AI's OWN pool (`ai_pool`,
 * number-pool.ts) — never a rep's or the dialer's number, never
 * TWILIO_DEFAULT_CALLER_ID. No claimable AI number = `no_caller_id`.
 *
 * Plan 1E, the BROWSER branch (practice_browser): the AI rings the admin's own
 * browser tab (`client:aitest_<admin>_<nonce>`), not a phone. After the AI
 * voice switch it needs an admin, an identity that names THIS admin (else
 * `invalid_number`), and a caller ID read (never claimed) from the org's
 * `ai_pool` (`peekAiCallerId`). Opt-out, DNC, state caps, calling hours and
 * the per-customer ceiling are skipped, and no DID dial is claimed, ONLY
 * because no phone number is dialed: nobody's phone rings and nothing about a
 * person or a number is counted.
 *
 * A failed read anywhere THROWS: unlike the dialer's queue build, nothing here
 * fails open — the caller turns the error into a refused call.
 */
import { aiTestIdentityUser } from '@cti/contracts';
import { toE164 } from '@cti/phone';
import { dailyCapCheck, dailyDialCount as realDailyDialCount, isDailyCapped, stateForAreaCode } from '@cti/firewall';
import { aiVoiceAvailable, parseTestNumbers, type AppConfig } from '../config.js';
import { blockedTargets as realBlockedTargets } from '../dialer/consent-check.js';
import { parseCallingHoursExempt, withinCallingHours as realWithinCallingHours, type Db } from '../dialer/pick-did.js';
import { peekAiCallerId as realPeekAiCallerId, pickAiDid as realPickAiDid } from './number-pool.js';
import type { AiCallRecord } from './record.js';

export type AiGateBlock =
  | 'ai_voice_unavailable'
  | 'no_consent'
  | 'consent_field_missing'
  | 'no_phone'
  | 'opted_out'
  | 'blocked'
  | 'dnc'
  | 'daily_cap'
  | 'customer_ceiling'
  | 'calling_hours'
  | 'no_caller_id'
  | 'not_admin_for_test'
  | 'invalid_number';

export type AiGateResult = { ok: true; toE164: string; fromE164: string } | { ok: false; reason: AiGateBlock };

export type AiGateTarget =
  | { kind: 'record'; record: AiCallRecord }
  | { kind: 'test'; toRaw: string }
  | { kind: 'browser'; identity: string };

export interface AiGateInput {
  cfg: AppConfig;
  orgId: string;
  userId: string;
  isAdmin: boolean;
  now: Date;
  target: AiGateTarget;
}

export interface GateDeps {
  blockedTargets: typeof realBlockedTargets;
  dailyDialCount: typeof realDailyDialCount;
  withinCallingHours: typeof realWithinCallingHours;
  pickAiDid: typeof realPickAiDid;
  /** Plan 1E: the browser branch's caller ID, read without claiming a dial. */
  peekAiCallerId: typeof realPeekAiCallerId;
}

const defaultDeps: GateDeps = {
  blockedTargets: realBlockedTargets,
  dailyDialCount: realDailyDialCount,
  withinCallingHours: realWithinCallingHours,
  pickAiDid: realPickAiDid,
  peekAiCallerId: realPeekAiCallerId,
};

const blocked = (reason: AiGateBlock): AiGateResult => ({ ok: false, reason });

/** Consent + number: the record's first phone, or a listed test number for an admin. */
function resolveTarget(input: AiGateInput & { target: Exclude<AiGateTarget, { kind: 'browser' }> }): { toE164: string } | { reason: AiGateBlock } {
  const { target } = input;
  if (target.kind === 'record') {
    if (target.record.consentFieldMissing) return { reason: 'consent_field_missing' };
    if (!target.record.consentAiCall) return { reason: 'no_consent' };
    const first = target.record.phones[0];
    return first ? { toE164: first } : { reason: 'no_phone' };
  }
  if (!input.isAdmin) return { reason: 'not_admin_for_test' };
  const to = toE164(target.toRaw);
  if (!to) return { reason: 'invalid_number' };
  if (!parseTestNumbers(input.cfg.AI_VOICE_TEST_NUMBERS).has(to)) return { reason: 'not_admin_for_test' };
  return { toE164: to };
}

/** The NANP area code's state, as the dialer derives it (`live-deps.ts`); null off-NANP. */
function stateOf(e164: string): string | null {
  return e164.startsWith('+1') ? stateForAreaCode(e164.slice(2, 5)) : null;
}

export async function gateAiCall(db: Db, input: AiGateInput, deps: GateDeps = defaultDeps): Promise<AiGateResult> {
  const { cfg, orgId, userId, now } = input;
  if (!aiVoiceAvailable(cfg)) return blocked('ai_voice_unavailable');
  const { target } = input;
  if (target.kind === 'browser') return gateBrowser(db, { ...input, target }, deps);

  const resolved = resolveTarget({ ...input, target });
  if ('reason' in resolved) return blocked(resolved.reason);
  const to = resolved.toE164;

  const consent = (await deps.blockedTargets(db, orgId, [to])).get(to);
  if (consent) return blocked(consent);

  // Only a capped state costs a count read; an unknown state is not capped.
  const state = stateOf(to);
  if (isDailyCapped(state)) {
    const count = await deps.dailyDialCount(db, orgId, to, now);
    if (!dailyCapCheck(state, count).passed) return blocked('daily_cap');
  }

  if (input.target.kind === 'record') {
    // Exactly the dialer's rule (dialer/live-deps.ts): an allowlisted number
    // skips the guard, every other number must be inside the window.
    const exempt = parseCallingHoursExempt(cfg.DIALER_CALLING_HOURS_EXEMPT);
    if (!exempt.has(to) && !deps.withinCallingHours(to, now)) return blocked('calling_hours');
  }

  const pick = await deps.pickAiDid(db, { orgId, userId, toE164: to });
  if (pick && 'skip' in pick) return blocked('customer_ceiling');
  if (!pick) return blocked('no_caller_id');
  return { ok: true, toE164: to, fromE164: pick.e164 };
}

/** The browser branch (see the header): no phone number is dialed, so only the admin and the identity are checked. */
async function gateBrowser(
  db: Db,
  input: AiGateInput & { target: { kind: 'browser'; identity: string } },
  deps: GateDeps,
): Promise<AiGateResult> {
  if (!input.isAdmin) return blocked('not_admin_for_test');
  const owner = aiTestIdentityUser(input.target.identity);
  if (!owner || owner !== input.userId.toLowerCase()) return blocked('invalid_number');
  const from = await deps.peekAiCallerId(db, input.orgId);
  if (!from) return blocked('no_caller_id');
  return { ok: true, toE164: `client:${input.target.identity}`, fromE164: from };
}
