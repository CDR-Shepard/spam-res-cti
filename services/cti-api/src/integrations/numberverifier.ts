/**
 * NumberVerifier (app.numberverifier.com) webhook payload → DID health.
 *
 * NumberVerifier monitors each DID's caller-ID label across AT&T / Verizon /
 * T-Mobile and POSTs (v2 schema) whenever a number is checked. We translate
 * that real carrier ground truth into our `number_health` so a flagged DID is
 * pulled from rotation and blocked by the firewall immediately.
 *
 * v2 fields we use (others ignored):
 *   phone        — the checked number
 *   flag_status  — overall: is the number flagged on ANY carrier
 *   errors       — DNO (do not originate), 606 (carrier blocked),
 *                  607 (provider blocked), 608 (handset blocked)
 *   checks[]     — per-carrier: { carrier, flag_status, words, device_type }
 *
 * Pure + side-effect-free so it is unit-testable without a DB or HTTP.
 */

export interface NumberVerifierCheck {
  carrier?: string;
  flag_status?: boolean | string | null;
  words?: string | null;
  device_type?: string | null;
  is_api?: boolean;
}

export interface NumberVerifierPayload {
  phone?: string;
  flag_status?: boolean | string | null;
  errors?: string | string[] | null;
  checks?: NumberVerifierCheck[] | null;
  account_id?: string;
  campaign_id?: string;
  phone_id?: string;
  job_id?: string;
  check_time?: string;
  meta_data?: unknown;
}

export type NvHealth = 'spam_likely' | 'degraded' | 'healthy';

export interface NvClassification {
  /** True when any carrier/provider/handset signal is adverse. */
  flagged: boolean;
  /** Health to apply: spam_likely (hard block), degraded (softer), healthy (clean). */
  health: NvHealth;
  /** Human-readable reasons (carrier + label + error codes). */
  reasons: string[];
  /** Carriers that flagged the number. */
  flaggedCarriers: string[];
}

/** A "do not originate" / hard-block error code set — pull the number entirely. */
const HARD_BLOCK_ERRORS = new Set(['DNO', '606', '608']);
/** Provider-side soft block. */
const SOFT_BLOCK_ERRORS = new Set(['607']);

function isTruthyFlag(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') return /^(true|t|1|yes|y|flagged|flag|blocked)$/i.test(v.trim());
  return false;
}

function toErrorList(errors: string | string[] | null | undefined): string[] {
  if (!errors) return [];
  const raw = Array.isArray(errors) ? errors : String(errors).split(/[,\s;]+/);
  return raw.map((e) => e.trim().toUpperCase()).filter(Boolean);
}

export function classifyNumberVerifier(payload: NumberVerifierPayload): NvClassification {
  const reasons: string[] = [];

  const errors = toErrorList(payload.errors);
  const hardBlock = errors.some((e) => HARD_BLOCK_ERRORS.has(e));
  const softBlock = errors.some((e) => SOFT_BLOCK_ERRORS.has(e));
  if (errors.length) reasons.push(`errors: ${errors.join(', ')}`);

  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const flaggedChecks = checks.filter((c) => isTruthyFlag(c.flag_status));
  const flaggedCarriers = flaggedChecks
    .map((c) => (c.carrier ?? '').toString().trim())
    .filter(Boolean);
  for (const c of flaggedChecks) {
    const carrier = c.carrier ?? 'carrier';
    const words = c.words ? `"${c.words}"` : 'flagged';
    reasons.push(`${carrier}: ${words}`);
  }

  const topFlag = isTruthyFlag(payload.flag_status);
  if (topFlag && flaggedChecks.length === 0 && !errors.length) reasons.push('flagged on a carrier');

  const carrierFlagged = topFlag || flaggedChecks.length > 0;
  const flagged = carrierFlagged || hardBlock || softBlock;

  let health: NvHealth;
  if (carrierFlagged || hardBlock) health = 'spam_likely';
  else if (softBlock) health = 'degraded';
  else health = 'healthy';

  return { flagged, health, reasons, flaggedCarriers };
}
