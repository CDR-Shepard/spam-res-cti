/**
 * Outbound DID selection for a power-dial run, by run kind.
 *
 * A Task-list run dials from the rep's OWN (`agent`-kind) numbers through the
 * same rotation the click-to-dial path uses — sticky-for-this-lead, then local
 * presence, then warmup room, then LRU — because a Task is the rep's own
 * follow-up: the lead should keep seeing the number that has been calling them.
 * A Lead/Opportunity list-view run keeps dialing the shared `dialer_pool`
 * (`pickPoolDid`), unchanged.
 *
 * What both kinds now share is the per-CUSTOMER attempt ceiling — the
 * anti-harassment backstop the firewall applies at click-to-dial time
 * (firewall/index.ts gate 5) — down to the same count and the same boundary
 * (`customerAttemptCounts` + `atCustomerCeiling`), so a recipient's contacts
 * add up across click-to-dial AND power dialing rather than each path keeping
 * its own private tally. Hitting the ceiling must NOT pause the run: it is a
 * property of one recipient, not of the rep's numbers, so the engine skips
 * that record and dials the next one. Only "no number is dialable at all"
 * (null) pauses, which stays fail-closed.
 */
import { and, eq } from 'drizzle-orm';
import { schema } from '@cti/db';
import { atCustomerCeiling, customerAttemptCounts } from '@cti/firewall';
import { pickRotationNumber, type AttemptCaps } from '@cti/firewall';
import { attemptIncrement, effectiveCapFor, pickPoolDid, type Db } from './pick-did.js';

export type PickDidArgs = { orgId: string; userId: string; toE164: string; runKind: 'pool' | 'agent' };
export type PickDidResult = { e164: string } | { skip: 'customer_ceiling' } | null;

export interface AttemptState {
  attemptsByNumber: Map<string, number>;
  customerAttemptsTotal: number;
  campaign: { maxAttempts: number; perCustomerMaxAttempts: number } | null;
}

/**
 * This run's view of the customer's recent contacts: the campaign's caps plus
 * the firewall's own attempt counts (`customerAttemptCounts` — click-to-dial
 * `calls` AND dialed `dialer_queue_items`, one shared definition so the ceiling
 * cannot mean two different things on the two dial paths).
 *
 * No campaign config = no attempt limits configured for this org: empty counts
 * and `campaign: null`, which `atCeiling` reads as "no ceiling" (the same way
 * the firewall pushes no attempt gates without a campaign).
 */
export async function customerAttemptState(db: Db, orgId: string, toE164: string): Promise<AttemptState> {
  const campaign = await db.query.campaignConfigs.findFirst({
    where: and(eq(schema.campaignConfigs.orgId, orgId), eq(schema.campaignConfigs.key, 'default')),
  });
  if (!campaign) return { attemptsByNumber: new Map(), customerAttemptsTotal: 0, campaign: null };
  const windowStart = new Date(Date.now() - campaign.attemptWindowDays * 24 * 3600 * 1000);
  return {
    ...(await customerAttemptCounts(db, orgId, toE164, windowStart)),
    campaign: { maxAttempts: campaign.maxAttempts, perCustomerMaxAttempts: campaign.perCustomerMaxAttempts },
  };
}

/**
 * Is this customer over the per-customer ceiling right now? One predicate for
 * both run kinds, delegating the comparison itself to the firewall's
 * `atCustomerCeiling` so click-to-dial and the dialer can never drift apart on
 * the boundary. No campaign = no ceiling.
 */
function atCeiling(state: AttemptState): boolean {
  return (
    state.campaign != null &&
    atCustomerCeiling({
      customerAttemptsTotal: state.customerAttemptsTotal,
      perCustomerMaxAttempts: state.campaign.perCustomerMaxAttempts,
    })
  );
}

export interface AgentPickDeps {
  attemptState: () => Promise<AttemptState>;
  rotate: (toE164: string, caps: AttemptCaps | undefined, exclude: ReadonlySet<string> | undefined) => Promise<string | null>;
  claim: (e164: string) => Promise<boolean>;
}

/** Agent-number pick for Task runs: ceiling → rotation → atomic claim (one retry excluding a lost race) → fail closed. */
export async function pickAgentDid(
  args: { orgId: string; userId: string; toE164: string },
  deps: AgentPickDeps,
): Promise<PickDidResult> {
  const state = await deps.attemptState();
  if (atCeiling(state)) return { skip: 'customer_ceiling' };
  // No campaign config = no attempt limits configured for this org, so rotation
  // ranks purely on warmup/presence (same as the firewall, which pushes no
  // attempt gates without a campaign).
  const caps = state.campaign
    ? { attemptsByNumber: state.attemptsByNumber, maxAttemptsPerNumber: state.campaign.maxAttempts }
    : undefined;
  // Rotation ranks; the atomic claim is the authority. A claim that returns
  // false lost a race (or the number just hit its cap), so retry ONCE with that
  // number excluded rather than being handed the same loser again.
  let exclude: Set<string> | undefined;
  for (let i = 0; i < 2; i++) {
    const e164 = await deps.rotate(args.toE164, caps, exclude);
    if (!e164) return null;
    if (await deps.claim(e164)) return { e164 };
    exclude = new Set([...(exclude ?? []), e164]);
  }
  return null;
}

/** Live router used by the engine: the per-customer ceiling applies to BOTH kinds; per-number rotation is agent-only. */
export async function pickDidForRun(db: Db, args: PickDidArgs): Promise<PickDidResult> {
  const attemptState = () => customerAttemptState(db, args.orgId, args.toE164);
  if (args.runKind === 'agent') {
    return pickAgentDid(args, {
      attemptState,
      rotate: (to, caps, exclude) => pickRotationNumber(db, args.orgId, args.userId, to, caps, exclude),
      // Re-read the rotation pick to confirm it is still one of THIS rep's own
      // numbers and to get its current cap, then claim a dial against that cap
      // in the same TOCTOU-safe conditional UPDATE the pool path uses.
      claim: async (e164) => {
        const row = await db.query.outboundNumbers.findFirst({
          where: and(
            eq(schema.outboundNumbers.orgId, args.orgId),
            eq(schema.outboundNumbers.e164, e164),
            eq(schema.outboundNumbers.assignedUserId, args.userId),
          ),
        });
        return !!row && attemptIncrement(db, args.orgId, e164, effectiveCapFor(row), 'agent');
      },
    });
  }
  if (atCeiling(await attemptState())) return { skip: 'customer_ceiling' };
  return pickPoolDid(db, { orgId: args.orgId, userId: args.userId, toE164: args.toE164 });
}
