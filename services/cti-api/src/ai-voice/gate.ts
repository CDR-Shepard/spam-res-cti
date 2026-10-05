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
 *   per-customer ceiling + caller ID    (`pickDidForRun`, LAST — it claims a
 *                                        dial against the chosen DID)
 *
 * A failed read anywhere THROWS: unlike the dialer's queue build, nothing here
 * fails open — the caller turns the error into a refused call.
 */
import { toE164 } from '@cti/phone';
import { dailyCapCheck, dailyDialCount as realDailyDialCount, isDailyCapped, stateForAreaCode } from '@cti/firewall';
import { aiVoiceAvailable, parseTestNumbers, type AppConfig } from '../config.js';
import { blockedTargets as realBlockedTargets } from '../dialer/consent-check.js';
import { parseCallingHoursExempt, withinCallingHours as realWithinCallingHours, type Db } from '../dialer/pick-did.js';
import { pickDidForRun as realPickDidForRun } from '../dialer/pick-agent-did.js';
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

export type AiGateTarget = { kind: 'record'; record: AiCallRecord } | { kind: 'test'; toRaw: string };

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
  pickDidForRun: typeof realPickDidForRun;
}

const defaultDeps: GateDeps = {
  blockedTargets: realBlockedTargets,
  dailyDialCount: realDailyDialCount,
  withinCallingHours: realWithinCallingHours,
  pickDidForRun: realPickDidForRun,
};

const blocked = (reason: AiGateBlock): AiGateResult => ({ ok: false, reason });

/** Consent + number: the record's first phone, or a listed test number for an admin. */
function resolveTarget(input: AiGateInput): { toE164: string } | { reason: AiGateBlock } {
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

  const resolved = resolveTarget(input);
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

  const pick = await deps.pickDidForRun(db, { orgId, userId, toE164: to, runKind: 'pool' });
  if (!pick) return blocked('no_caller_id');
  if ('skip' in pick) return blocked('customer_ceiling');
  return { ok: true, toE164: to, fromE164: pick.e164 };
}
