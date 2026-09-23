import { isFollowUpSubject } from './followup-subject.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD } from './cti-origin.js';

export interface FollowUpTask {
  Id: string;
  Subject: string | null;
  Type: string | null;
  Priority: string | null;
  /** Optional: older callers and fixtures may not select it. */
  Description?: string | null;
  OwnerId: string;
  WhoId: string | null;
  WhatId: string | null;
  ActivityDate: string | null;
}

export function pickFollowUpTask(tasks: FollowUpTask[]): FollowUpTask | null {
  const matches = tasks.filter((t) => isFollowUpSubject(t.Subject));
  if (matches.length === 0) return null;
  // Earliest ActivityDate first; null dates sort last.
  matches.sort((a, b) => (a.ActivityDate ?? '9999-99-99').localeCompare(b.ActivityDate ?? '9999-99-99'));
  return matches[0]!;
}

export function followUpCopyFields(task: FollowUpTask, dueDate: string): Record<string, string> {
  const fields: Record<string, string> = {
    Subject: task.Subject ?? 'Follow-up',
    // No Status on purpose: Salesforce applies the org's default open status
    // (Task.Status is defaultedOnCreate). A hard-coded 'Not Started' — not a
    // value in this org's Open/Completed picklist — hid every copy from the
    // reps' Status = 'Open' views and from the dialer's own Task-list runs.
    ActivityDate: dueDate,
    OwnerId: task.OwnerId,
    // Marks the copy as ours. The caller retries without this key if Salesforce
    // rejects it (field absent, or invisible to this rep) — see cti-origin.ts.
    [CTI_ORIGIN_FIELD]: CTI_ORIGIN.followUp,
  };
  // The body travels with the copy. For a follow-up this was a nicety; for a
  // 'set appt' or 'reschedule' the Description IS the work (the address, the
  // time, what was agreed), and dropping it hands the rep an empty task
  // tomorrow while completing the one that held the detail.
  if (task.Description) fields.Description = task.Description;
  if (task.Type) fields.Type = task.Type;
  if (task.Priority) fields.Priority = task.Priority;
  if (task.WhoId) fields.WhoId = task.WhoId;
  if (task.WhatId) fields.WhatId = task.WhatId;
  return fields;
}
