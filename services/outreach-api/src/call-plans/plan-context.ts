/**
 * Plan 1D: the facts our system computes for a plan (the last real contact in words, the qualification topics
 * Salesforce is missing) and how they override the model after parsing. The model only writes what the last contact
 * was about and picks among the missing topics; the words and the missing list are ours.
 */
import { z } from 'zod';
import { contactSearchLimited, QualificationTopic, Reengagement, type CallPlan, type ContactKind, type EditableCallPlan } from '@cti/contracts';
import { contactWords, lastRealContact } from '../research/last-contact.js';
import { missingTopics, unreadableTopics } from '../research/qualification.js';
import type { ResearchSnapshot } from '../research/snapshot.js';

export interface PlanFacts {
  lastContactWords: string | null;
  /** Fix 1 (M-4): stored with the plan, so the words can be worked out again when the plan is read. */
  lastContactAt: Date | null;
  lastContactKind: ContactKind | null;
  /** Fix 1 (M-8): research kept only the most recent activity, so "no contact" means none in what was read. */
  contactSearchLimited: boolean;
  missing: QualificationTopic[];
  /** Topics none of whose fields research could read (sweep D-13): unknown, never missing; the model is told. */
  unreadable: QualificationTopic[];
}

/** `missing` reads the record itself (the self block) only, never a related record. */
export function planFacts(s: ResearchSnapshot, now: Date): PlanFacts {
  const contact = lastRealContact(s, now);
  const self = s.records.find((b) => b.relation === 'self');
  return {
    lastContactWords: contact ? contactWords(contact.at, now) : null,
    lastContactAt: contact?.at ?? null,
    lastContactKind: contact?.kind ?? null,
    // The card's rule (sweep D-13): only the Tasks, Events and emails read; the snapshot's own cut is not about contact.
    contactSearchLimited: contactSearchLimited(s.sources),
    missing: missingTopics(s.sfObject, self?.fields ?? [], self?.qualificationFieldsRead),
    unreadable: unreadableTopics(s.sfObject, self?.qualificationFieldsRead),
  };
}

/**
 * The model never decides the computed parts: lastContact is the computed words (with, Fix 1, the contact's date and
 * kind); stillToLearn ⊆ missing (empty → all missing).
 */
export function withPlanFacts(plan: CallPlan, facts: PlanFacts): CallPlan {
  const reengagement = facts.lastContactWords === null
    ? null
    : {
        lastContact: facts.lastContactWords,
        lastContactAt: facts.lastContactAt?.toISOString() ?? null,
        lastContactKind: facts.lastContactKind,
        lastTopic: plan.reengagement?.lastTopic ?? null,
      };
  const kept = [...new Set(plan.stillToLearn)].filter((t) => facts.missing.includes(t));
  return { ...plan, reengagement, stillToLearn: kept.length > 0 ? kept : [...facts.missing] };
}

const StoredFacts = z.object({
  reengagement: Reengagement.nullable().catch(null),
  stillToLearn: z.array(QualificationTopic).catch([]),
}).catch({ reengagement: null, stillToLearn: [] });

/**
 * A person's edit (call-plans/decisions.ts) never sets the computed facts: the last contact's words (digit-free, CF-14),
 * its date and kind, and whether there was one at all come from the plan it replaces. The person may change what the contact was about
 * and which topics to learn; a body without them (an old page sends null and []) keeps the stored ones.
 */
export function withStoredFacts<P extends EditableCallPlan>(edited: P, storedPlan: unknown): P {
  const stored = StoredFacts.parse(storedPlan ?? {});
  const reengagement = stored.reengagement === null
    ? null
    : {
        lastContact: stored.reengagement.lastContact,
        lastContactAt: stored.reengagement.lastContactAt ?? null,
        lastContactKind: stored.reengagement.lastContactKind ?? null,
        lastTopic: edited.reengagement ? edited.reengagement.lastTopic : stored.reengagement.lastTopic,
      };
  const picked = [...new Set(edited.stillToLearn)];
  return { ...edited, reengagement, stillToLearn: picked.length > 0 ? picked : stored.stillToLearn };
}
