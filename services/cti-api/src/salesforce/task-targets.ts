import { soqlEscape, soqlQuery } from './client.js';

export type TargetObject = 'Lead' | 'Contact' | 'Opportunity';
export interface TaskRow {
  Id: string; Subject: string | null; OwnerId: string;
  WhoId: string | null; WhatId: string | null;
  Who?: { Type?: string } | null; What?: { Type?: string } | null;
}

/**
 * Pure — the person/record a Task dials, in the agreed precedence; null = unreachable.
 *
 * `followupEligible` gates whether the dialer may ROLL this task forward after
 * two no-connect attempts. It used to mean "the subject is a follow-up", which
 * left every other dialed task — 'set appt', 'reschedule' — open and going
 * overdue no matter how often the rep called it: a rep could dial all day and
 * watch their list not shrink. It now means "there is a subject to copy". A task
 * with no subject is the one thing we still refuse to roll, because
 * `followUpCopyFields` would invent the subject 'Follow-up' for it and quietly
 * manufacture a follow-up the rep never had.
 */
export function resolveTaskTarget(task: TaskRow): { recordId: string; objectType: TargetObject; followupEligible: boolean } | null {
  const eligible = !!task.Subject && task.Subject.trim() !== '';
  const whoType = task.Who?.Type;
  if (task.WhoId && (whoType === 'Lead' || whoType === 'Contact')) {
    return { recordId: task.WhoId, objectType: whoType, followupEligible: eligible };
  }
  if (task.WhatId && task.What?.Type === 'Opportunity') {
    return { recordId: task.WhatId, objectType: 'Opportunity', followupEligible: eligible };
  }
  return null;
}

const CHUNK = 200;
/** Batched fetch of the Tasks in a list view, with the polymorphic Who/What types. */
export async function fetchTasks(userId: string, taskIds: string[]): Promise<TaskRow[]> {
  const out: TaskRow[] = [];
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const ids = taskIds.slice(i, i + CHUNK).map((id) => `'${soqlEscape(id)}'`).join(',');
    out.push(...await soqlQuery<TaskRow>(
      userId,
      `SELECT Id, Subject, OwnerId, WhoId, WhatId, Who.Type, What.Type FROM Task WHERE Id IN (${ids})`,
    ));
  }
  return out;
}
