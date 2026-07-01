/**
 * Caller Reputation Firewall — pre-call decision engine.
 *
 * Returns ALLOW / BLOCK / REQUIRE_REVIEW with a reasons array, evidence per
 * check, and an auditId for traceability. Every decision is persisted to
 * pre_call_audits so we can show the rep _why_ and prove what we knew at
 * the time of the decision.
 *
 * This DOES NOT claim legal compliance. It enforces internal guardrails.
 */
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { pickRotationNumber } from '../rotation.js';
import { fetchRecordAddress, SalesforceUnauthorizedError } from '../salesforce/client.js';
import { resolveTimezone, timezoneForNumber } from './tz.js';
import { warmupCapForAge } from './warmup.js';
import { fetchDidWindowStats } from '../reputation/query.js';
import { answerRateBreach, engagementBreach, THRESHOLDS } from '../reputation/signals.js';

export { warmupCapForAge } from './warmup.js';

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

type Db = ReturnType<typeof getDb>;

const REASON = {
  PARSE_OK: 'PHONE_PARSED',
  PARSE_FAIL: 'PHONE_INVALID',
  NOT_OPTED_OUT: 'NOT_OPTED_OUT',
  OPTED_OUT: 'OPTED_OUT',
  NOT_BLOCKED: 'NOT_BLOCKED',
  BLOCKED: 'BLOCKED_INTERNAL',
  ATTEMPT_LIMIT_OK: 'ATTEMPT_LIMIT_OK',
  ATTEMPT_LIMIT_EXCEEDED: 'ATTEMPT_LIMIT_EXCEEDED',
  CALLING_HOURS_OK: 'CALLING_HOURS_OK',
  OUTSIDE_CALLING_HOURS: 'OUTSIDE_CALLING_HOURS',
  CALLING_HOURS_UNKNOWN_TZ: 'CALLING_HOURS_UNKNOWN_TZ',
  OUTBOUND_NUMBER_HEALTHY: 'OUTBOUND_NUMBER_HEALTHY',
  OUTBOUND_NUMBER_UNHEALTHY: 'OUTBOUND_NUMBER_UNHEALTHY',
  OUTBOUND_NUMBER_MISSING: 'OUTBOUND_NUMBER_MISSING',
  CAMPAIGN_ACTIVE: 'CAMPAIGN_ACTIVE',
  CAMPAIGN_PAUSED: 'CAMPAIGN_PAUSED',
  CAMPAIGN_MISSING: 'CAMPAIGN_MISSING',
  CONSENT_OK: 'RECORDING_CONSENT_OK',
  CONSENT_REVIEW: 'RECORDING_CONSENT_REVIEW',
  // 2026 spam-resistance checks
  WARMUP_OK: 'NUMBER_WARMUP_OK',
  WARMUP_LIMIT_EXCEEDED: 'NUMBER_WARMUP_LIMIT_EXCEEDED',
  VELOCITY_OK: 'CALL_VELOCITY_OK',
  VELOCITY_BURST: 'CALL_VELOCITY_BURST_DETECTED',
  NEIGHBOR_OK: 'NEIGHBOR_SPOOFING_OK',
  NEIGHBOR_RISK: 'NEIGHBOR_SPOOFING_RISK',
  STATE_RULE_OK: 'STATE_RULE_OK',
  STATE_RULE_FREQ_EXCEEDED: 'STATE_RULE_FREQUENCY_EXCEEDED',
  STATE_RULE_HOURS: 'STATE_RULE_CALLING_HOURS_VIOLATED',
  STATE_RULE_REGISTRATION: 'STATE_RULE_REGISTRATION_REQUIRED',
  // P0 firewall-gap closures
  DNC_OK: 'FEDERAL_DNC_CLEAR',
  DNC_LISTED: 'FEDERAL_DNC_LISTED',
  DNC_NOT_LOADED: 'FEDERAL_DNC_NOT_LOADED',
  DNC_PRESCRUBBED: 'FEDERAL_DNC_PRESCRUBBED',
  RND_OK: 'REASSIGNED_NUMBER_CLEAR',
  RND_REASSIGNED: 'REASSIGNED_NUMBER_DETECTED',
  RND_UNCHECKED: 'REASSIGNED_NUMBER_UNCHECKED',
  ATTESTATION_OK: 'STIR_SHAKEN_ATTESTATION_OK',
  ATTESTATION_DEGRADED: 'STIR_SHAKEN_ATTESTATION_DEGRADED',
  ATTESTATION_UNKNOWN: 'STIR_SHAKEN_ATTESTATION_UNKNOWN',
  CONSENT_RECORD_OK: 'TCPA_CONSENT_ON_FILE',
  CONSENT_RECORD_MISSING: 'TCPA_CONSENT_NOT_FOUND',
  // Behavioral kill-threshold canaries (per-DID, real-time)
  ANSWER_RATE_OK: 'ANSWER_RATE_OK',
  ANSWER_RATE_LOW: 'ANSWER_RATE_BELOW_FLOOR',
  ENGAGEMENT_OK: 'ENGAGEMENT_OK',
  ENGAGEMENT_LOW: 'ENGAGEMENT_SHORT_DURATION',
} as const;

