/**
 * Plan 1D: the facts our system computes for a plan (the last real contact in words, the qualification topics
 * Salesforce is missing) and how they override the model after parsing. The model only writes what the last contact
 * was about and picks among the missing topics; the words and the missing list are ours.
 */
import { z } from 'zod';
import { QualificationTopic, Reengagement, type CallPlan, type EditableCallPlan } from '@cti/contracts';
import { contactWords, lastRealContact } from '../research/last-contact.js';
import { missingTopics } from '../research/qualification.js';
import type { ResearchSnapshot } from '../research/snapshot.js';

export interface PlanFacts {
  lastContactWords: string | null;
  lastContactKind: 'call' | 'meeting' | 'email' | null;
  missing: QualificationTopic[];
}

/** `missing` reads the record itself (the self block) only, never a related record. */
export function planFacts(s: ResearchSnapshot, now: Date): PlanFacts {
  const contact = lastRealContact(s, now);
  const self = s.records.find((b) => b.relation === 'self');
  return {
    lastContactWords: contact ? contactWords(contact.at, now) : null,
    lastContactKind: contact?.kind ?? null,
    missing: missingTopics(s.sfObject, self?.fields ?? []),
  };
}

/** The model never decides the computed parts: lastContact is the computed words; stillToLearn ⊆ missing (empty → all missing). */
export function withPlanFacts(plan: CallPlan, facts: PlanFacts): CallPlan {
  const reengagement = facts.lastContactWords === null ? null : { lastContact: facts.lastContactWords, lastTopic: plan.reengagement?.lastTopic ?? null };
  const kept = [...new Set(plan.stillToLearn)].filter((t) => facts.missing.includes(t));
  return { ...plan, reengagement, stillToLearn: kept.length > 0 ? kept : [...facts.missing] };
}

const StoredFacts = z.object({
  reengagement: Reengagement.nullable().catch(null),
  stillToLearn: z.array(QualificationTopic).catch([]),
}).catch({ reengagement: null, stillToLearn: [] });

/**
 * A person's edit (call-plans/decisions.ts) never sets the computed facts: the last contact's words (digit-free, CF-14)
 * and whether there was one at all come from the plan it replaces. The person may change what the contact was about
 * and which topics to learn; a body without them (an old page sends null and []) keeps the stored ones.
 */
export function withStoredFacts<P extends EditableCallPlan>(edited: P, storedPlan: unknown): P {
  const stored = StoredFacts.parse(storedPlan ?? {});
  const reengagement = stored.reengagement === null
    ? null
    : { lastContact: stored.reengagement.lastContact, lastTopic: edited.reengagement ? edited.reengagement.lastTopic : stored.reengagement.lastTopic };
  const picked = [...new Set(edited.stillToLearn)];
  return { ...edited, reengagement, stillToLearn: picked.length > 0 ? picked : stored.stillToLearn };
}
