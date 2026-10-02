/**
 * The "Power Dialer Time" Task — one per rep per Pacific day, holding the rep's
 * time on the power dialer (line open) as Call Duration so Salesforce reports
 * can sum it. Written as the rep (the CTI user id → their own Salesforce
 * connection), so the rep owns it. A plain Task, never a Call: call counts and
 * call metrics must not include it. Belongs to no record (no WhoId/WhatId).
 *
 * Design: docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md.
 */
import { sfFetch, soqlQuery } from './client.js';
import { soqlEscape } from './soql.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD, isInvalidFieldError, withoutCtiOrigin } from './cti-origin.js';

/** Exact: both Salesforce reports filter on this literal. */
export const DIALER_TIME_SUBJECT = 'Power Dialer Time';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DELETED_CODES = new Set(['NOT_FOUND', 'ENTITY_IS_DELETED']);

export function buildDialerTimeTaskFields(day: string, seconds: number): Record<string, unknown> {
  return {
    Subject: DIALER_TIME_SUBJECT,
    Status: 'Completed',
    Priority: 'Normal',
    TaskSubtype: 'Task',
    ActivityDate: day,
    CallDurationInSeconds: seconds,
    Description: `Time on the power dialer (line open) on ${day}, Pacific. Kept up to date by the CTI.`,
    [CTI_ORIGIN_FIELD]: CTI_ORIGIN.dialerTime,
  };
}

function errorCodes(json: unknown): string[] {
  const entries = Array.isArray(json) ? json : [json];
  return entries
    .map((e) => (e as { errorCode?: unknown } | null)?.errorCode)
    .filter((c): c is string => typeof c === 'string');
}

export async function createDialerTimeTask(userId: string, day: string, seconds: number): Promise<{ taskId: string }> {
  const fields = buildDialerTimeTaskFields(day, seconds);
  let res = await sfFetch(userId, '/sobjects/Task', { method: 'POST', body: fields });
  // The marker is gated by per-rep field-level security: drop only it, once.
  if (res.status >= 400 && isInvalidFieldError(res.json)) {
    res = await sfFetch(userId, '/sobjects/Task', { method: 'POST', body: withoutCtiOrigin(fields) });
  }
  if (res.status >= 400) {
    throw new Error(`Salesforce Power Dialer Time create failed (${res.status}): ${JSON.stringify(res.json)}`);
  }
  return { taskId: (res.json as { id: string }).id };
}

/** 'missing' = Salesforce says the Task is gone (deleted): the caller recreates it. */
export async function updateDialerTimeTask(userId: string, taskId: string, seconds: number): Promise<'updated' | 'missing'> {
  const res = await sfFetch(userId, `/sobjects/Task/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: { CallDurationInSeconds: seconds },
  });
  if (res.status < 400) return 'updated';
  if (res.status === 404 || errorCodes(res.json).some((c) => DELETED_CODES.has(c))) return 'missing';
  throw new Error(`Salesforce Power Dialer Time update failed (${res.status}): ${JSON.stringify(res.json)}`);
}

/** The rep's existing Task for `day`, oldest first — so a crash between a
 *  create and its DB stamp is adopted on the next tick, never duplicated. */
export async function findDialerTimeTask(userId: string, sfUserId: string, day: string): Promise<string | null> {
  if (!DAY_RE.test(day)) throw new Error(`findDialerTimeTask: invalid day ${JSON.stringify(day)}`);
  const rows = await soqlQuery<{ Id: string }>(
    userId,
    `SELECT Id FROM Task WHERE Subject = '${soqlEscape(DIALER_TIME_SUBJECT)}' AND ActivityDate = ${day} AND OwnerId = '${soqlEscape(sfUserId)}' ORDER BY CreatedDate ASC LIMIT 1`,
  );
  return rows[0]?.Id ?? null;
}
