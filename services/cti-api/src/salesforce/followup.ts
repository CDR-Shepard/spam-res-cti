import { isFollowUpSubject } from './followup-subject.js';

export interface FollowUpTask {
  Id: string;
  Subject: string | null;
  Type: string | null;
  Priority: string | null;
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
    Status: 'Not Started',
    ActivityDate: dueDate,
    OwnerId: task.OwnerId,
  };
  if (task.Type) fields.Type = task.Type;
  if (task.Priority) fields.Priority = task.Priority;
  if (task.WhoId) fields.WhoId = task.WhoId;
  if (task.WhatId) fields.WhatId = task.WhatId;
  return fields;
}
