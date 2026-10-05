/**
 * Number-kind rules for the admin number routes (routes/admin.ts).
 *
 * `ai_pool` numbers are the AI voice agent's OWN caller IDs: never a rep's, so
 * never assigned to one (rep paths filter them out anyway; this keeps the
 * admin screen from suggesting otherwise).
 */
import type { NumberKind } from '@cti/db';

/** Marks a Twilio number as an AI number when it appears in its FriendlyName. */
const AI_POOL_MARKER = '(ai_pool)';

/**
 * The kind a number imported from Twilio gets on FIRST import: `ai_pool` when
 * its Twilio FriendlyName contains "(ai_pool)" (any case), else the column's
 * default `agent`. Only ever used for a NEW row — the import never re-kinds a
 * row that already exists.
 */
export function kindForImportedNumber(friendlyName: string | null | undefined): 'ai_pool' | 'agent' {
  return friendlyName?.toLowerCase().includes(AI_POOL_MARKER) ? 'ai_pool' : 'agent';
}

export interface KindFields {
  kind: NumberKind;
  assignedUserId: string | null;
}

export type KindChange =
  | { ok: true; set: Partial<KindFields> }
  | { ok: false; error: string };

/**
 * The kind / assignee part of an admin edit. Moving a number INTO AI calls
 * un-assigns it; an AI number cannot carry a rep (assigning one requires
 * moving it out of AI calls in the same edit).
 */
export function numberKindChange(current: KindFields, patch: Partial<KindFields>): KindChange {
  const kind = patch.kind ?? current.kind;
  const assignee = patch.assignedUserId !== undefined ? patch.assignedUserId : current.assignedUserId;
  if (kind === 'ai_pool') {
    if (patch.assignedUserId) return { ok: false, error: 'An AI calls number cannot be assigned to a rep' };
    const set: Partial<KindFields> = {};
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (assignee !== null || patch.assignedUserId !== undefined) set.assignedUserId = null;
    return { ok: true, set };
  }
  const set: Partial<KindFields> = {};
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.assignedUserId !== undefined) set.assignedUserId = patch.assignedUserId;
  return { ok: true, set };
}
