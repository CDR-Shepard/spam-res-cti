/**
 * The triage eval set: anonymized cash-homebuyer notes with the acceptable first channel
 * and do-not-contact category. `scripts/triage-eval.ts` runs them against the live model
 * (`npm -w services/outreach-api run eval:triage`); this module holds the pure parts.
 */
import { z } from 'zod';
import { ContactChannel, DoNotContactCategory, type TriageResult } from '@cti/contracts';
import type { NotesBundle } from './notes.js';

/** Below this pass rate the eval fails (exit 1). */
export const EVAL_PASS_THRESHOLD = 0.8;

export const EvalCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  notes: z.array(z.object({ name: z.string().min(1), value: z.string() })),
  tasks: z.array(z.object({ subject: z.string().nullable(), description: z.string().nullable(), activityDate: z.string().nullable() })),
  /** Acceptable first channel (`null` = an empty channel list). Omitted = not scored. */
  acceptFirstChannel: z.array(ContactChannel.nullable()).min(1).optional(),
  /** Acceptable `doNotContact.category` (`null` = no flag). */
  acceptDoNotContact: z.array(DoNotContactCategory.nullable()).min(1),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalCases = z
  .array(EvalCase)
  .min(12)
  .refine((cases) => new Set(cases.map((c) => c.id)).size === cases.length, { message: 'case ids must be unique' });

/** Task Ids are synthetic: 18 characters, `00T` + the case-local index. */
export function caseToBundle(c: EvalCase): NotesBundle {
  return {
    fields: c.notes.filter((n) => n.value.trim().length > 0),
    tasks: c.tasks.map((t, i) => ({ id: `00T${String(i + 1).padStart(15, '0')}`, ...t })),
  };
}

export interface CaseScore {
  pass: boolean;
  firstChannel: string | null;
  doNotContact: string | null;
}

export function scoreCase(c: EvalCase, result: TriageResult): CaseScore {
  const firstChannel = result.channels[0]?.channel ?? null;
  const doNotContact = result.doNotContact?.category ?? null;
  const channelOk = c.acceptFirstChannel === undefined || c.acceptFirstChannel.includes(firstChannel);
  const flagOk = c.acceptDoNotContact.includes(doNotContact);
  return { pass: channelOk && flagOk, firstChannel, doNotContact };
}
