import { sfFetch, soqlEscape, soqlQuery } from './client.js';
import { nextBusinessDayFor } from './business-calendar.js';

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

const FOLLOW_UP_RE = /follow[ -]?up/i;

export function pickFollowUpTask(tasks: FollowUpTask[]): FollowUpTask | null {
  const matches = tasks.filter((t) => t.Subject != null && FOLLOW_UP_RE.test(t.Subject));
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

/**
 * Complete the rep's open follow-up task on `recordId` and create a copy due the
 * next business day. No-op returning nulls when no follow-up task matches.
 * `sfOwnerId` is the rep's Salesforce User Id.
 */
export async function rolloverFollowUp(
  userId: string,
  sfOwnerId: string,
  recordId: string,
  fromIsoDate: string,
): Promise<{ completed: string | null; created: string | null }> {
  const rid = soqlEscape(recordId);
  const owner = soqlEscape(sfOwnerId);
  const tasks = await soqlQuery<FollowUpTask>(
    userId,
    'SELECT Id, Subject, Type, Priority, OwnerId, WhoId, WhatId, ActivityDate FROM Task ' +
      `WHERE IsClosed = false AND OwnerId = '${owner}' ` +
      `AND (WhoId = '${rid}' OR WhatId = '${rid}') ` +
      "AND (Subject LIKE '%Follow-up%' OR Subject LIKE '%Followup%' OR Subject LIKE '%Follow up%') " +
      'ORDER BY ActivityDate ASC NULLS LAST LIMIT 50',
  );
  const task = pickFollowUpTask(tasks);
  if (!task) return { completed: null, created: null };

  const complete = await sfFetch(userId, `/sobjects/Task/${task.Id}`, {
    method: 'PATCH',
    body: { Status: 'Completed' },
  });
  if (complete.status >= 400) {
    throw new Error(`follow-up complete failed: ${JSON.stringify(complete.json)}`);
  }

  const due = await nextBusinessDayFor(userId, fromIsoDate);
  const created = await sfFetch(userId, '/sobjects/Task', {
    method: 'POST',
    body: followUpCopyFields(task, due),
  });
  if (created.status >= 400) {
    throw new Error(`follow-up copy create failed: ${JSON.stringify(created.json)}`);
  }
  return { completed: task.Id, created: (created.json as { id: string }).id };
}
