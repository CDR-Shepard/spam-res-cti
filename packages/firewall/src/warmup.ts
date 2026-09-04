/**
 * Warmup curve — caps daily dials per DID based on days since first use.
 * Source: industry-aggregated 2026 thresholds (BatchDialer, SalesHive, Kixie).
 * Brand-new DIDs dialing >100/day on day 1 get tagged "Spam Likely" by
 * Hiya/First Orion/TNS within 24-72h.
 */
export function warmupCapForAge(daysSinceFirstUse: number | null): { cap: number; tier: number; label: string } {
  if (daysSinceFirstUse === null) return { cap: 20, tier: 1, label: 'Day 1 — initial warmup' };
  if (daysSinceFirstUse < 7) return { cap: 20, tier: 1, label: `Week 1 (day ${daysSinceFirstUse + 1}) — fresh DID` };
  if (daysSinceFirstUse < 14) return { cap: 40, tier: 2, label: `Week 2 (day ${daysSinceFirstUse + 1}) — building maturity` };
  if (daysSinceFirstUse < 21) return { cap: 70, tier: 3, label: `Week 3 (day ${daysSinceFirstUse + 1}) — ramping` };
  return { cap: 80, tier: 4, label: 'Steady state (week 4+)' };
}
