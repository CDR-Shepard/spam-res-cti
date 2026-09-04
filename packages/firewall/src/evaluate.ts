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
import { schema, type Db } from '@cti/db';
import { normalize } from '@cti/phone';
import { aggregate } from './aggregate.js';
import { attemptGateChecks, customerAttemptCounts } from './attempts.js';
import { callingHoursGateCheck, callingWindowFor } from './calling-hours.js';
import { RecipientLookupUnauthorizedError } from './errors.js';
import { REASON } from './reasons.js';
import { enforcedStateHoursLabel, resolveRecipientState } from './recipient.js';
import { fetchDidWindowStats } from './reputation/query.js';
import { answerRateBreach, engagementBreach, THRESHOLDS } from './reputation/signals.js';
import { pickRotationNumber } from './rotation.js';
import { resolveTimezone, stateForAreaCode, timezoneForNumber } from './tz.js';
import type { CheckResult, FirewallDeps, FirewallInput, FirewallResponse } from './types.js';
import { velocityGateCheck } from './velocity.js';
import { warmupCapForAge } from './warmup.js';

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

export async function evaluate(db: Db, input: FirewallInput, deps: FirewallDeps = {}): Promise<FirewallResponse> {
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
  // The recipient STATE, resolved alongside the tz (same priority order, same
  // sources — see the weekend-calling brief, gate 6): the state overlay
  // (state-calling-rules.ts) needs a 2-letter code, not just a tz, to know
  // whether a state bans Sunday (or narrows the window) while weekend calling
  // is on globally elsewhere. null when it can't be resolved at all —
  // resolveStateRule(null) is the conservative unknown-state fallback.
  let resolvedTz = input.recipientTimezone;
  let resolvedState: string | null = null;
  let tzSource: string | undefined;
  if (!resolvedTz && input.recipientRecordId && deps.fetchRecipientAddress) {
    try {
      const addr = await deps.fetchRecipientAddress(input.userId, input.recipientRecordId);
      if (addr) {
        const resolved = resolveTimezone(addr);
        if (resolved) {
          resolvedTz = resolved.timezone;
          tzSource = `${addr.objectType} ${resolved.matched} via ${resolved.source}`;
          if (resolved.source === 'state') resolvedState = resolved.matched;
        }
      }
    } catch (err) {
      // Both branches fall through to the area-code/unknown-TZ path; the
      // difference is only diagnostic so we use stderr instead of threading a
      // Fastify logger into the evaluator. Auth errors merit a louder signal
      // because they typically mean the rep needs to re-connect Salesforce.
      if (err instanceof RecipientLookupUnauthorizedError) {
        // eslint-disable-next-line no-console
        console.warn('[firewall] recipient address lookup skipped: not authorized', { userId: input.userId });
      } else {
        // eslint-disable-next-line no-console
        console.warn('[firewall] recipient address lookup failed', { userId: input.userId, err: (err as Error).message });
      }
    }
  }
  if (!resolvedTz) {
    const npa = timezoneForNumber(e164);
    if (npa) {
      resolvedTz = npa.timezone;
      tzSource = `area code ${npa.matched}`;
      resolvedState = stateForAreaCode(npa.matched);
    }
  }
  // FIX-3: state may still be unresolved here even though tz IS resolved —
  // e.g. the SF address matched tz via COUNTRY, not state. Fall back to the
  // dialed number's area code regardless of how (or whether) tz resolved, so
  // a country-matched record doesn't fall to the unknown-state rule forever.
  resolvedState = resolveRecipientState(resolvedState, e164);
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

  // 5. Attempt limits. Contacts to this customer in the window, grouped by the
  //    number that placed them — click-to-dial AND power-dial contacts, via the
  //    shared customerAttemptCounts. The per-NUMBER budget is enforced after the
  //    DID is picked (gate 5b); the map here also drives the rotation swap below.
  //    The per-CUSTOMER ceiling (across all numbers) is the harassment backstop.
  let attemptsByNumber = new Map<string, number>();
  let customerAttemptsTotal = 0;
  if (campaign) {
    const windowStart = new Date(Date.now() - campaign.attemptWindowDays * 24 * 3600 * 1000);
    ({ attemptsByNumber, customerAttemptsTotal } = await customerAttemptCounts(
      db,
      input.orgId,
      e164,
      windowStart,
    ));
    // Gates are pushed at 5b (below), once the DID is chosen — the ceiling here
    // also feeds the rotation swap.
  }

  // 6. Calling hours (recipient-local) ∩ the per-state compliance overlay.
  //    If TZ unknown, fall back to REVIEW — unchanged from before the overlay.
  if (campaign) {
    const tz = inputForChecks.recipientTimezone;
    const allowedDays = (campaign.callingDays as number[]) ?? [1, 2, 3, 4, 5, 6, 7];
    if (!tz) {
      checks.push({
        name: 'calling_hours',
        passed: true,
        severity: 'review',
        reasonCode: REASON.CALLING_HOURS_UNKNOWN_TZ,
        detail: 'Recipient timezone unknown; rep must confirm appropriate hour.',
      });
    } else {
      checks.push(
        callingHoursGateCheck({
          now: new Date(),
          tz,
          state: resolvedState,
          window: callingWindowFor(campaign),
          allowedDays,
          tzSource,
        }),
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
    effectiveFrom = await pickRotationNumber(
      db,
      input.orgId,
      input.userId,
      e164,
      campaign ? { attemptsByNumber, maxAttemptsPerNumber: campaign.maxAttempts } : undefined,
    );
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

  // 5b. Attempt gates, now that the DID is chosen: the per-customer ceiling
  //     (all numbers — harassment backstop) and the per-number budget for the
  //     chosen DID. Rotation avoids exhausted numbers, so the per-number gate
  //     normally passes; it hard-stops when every number is exhausted (or a
  //     specific over-budget number was forced in). See attemptGateChecks.
  if (campaign) {
    for (const c of attemptGateChecks({
      windowDays: campaign.attemptWindowDays,
      maxAttempts: campaign.maxAttempts,
      perCustomerMaxAttempts: campaign.perCustomerMaxAttempts,
      attemptsByNumber,
      customerAttemptsTotal,
      effectiveFrom,
    })) {
      checks.push(c);
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
  if (outboundNumberRow) checks.push(velocityGateCheck(outboundNumberRow, new Date()));

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
  if (input.recipientRecordId && deps.fetchRecipientAddress) {
    try {
      const addr = await deps.fetchRecipientAddress(input.userId, input.recipientRecordId);
      const stateCode = addr?.state?.trim().toUpperCase();
      if (stateCode && /^[A-Z]{2}$/.test(stateCode)) {
        const rule = await db.query.stateCallingRules.findFirst({
          where: eq(schema.stateCallingRules.stateCode, stateCode),
        });
        if (rule) {
          // FIX-4: hours come from the ENFORCED STATE_CALLING_RULES table
          // (today's weekday window, recipient-local), not `rule`'s own
          // calling_hours_start/end columns — those have drifted from what
          // gate 6 actually enforces (e.g. OK: DB seed 08:00 vs enforced
          // 09:00). The frequency-cap portion below is unchanged — it still
          // reads `rule.maxAttemptsPer24h`/`rule.notes` from the DB table.
          const enforcedHours = enforcedStateHoursLabel(stateCode, new Date(), inputForChecks.recipientTimezone ?? 'America/Chicago');
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
                detail: `${stateCode}: ${n}/${rule.maxAttemptsPer24h} per 24h · ${enforcedHours}`,
              });
            }
          } else {
            checks.push({
              name: 'state_rules',
              passed: true,
              severity: 'info',
              reasonCode: REASON.STATE_RULE_OK,
              detail: `${stateCode}: hours ${enforcedHours}${rule.notes ? ' · ' + rule.notes : ''}`,
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