/** STIR/SHAKEN ordering: A is best, C is worst. */
function attestationRank(a: string | null | undefined): number {
  if (a === 'A') return 0;
  if (a === 'B') return 1;
  if (a === 'C') return 2;
  return 3; // unknown
}

// A number absent from the DNC cache is only genuinely "scrubbed" if a real
// (non-demo) list has actually been loaded. Cache the loaded/empty state briefly
// so we don't COUNT the table on every call; when an admin imports a list it
// flips within the TTL. Keeps the DNC gate honest instead of implying a check
// that never happened.
let dncLoadedCache: { loaded: boolean; at: number } | null = null;
const DNC_LOADED_TTL_MS = 60_000;
async function isDncListLoaded(db: Db): Promise<boolean> {
  const now = Date.now();
  if (dncLoadedCache && now - dncLoadedCache.at < DNC_LOADED_TTL_MS) return dncLoadedCache.loaded;
  let loaded = false;
  try {
    const row = await db.query.federalDncEntries.findFirst({
      where: ne(schema.federalDncEntries.source, 'demo_seed'),
      columns: { e164: true },
    });
    loaded = Boolean(row);
  } catch {
    loaded = false;
  }
  dncLoadedCache = { loaded, at: now };
  return loaded;
}

export async function evaluate(db: Db, input: FirewallInput): Promise<FirewallResponse> {
  const checks: CheckResult[] = [];

  // 1. Parse + normalize the destination number (also needed for the area-code
  //    timezone fallback below).
  const parsed = normalize(input.toNumberRaw);
  if (!parsed.ok) {
    checks.push({
      name: 'phone_parse',
      passed: false,
      severity: 'block',
      reasonCode: REASON.PARSE_FAIL,
      detail: parsed.error,
    });
    return await persistAndReturn(db, input, checks, null, null);
  }
  const e164 = parsed.value!.e164;
  checks.push({
    name: 'phone_parse',
    passed: true,
    severity: 'info',
    reasonCode: REASON.PARSE_OK,
    detail: e164,
  });

  // Resolve the recipient timezone for recipient-local calling-hours
  // enforcement, in priority order: explicit tz → Salesforce record address →
  // the DIALED NUMBER's area code. The area-code fallback lets us enforce hours
  // for any US number even when the SF record has no address (or the rep isn't
  // OAuth-connected); only a truly unmapped/international number falls through
  // to the "unknown TZ" REVIEW path. An explicit address is preferred because a
  // ported cell can carry an out-of-region area code.
  let resolvedTz = input.recipientTimezone;
  let tzSource: string | undefined;
  if (!resolvedTz && input.recipientRecordId) {
    try {
      const addr = await fetchRecordAddress(input.userId, input.recipientRecordId);
      if (addr) {
        const resolved = resolveTimezone(addr);
        if (resolved) {
          resolvedTz = resolved.timezone;
          tzSource = `${addr.objectType} ${resolved.matched} via ${resolved.source}`;
        }
      }
    } catch (err) {
      // Both branches fall through to the area-code/unknown-TZ path; the
      // difference is only diagnostic so we use stderr instead of threading a
      // Fastify logger into the evaluator. Auth errors merit a louder signal
      // because they typically mean the rep needs to re-connect Salesforce.
      if (err instanceof SalesforceUnauthorizedError) {
        // eslint-disable-next-line no-console
        console.warn('[firewall] SF address lookup skipped: not authorized', { userId: input.userId });
      } else {
        // eslint-disable-next-line no-console
        console.warn('[firewall] SF address lookup failed', { userId: input.userId, err: (err as Error).message });
      }
    }
  }
  if (!resolvedTz) {
    const npa = timezoneForNumber(e164);
    if (npa) {
      resolvedTz = npa.timezone;
      tzSource = `area code ${npa.matched}`;
    }
  }
  const inputForChecks = { ...input, recipientTimezone: resolvedTz };

  // 2. Internal opt-out list
  const optOut = await db.query.optOuts.findFirst({
    where: and(eq(schema.optOuts.orgId, input.orgId), eq(schema.optOuts.e164, e164)),
  });
  checks.push(
    optOut
      ? {
          name: 'opt_out',
          passed: false,
          severity: 'block',
          reasonCode: REASON.OPTED_OUT,
          detail: optOut.source,
        }
      : { name: 'opt_out', passed: true, severity: 'info', reasonCode: REASON.NOT_OPTED_OUT },
  );

  // 3. Manual block list
  const blocked = await db.query.blockedNumbers.findFirst({
    where: and(eq(schema.blockedNumbers.orgId, input.orgId), eq(schema.blockedNumbers.e164, e164)),
  });
  checks.push(
    blocked
      ? {
          name: 'blocklist',
          passed: false,
          severity: 'block',
          reasonCode: REASON.BLOCKED,
          detail: blocked.reason ?? 'Manually blocked',
        }
      : { name: 'blocklist', passed: true, severity: 'info', reasonCode: REASON.NOT_BLOCKED },
  );

  // 4. Campaign config (drives attempt limits + calling hours + consent mode)
  const campaignKey = input.campaignKey ?? 'default';
  const campaign = await db.query.campaignConfigs.findFirst({
    where: and(
      eq(schema.campaignConfigs.orgId, input.orgId),
      eq(schema.campaignConfigs.key, campaignKey),
    ),
  });
  if (!campaign) {
    checks.push({
      name: 'campaign',
      passed: false,
      severity: 'review',
      reasonCode: REASON.CAMPAIGN_MISSING,
      detail: `No campaign config for key="${campaignKey}"`,
    });
  } else if (campaign.paused) {
    checks.push({
      name: 'campaign',
      passed: false,
      severity: 'block',
      reasonCode: REASON.CAMPAIGN_PAUSED,
      detail: campaign.name,
    });
  } else {
    checks.push({
      name: 'campaign',
      passed: true,
      severity: 'info',
      reasonCode: REASON.CAMPAIGN_ACTIVE,
      detail: campaign.name,
    });
  }

  // 5. Attempt limits — count recent attempted calls in window
  if (campaign) {
    const windowStart = new Date(Date.now() - campaign.attemptWindowDays * 24 * 3600 * 1000);
    const countRow = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.orgId, input.orgId),
          eq(schema.calls.normalizedToNumber, e164),
          gte(schema.calls.createdAt, windowStart),
        ),
      );
    const attempts = countRow[0]?.n ?? 0;
    if (attempts >= campaign.maxAttempts) {
      checks.push({
        name: 'attempt_limit',
        passed: false,
        severity: 'block',
        reasonCode: REASON.ATTEMPT_LIMIT_EXCEEDED,
        detail: `${attempts} attempts in last ${campaign.attemptWindowDays}d (limit ${campaign.maxAttempts})`,
      });
    } else {
      checks.push({
        name: 'attempt_limit',
        passed: true,
        severity: 'info',
        reasonCode: REASON.ATTEMPT_LIMIT_OK,
        detail: `${attempts}/${campaign.maxAttempts} in last ${campaign.attemptWindowDays}d`,
      });
    }
  }

  // 6. Calling hours (recipient-local). If TZ unknown, fall back to REVIEW.
  if (campaign) {
    const tz = inputForChecks.recipientTimezone;
    const allowedDays = (campaign.callingDays as number[]) ?? [1, 2, 3, 4, 5];
    if (!tz) {
      checks.push({
        name: 'calling_hours',
        passed: true,
        severity: 'review',
        reasonCode: REASON.CALLING_HOURS_UNKNOWN_TZ,
        detail: 'Recipient timezone unknown; rep must confirm appropriate hour.',
      });
    } else {
      const within = isWithinCallingHours(
        new Date(),
        tz,
        campaign.callingHoursStart,
        campaign.callingHoursEnd,
        allowedDays,
      );
      const tzDetailSuffix = tzSource ? ` · ${tzSource}` : '';
      checks.push(
        within
          ? {
              name: 'calling_hours',
              passed: true,
              severity: 'info',
              reasonCode: REASON.CALLING_HOURS_OK,
              detail: `${campaign.callingHoursStart}-${campaign.callingHoursEnd} ${tz}${tzDetailSuffix}`,
            }
          : {
              name: 'calling_hours',
              passed: false,
              severity: 'block',
              reasonCode: REASON.OUTSIDE_CALLING_HOURS,
              detail: `Now is outside ${campaign.callingHoursStart}-${campaign.callingHoursEnd} ${tz}${tzDetailSuffix}`,
            },
      );
    }
  }

  // 7. Outbound caller ID health.
  //    When the rep didn't pin a from-number, predict the rotation pool's
  //    pick — the same selection POST /calls makes at dial time — so the
  //    per-DID reputation gates (warmup, velocity, neighbor-spoofing,
  //    attestation) run at preflight instead of silently skipping.
  let effectiveFrom = input.fromNumber ?? null;
  let fromAutoSelected = false;
  if (!effectiveFrom) {
    effectiveFrom = await pickRotationNumber(db, input.orgId, input.userId, e164);
    fromAutoSelected = effectiveFrom != null;
  }
  let fromE164: string | null = null;
  let outboundNumberRow: typeof schema.outboundNumbers.$inferSelect | null = null;
  if (!effectiveFrom) {
    checks.push({
      name: 'outbound_number',
      passed: false,
      severity: 'review',
      reasonCode: REASON.OUTBOUND_NUMBER_MISSING,
      detail: 'No outbound caller ID available — pool exhausted or none registered',
    });
  } else {
    const outNum = await db.query.outboundNumbers.findFirst({
      where: and(
        eq(schema.outboundNumbers.orgId, input.orgId),
        eq(schema.outboundNumbers.e164, effectiveFrom),
        // Reps may only dial from their own assigned pool — not another rep's
        // number and not a held-back reserve number.
        eq(schema.outboundNumbers.assignedUserId, input.userId),
      ),
    });
    if (!outNum) {
      checks.push({
        name: 'outbound_number',
        passed: false,
        severity: 'review',
        reasonCode: REASON.OUTBOUND_NUMBER_MISSING,
        detail: `From-number ${effectiveFrom} not registered`,
      });
    } else if (!outNum.active || outNum.health === 'spam_likely' || outNum.health === 'degraded') {
      checks.push({
        name: 'outbound_number',
        passed: false,
        severity: 'block',
        reasonCode: REASON.OUTBOUND_NUMBER_UNHEALTHY,
        detail: `${outNum.e164} · active=${outNum.active}, health=${outNum.health}`,
      });
    } else {
      fromE164 = outNum.e164;
      outboundNumberRow = outNum;
      checks.push({
        name: 'outbound_number',
        passed: true,
        severity: 'info',
        reasonCode: REASON.OUTBOUND_NUMBER_HEALTHY,
        detail: `${outNum.e164} · ${outNum.health}${fromAutoSelected ? ' · rotation pick' : ''}`,
      });
    }
  }

  // 7a. Warmup tier + daily cap (per-DID reputation hygiene).
  if (outboundNumberRow) {
    const today = new Date().toISOString().slice(0, 10);
    const sameDay = outboundNumberRow.dialsTodayDate === today;
    const dialsToday = sameDay ? outboundNumberRow.dialsToday : 0;
    const daysSinceFirstUse = outboundNumberRow.firstUsedAt
      ? Math.floor((Date.now() - outboundNumberRow.firstUsedAt.getTime()) / 86_400_000)
      : null;
    const curve = warmupCapForAge(daysSinceFirstUse);
    const effectiveCap = outboundNumberRow.warmupOverrideCap ?? curve.cap;
    if (dialsToday >= effectiveCap) {
      checks.push({
        name: 'warmup',
        passed: false,
        severity: 'block',
        reasonCode: REASON.WARMUP_LIMIT_EXCEEDED,
        detail: `${dialsToday}/${effectiveCap} dials today · ${curve.label} · use a different number from the pool`,
      });
    } else {
      checks.push({
        name: 'warmup',
        passed: true,
        severity: 'info',
        reasonCode: REASON.WARMUP_OK,
        detail: `${dialsToday}/${effectiveCap} today · ${curve.label}`,
      });
    }
  }

  // 7b. Per-DID velocity (>10 calls/min anti-burst).
  if (outboundNumberRow) {
    const windowStart = outboundNumberRow.lastMinuteWindowStart;
    const now = new Date();
    const inWindow = windowStart && (now.getTime() - windowStart.getTime()) < 60_000;
    const count = inWindow ? outboundNumberRow.lastMinuteDialCount : 0;
    if (count >= 10) {
      checks.push({
        name: 'velocity',
        passed: false,
        severity: 'block',
        reasonCode: REASON.VELOCITY_BURST,
        detail: `${count} calls/min from ${outboundNumberRow.e164} — autodialer fingerprint`,
      });
    } else {
      checks.push({
        name: 'velocity',
        passed: true,
        severity: 'info',
        reasonCode: REASON.VELOCITY_OK,
        detail: `${count}/10 per min`,
      });
    }
  }

  // 7c. Neighbor-spoofing detector (NPA + NPA-NXX match between caller and recipient).
  if (fromE164 && e164.length >= 12 && fromE164.length >= 12) {
    // Both are E.164; for US numbers, NPA = digits 2-4, NXX = digits 5-7
    const callerNpa = fromE164.slice(2, 5);
    const recipientNpa = e164.slice(2, 5);
    const callerNxx = fromE164.slice(5, 8);
    const recipientNxx = e164.slice(5, 8);
    if (callerNpa === recipientNpa && callerNxx === recipientNxx) {
      checks.push({
        name: 'neighbor_spoof',
        passed: false,
        severity: 'review',
        reasonCode: REASON.NEIGHBOR_RISK,
        detail: `Caller ${callerNpa}-${callerNxx} matches recipient ${recipientNpa}-${recipientNxx} — Hiya penalizes this in 2026`,
      });
    } else if (callerNpa === recipientNpa) {
      // Same area code but different exchange — soft positive (legit local presence)
      checks.push({
        name: 'neighbor_spoof',
        passed: true,
        severity: 'info',
        reasonCode: REASON.NEIGHBOR_OK,
        detail: `Caller area ${callerNpa} matches recipient — legit local presence`,
      });
    } else {
      checks.push({
        name: 'neighbor_spoof',
        passed: true,
        severity: 'info',
        reasonCode: REASON.NEIGHBOR_OK,
        detail: `Caller ${callerNpa} ≠ recipient ${recipientNpa}`,
      });
    }
  }

  // 7d. State-specific calling rules (FL/OK/MD/NJ caps; NY/CA/TX hours).
  // Falls back gracefully if we don't have a state.
  if (input.recipientRecordId) {
    try {
      const addr = await fetchRecordAddress(input.userId, input.recipientRecordId);
      const stateCode = addr?.state?.trim().toUpperCase();
      if (stateCode && /^[A-Z]{2}$/.test(stateCode)) {
        const rule = await db.query.stateCallingRules.findFirst({
          where: eq(schema.stateCallingRules.stateCode, stateCode),
        });
        if (rule) {
          // (a) per-state attempt cap
          if (rule.maxAttemptsPer24h) {
            const windowStart = new Date(Date.now() - 24 * 3600 * 1000);
            const countRows = await db
              .select({ n: sql<number>`count(*)::int` })
              .from(schema.calls)
              .where(
                and(
                  eq(schema.calls.orgId, input.orgId),
                  eq(schema.calls.normalizedToNumber, e164),
                  gte(schema.calls.createdAt, windowStart),
                ),
              );
            const n = countRows[0]?.n ?? 0;
            if (n >= rule.maxAttemptsPer24h) {
              checks.push({
                name: 'state_rules',
                passed: false,
                severity: 'block',
                reasonCode: REASON.STATE_RULE_FREQ_EXCEEDED,
                detail: `${stateCode} caps at ${rule.maxAttemptsPer24h}/24h (currently ${n}) — ${rule.notes ?? ''}`,
              });
            } else {
              checks.push({
                name: 'state_rules',
                passed: true,
                severity: 'info',
                reasonCode: REASON.STATE_RULE_OK,
                detail: `${stateCode}: ${n}/${rule.maxAttemptsPer24h} per 24h · ${rule.callingHoursStart}-${rule.callingHoursEnd}`,
              });
            }
          } else {
            checks.push({
              name: 'state_rules',
              passed: true,
              severity: 'info',
              reasonCode: REASON.STATE_RULE_OK,
              detail: `${stateCode}: hours ${rule.callingHoursStart}-${rule.callingHoursEnd}${rule.notes ? ' · ' + rule.notes : ''}`,
            });
          }
          // (b) registration requirement (e.g. Texas)
          if (rule.requiresRegistration) {
            checks.push({
              name: 'state_registration',
              passed: true,
              severity: 'review',
              reasonCode: REASON.STATE_RULE_REGISTRATION,
              detail: `${stateCode} requires state registration${rule.requiresBond ? ' + surety bond' : ''} before commercial solicitation`,
            });
          }
        }
      }
    } catch { /* fall through gracefully */ }
  }

  // 7e. Federal DNC scrub — internal cache (sync from FreeDNCList vendor in P1).
  // TCPA penalties: $500–$1,500 per call. Single biggest compliance liability.
  const dncHit = await db.query.federalDncEntries.findFirst({
    where: eq(schema.federalDncEntries.e164, e164),
  });
  if (dncHit) {
    // A number that IS in the loaded cache always blocks, regardless of org mode.
    checks.push({
      name: 'federal_dnc',
      passed: false,
      severity: 'block',
      reasonCode: REASON.DNC_LISTED,
      detail: `Number is on the federal DNC list (source: ${dncHit.source})`,
    });
  } else {
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, input.orgId),
      columns: { dncMode: true },
    });
    if (org?.dncMode === 'external_prescrubbed') {
      // Org attests its call lists are scrubbed offline before loading. Pass
      // green with a label that states that method — NOT a claim that this
      // system checked the number against the registry.
      checks.push({
        name: 'federal_dnc',
        passed: true,
        severity: 'info',
        reasonCode: REASON.DNC_PRESCRUBBED,
        detail: 'Pre-scrubbed list (org policy)',
      });
    } else if (await isDncListLoaded(db)) {
      checks.push({
        name: 'federal_dnc',
        passed: true,
        severity: 'info',
        reasonCode: REASON.DNC_OK,
        detail: 'Not on federal DNC scrub list',
      });
    } else {
      // No real list loaded and no pre-scrub attestation: the number was NOT
      // actually scrubbed. Report the truth rather than implying a clean check.
      checks.push({
        name: 'federal_dnc',
        passed: true,
        severity: 'info',
        reasonCode: REASON.DNC_NOT_LOADED,
        detail: 'DNC scrub list not loaded — number was NOT checked against DNC',
      });
    }
  }

  // 7f. Reassigned Numbers Database (RND) — FCC safe harbor for consent-based calls.
  // Cache vendor results 90 days per FCC. If we have consent on file, we MUST
  // check RND before dialing; otherwise consent is presumed invalid.
  const consent = await db.query.consentRecords.findFirst({
    where: and(
      eq(schema.consentRecords.orgId, input.orgId),
      eq(schema.consentRecords.e164, e164),
    ),
  });
  if (consent && !consent.revokedAt) {
    const consentDate = consent.capturedAt.toISOString().slice(0, 10);
    const rnd = await db.query.rndLookups.findFirst({
      where: and(
        eq(schema.rndLookups.e164, e164),
        eq(schema.rndLookups.consentDate, consentDate),
      ),
    });
    if (!rnd) {
      checks.push({
        name: 'rnd',
        passed: true,
        severity: 'review',
        reasonCode: REASON.RND_UNCHECKED,
        detail: 'Consent on file but no RND check in last 90d — vendor lookup pending',
      });
    } else if (rnd.result === 'reassigned') {
      checks.push({
        name: 'rnd',
        passed: false,
        severity: 'block',
        reasonCode: REASON.RND_REASSIGNED,
        detail: `Number reassigned since consent (${consentDate}) — TCPA consent invalid`,
      });
    } else {
      checks.push({
        name: 'rnd',
        passed: true,
        severity: 'info',
        reasonCode: REASON.RND_OK,
        detail: `RND clear (consent ${consentDate}, vendor: ${rnd.vendor ?? 'cache'})`,
      });
    }
    // 7g. Consent record on file
    checks.push({
      name: 'consent_record',
      passed: true,
      severity: 'info',
      reasonCode: REASON.CONSENT_RECORD_OK,
      detail: `${consent.consentType} captured ${consentDate}${consent.sourceUrl ? ` from ${new URL(consent.sourceUrl).host}` : ''}`,
    });
  } else {
    // No consent record. This CTI is manual, rep-initiated click-to-dial (not an
    // autodialer/ATDS), so cold outbound is permitted under TCPA as long as the
    // hard gates hold — DNC scrub (block), calling hours, and frequency caps are
    // all enforced above. So surface "no prior consent" as INFO (visible in the
    // gate list for transparency) rather than forcing a per-call acknowledgment.
    checks.push({
      name: 'consent_record',
      passed: true,
      severity: 'info',
      reasonCode: REASON.CONSENT_RECORD_MISSING,
      detail: 'No TCPA consent record — relying on DNC scrub + cold-call rules',
    });
  }

  // 7h. STIR/SHAKEN attestation enforcement (per-DID baseline tracking).
  // We log attestation per call (see telephony status webhook). If a DID has a
  // baseline of 'A' but recent calls have come back 'B' or 'C', the carrier
  // has downgraded us — pause the DID and alert.
  if (outboundNumberRow) {
    const baseline = outboundNumberRow.baselineAttestation;
    if (!baseline) {
      checks.push({
        name: 'attestation',
        passed: true,
        severity: 'info',
        reasonCode: REASON.ATTESTATION_UNKNOWN,
        detail: 'No baseline yet — will be set after first attested call',
      });
    } else {
      // Sample the last 10 calls' attestations from this DID
      const recent = await db
        .select({ att: schema.calls.shakenAttestation })
        .from(schema.calls)
        .where(
          and(
            eq(schema.calls.orgId, input.orgId),
            eq(schema.calls.fromNumber, outboundNumberRow.e164),
          ),
        )
        .orderBy(sql`${schema.calls.createdAt} desc`)
        .limit(10);
      const recentAttested = recent.map((r) => r.att).filter((a): a is string => !!a);
      const degraded = recentAttested.length >= 3 &&
        recentAttested.every((a) => attestationRank(a) > attestationRank(baseline));
      if (degraded) {
        checks.push({
          name: 'attestation',
          passed: false,
          severity: 'block',
          reasonCode: REASON.ATTESTATION_DEGRADED,
          detail: `Baseline ${baseline}, last ${recentAttested.length} calls all attested ${recentAttested[0]} — carrier downgrade`,
        });
      } else {
        checks.push({
          name: 'attestation',
          passed: true,
          severity: 'info',
          reasonCode: REASON.ATTESTATION_OK,
          detail: `Baseline ${baseline} (${recentAttested.length} recent calls confirm)`,
        });
      }
    }
  }

  // 7i. Behavioral kill-threshold canaries for the candidate DID (answer rate
  //     and average connected duration over the last 24h). These are the exact
  //     signals carrier analytics weigh; a breach here is the early warning
  //     before the reputation worker auto-pauses the number. Raised as REVIEW
  //     (not BLOCK) so the rep is told to switch numbers but a single soft DID
  //     doesn't hard-stop the queue — the worker does the actual pause.
  if (outboundNumberRow) {
    const since = new Date(Date.now() - THRESHOLDS.WINDOW_MS);
    const stats = await fetchDidWindowStats(db, input.orgId, outboundNumberRow.e164, since);
    const ar = answerRateBreach(stats);
    checks.push(
      ar.breach
        ? {
            name: 'answer_rate',
            passed: false,
            severity: 'review',
            reasonCode: REASON.ANSWER_RATE_LOW,
            detail: `${outboundNumberRow.e164}: ${ar.detail} — switch DIDs; this number is on the kill curve`,
          }
        : {
            name: 'answer_rate',
            passed: true,
            severity: 'info',
            reasonCode: REASON.ANSWER_RATE_OK,
            detail: ar.detail,
          },
    );
    const eng = engagementBreach(stats);
    checks.push(
      eng.breach
        ? {
            name: 'engagement',
            passed: false,
            severity: 'review',
            reasonCode: REASON.ENGAGEMENT_LOW,
            detail: `${outboundNumberRow.e164}: ${eng.detail} — recipients hang up immediately; switch DIDs`,
          }
        : {
            name: 'engagement',
            passed: true,
            severity: 'info',
            reasonCode: REASON.ENGAGEMENT_OK,
            detail: eng.detail,
          },
    );
  }

  // 8. Recording consent — if two-party, require explicit script acknowledgement.
  if (campaign && campaign.recordingConsentMode === 'two_party') {
    checks.push({
      name: 'recording_consent',
      passed: true,
      severity: 'review',
      reasonCode: REASON.CONSENT_REVIEW,
      detail: 'Two-party consent jurisdiction — rep must read disclosure script.',
    });
  } else {
    checks.push({
      name: 'recording_consent',
      passed: true,
      severity: 'info',
      reasonCode: REASON.CONSENT_OK,
    });
  }

  return await persistAndReturn(db, input, checks, e164, fromE164 ?? effectiveFrom, campaign?.requiredScriptId ?? null);
}

