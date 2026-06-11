/**
 * Per-DID behavioral signals + kill-threshold checks.
 *
 * These are the carrier-analytics "danger zone" thresholds from
 * SPAM_RESISTANCE_2026.md, expressed as pure functions so the firewall gate
 * (real-time, per call) and the reputation worker (periodic, auto-pause) make
 * the SAME decision and can both be unit-tested without a database.
 *
 * Quantified thresholds (US, 2026):
 *   - answer rate < 5%  → fresh-DID kill curve
 *   - avg connected duration < 6s → robocall fingerprint
 * Minimum samples avoid punishing a brand-new DID with a handful of dials.
 */

export const THRESHOLDS = {
  /** Min dials before the answer-rate floor is trusted. */
  ANSWER_RATE_MIN_SAMPLE: 20,
  /** Below this answer rate (over the min sample) the DID is on the kill curve. */
  ANSWER_RATE_FLOOR: 0.05,
  /** Min connected calls before the avg-duration floor is trusted. */
  ENGAGEMENT_MIN_SAMPLE: 10,
  /** Below this average connected duration (seconds) the DID looks like a robocall. */
  ENGAGEMENT_AVG_SECONDS: 6,
  /** Lookback window for both signals. */
  WINDOW_MS: 24 * 60 * 60 * 1000,
} as const;

export interface DidWindowStats {
  /** Total dials placed from the DID in the window. */
  dials: number;
  /** Calls that connected (answered / had talk time) in the window. */
  connected: number;
  /** Average duration (seconds) over connected calls, or null if none. */
  avgConnectedDuration: number | null;
}

export interface SignalBreach {
  breach: boolean;
  /** True when the sample is too small to judge yet (never a breach). */
  insufficientSample: boolean;
  detail: string;
}

/** Answer rate = connected / dials. Breach when < floor over the min sample. */
export function answerRateBreach(stats: DidWindowStats): SignalBreach {
  if (stats.dials < THRESHOLDS.ANSWER_RATE_MIN_SAMPLE) {
    return {
      breach: false,
      insufficientSample: true,
      detail: `${stats.connected}/${stats.dials} answered — sample below ${THRESHOLDS.ANSWER_RATE_MIN_SAMPLE} dials`,
    };
  }
  const rate = stats.dials > 0 ? stats.connected / stats.dials : 0;
  const pct = Math.round(rate * 1000) / 10;
  if (rate < THRESHOLDS.ANSWER_RATE_FLOOR) {
    return {
      breach: true,
      insufficientSample: false,
      detail: `${pct}% answer rate over ${stats.dials} dials — below the ${THRESHOLDS.ANSWER_RATE_FLOOR * 100}% kill threshold`,
    };
  }
  return {
    breach: false,
    insufficientSample: false,
    detail: `${pct}% answer rate over ${stats.dials} dials`,
  };
}

/** Engagement = avg connected duration. Breach when < floor over the min sample. */
export function engagementBreach(stats: DidWindowStats): SignalBreach {
  if (stats.connected < THRESHOLDS.ENGAGEMENT_MIN_SAMPLE || stats.avgConnectedDuration == null) {
    return {
      breach: false,
      insufficientSample: true,
      detail: `${stats.connected} connected calls — sample below ${THRESHOLDS.ENGAGEMENT_MIN_SAMPLE}`,
    };
  }
  const avg = Math.round(stats.avgConnectedDuration * 10) / 10;
  if (stats.avgConnectedDuration < THRESHOLDS.ENGAGEMENT_AVG_SECONDS) {
    return {
      breach: true,
      insufficientSample: false,
      detail: `${avg}s avg over ${stats.connected} connected calls — below the ${THRESHOLDS.ENGAGEMENT_AVG_SECONDS}s robocall-fingerprint floor`,
    };
  }
  return {
    breach: false,
    insufficientSample: false,
    detail: `${avg}s avg over ${stats.connected} connected calls`,
  };
}

/** True when either kill-threshold signal is breached — used by the auto-pause worker. */
export function shouldAutoPause(stats: DidWindowStats): { pause: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ar = answerRateBreach(stats);
  if (ar.breach) reasons.push(`answer rate: ${ar.detail}`);
  const eng = engagementBreach(stats);
  if (eng.breach) reasons.push(`engagement: ${eng.detail}`);
  return { pause: reasons.length > 0, reasons };
}
