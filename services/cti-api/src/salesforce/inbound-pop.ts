/**
 * Inbound pop precedence (Task 14): the record the softphone pops when a call
 * rings, and the timeout budget for the extra lookup that can promote a
 * Contact match to its open Opportunity.
 *
 * Split out of routes/inbound.ts (same pattern as inbound-caller-params.ts /
 * inbound-forward.ts) so the precedence rule is a pure, independently
 * testable unit — see docs/superpowers/specs/2026-09-23-dialer-cadence-and-controls-design.md §6.
 */

/** The record the softphone pops for an inbound match. The person's live deal
 *  first (Opportunity, then Deal), then the Lead, then the Contact itself —
 *  never an Account: a Contact page is the Account's page in practice. */
export function popRecordFor(m: { whoId?: string; whatId?: string; openOpportunityId?: string | null }): string | null {
  const what = m.whatId && !m.whatId.startsWith('001') ? m.whatId : undefined;
  if (what?.startsWith('006')) return what;
  if (m.openOpportunityId) return m.openOpportunityId;
  if (what) return what; // Deal__c (custom prefix)
  if (m.whoId?.startsWith('00Q')) return m.whoId;
  if (m.whoId?.startsWith('003')) return m.whoId;
  return null;
}

/**
 * The inbound ring path's open-Opportunity lookup (routes/inbound.ts) runs on
 * the live webhook, BEFORE the rep's phone starts ringing — it must be
 * bounded tighter than `findPrimaryOpenOpportunityId`'s 3s default so a
 * degraded Salesforce never delays the ring itself. Passed as
 * `{ timeoutMs: INBOUND_POP_LOOKUP_MS }`; on timeout or any other failure the
 * pop falls back to the Contact per `popRecordFor`'s order.
 */
export const INBOUND_POP_LOOKUP_MS = 1500;