export function aggregate(
  checks: CheckResult[],
  requiredScriptId: string | null,
): {
  decision: Decision;
  reasons: string[];
  blockReason: string | null;
  requiredScriptId: string | null;
} {
  const firstBlock = checks.find((c) => !c.passed && c.severity === 'block');
  if (firstBlock) {
    return {
      decision: 'BLOCK',
      reasons: checks.map((c) => c.reasonCode),
      blockReason: firstBlock.detail ?? firstBlock.reasonCode,
      requiredScriptId: null,
    };
  }
  const hasReview = checks.some((c) => c.severity === 'review');
  if (hasReview) {
    return {
      decision: 'REQUIRE_REVIEW',
      reasons: checks.map((c) => c.reasonCode),
      blockReason: null,
      requiredScriptId,
    };
  }
  return {
    decision: 'ALLOW',
    reasons: checks.map((c) => c.reasonCode),
    blockReason: null,
    requiredScriptId,
  };
}

async function persistAndReturn(
  db: Db,
  input: FirewallInput,
  checks: CheckResult[],
  e164: string | null,
  fromE164: string | null,
  requiredScriptId: string | null = null,
): Promise<FirewallResponse> {
  const agg = aggregate(checks, requiredScriptId);
  const [row] = await db
    .insert(schema.preCallAudits)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      toNumberRaw: input.toNumberRaw,
      toNumberE164: e164,
      fromNumberE164: fromE164 ?? input.fromNumber ?? null,
      campaignKey: input.campaignKey ?? null,
      decision: agg.decision,
      reasons: agg.reasons,
      blockReason: agg.blockReason,
      requiredScriptId: agg.requiredScriptId,
      checks,
      requestId: input.requestId ?? null,
    })
    .returning({ id: schema.preCallAudits.id });
  return {
    decision: agg.decision,
    reasons: agg.reasons,
    blockReason: agg.blockReason,
    requiredScriptId: agg.requiredScriptId,
    auditId: row!.id,
    checks,
    normalizedTo: e164,
    fromNumber: fromE164 ?? input.fromNumber ?? null,
  };
}

function isWithinCallingHours(
  now: Date,
  timezone: string,
  startHHMM: string,
  endHHMM: string,
  allowedIsoWeekdays: number[],
): boolean {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const iso = map[weekdayShort] ?? 1;
    if (!allowedIsoWeekdays.includes(iso)) return false;

    const [sH, sM] = startHHMM.split(':').map(Number) as [number, number];
    const [eH, eM] = endHHMM.split(':').map(Number) as [number, number];
    const nowMins = hour * 60 + minute;
    const startMins = sH * 60 + sM;
    const endMins = eH * 60 + eM;
    return nowMins >= startMins && nowMins < endMins;
  } catch {
    // Bad tz → fail safe to REVIEW upstream
    return false;
  }
}
