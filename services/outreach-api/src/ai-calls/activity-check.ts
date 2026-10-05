/**
 * CF-1: right before an AI call, is there Salesforce activity the plan never saw? A Task or an
 * Event on the record (as Who or What) modified after the plan's research read Salesforce means
 * someone talked to or about the person since: the lead goes back to research and a new plan
 * needs a person's approval. The engine's own call Tasks (ai_calls.sf_task_id) are not news.
 *
 * Salesforce does not move a record's LastModifiedDate when a Task is logged against it
 * (campaigns/task-activity.ts), so the record read alone cannot tell.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { QueryTooLargeError, soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';

/** One query per object per tenant per tick covers at most PLACE_CANDIDATES_PER_ORG records; more rows than this is retried record by record (A1). */
export const ACTIVITY_MAX_ROWS = 2_000;
export const ACTIVITY_OBJECTS = ['Task', 'Event'] as const;

export interface ActivityProbe {
  sfRecordId: string;
  /** When the plan's research read Salesforce. */
  since: Date;
}

/** Salesforce compares Ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);

/** SOQL dateTime literal: UTC, whole seconds rounded down (the cutoff only widens; rows are compared exactly afterwards). */
function soqlDateTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Pure: Tasks or Events on any of `ids` (as Who or What) modified after `after`. Ids are shape-checked first. */
export function activitySoql(object: (typeof ACTIVITY_OBJECTS)[number], ids: readonly string[], after: Date): string {
  const list = ids
    .filter((id) => SF_ID.test(id))
    .map((id) => `'${soqlEscape(id)}'`)
    .join(',');
  if (!list) throw new Error('activitySoql needs at least one valid record id');
  return `SELECT Id, WhoId, WhatId, LastModifiedDate FROM ${object} WHERE (WhoId IN (${list}) OR WhatId IN (${list})) AND LastModifiedDate > ${soqlDateTime(after)}`;
}

/** The Salesforce Task ids the engine wrote for this tenant's AI calls on these records (its own call Tasks are not news). */
export async function engineTaskIds(db: Db, orgId: string, sfRecordIds: readonly string[]): Promise<Set<string>> {
  if (sfRecordIds.length === 0) return new Set();
  const result = await db.execute(sql`
    select sf_task_id from ai_calls
    where org_id = ${orgId}::uuid and sf_task_id is not null
      and sf_record_id in (${sql.join(sfRecordIds.map((id) => sql`${id}`), sql`, `)})`);
  return new Set((result as unknown as { rows: Array<{ sf_task_id: string }> }).rows.map((r) => core(r.sf_task_id)));
}

interface ActivityRow {
  Id?: unknown;
  WhoId?: unknown;
  WhatId?: unknown;
  LastModifiedDate?: unknown;
}

/** The probes (given) whose record has a Task or Event of `object` newer than its own `since`, in ONE query. */
async function newActivityIn(
  client: SalesforceClient,
  object: (typeof ACTIVITY_OBJECTS)[number],
  probes: readonly ActivityProbe[],
  ignoreIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const byCore = new Map(probes.map((p) => [core(p.sfRecordId), p]));
  const after = new Date(Math.min(...probes.map((p) => p.since.getTime())));
  const found = new Set<string>();
  const activity = await client.queryAll<ActivityRow>(activitySoql(object, probes.map((p) => p.sfRecordId), after), { maxRecords: ACTIVITY_MAX_ROWS });
  for (const row of activity) {
    if (typeof row.Id === 'string' && ignoreIds.has(core(row.Id))) continue;
    const modified = typeof row.LastModifiedDate === 'string' ? new Date(row.LastModifiedDate) : null;
    // An unreadable date is news: never assume old.
    for (const ref of [row.WhoId, row.WhatId]) {
      const probe = typeof ref === 'string' ? byCore.get(core(ref)) : undefined;
      if (!probe) continue;
      if (!modified || Number.isNaN(modified.getTime()) || modified.getTime() > probe.since.getTime()) found.add(probe.sfRecordId);
    }
  }
  return found;
}

/**
 * A1: the batch query overflowed ACTIVITY_MAX_ROWS. Ask record by record (each from its own research time), so one busy
 * record cannot hold the whole batch back. A record that overflows on its own has had more than ACTIVITY_MAX_ROWS Tasks
 * or Events since its research: that is certainly new activity, and it goes back to research like any other.
 */
async function newActivityPerRecord(
  client: SalesforceClient,
  object: (typeof ACTIVITY_OBJECTS)[number],
  probes: readonly ActivityProbe[],
  ignoreIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const probe of probes) {
    try {
      for (const id of await newActivityIn(client, object, [probe], ignoreIds)) found.add(id);
    } catch (err) {
      if (!(err instanceof QueryTooLargeError)) throw err;
      found.add(probe.sfRecordId);
    }
  }
  return found;
}

/**
 * The probed record ids (as given) that have a Task or Event newer than their own `since`. Throws what the client throws
 * (other than an overflow, which is retried record by record): the caller must not call anyone it could not check.
 */
export async function recordsWithNewActivity(client: SalesforceClient, probes: readonly ActivityProbe[], ignoreIds: ReadonlySet<string>): Promise<Set<string>> {
  const valid = probes.filter((p) => SF_ID.test(p.sfRecordId));
  if (valid.length === 0) return new Set();
  const found = new Set<string>();
  for (const object of ACTIVITY_OBJECTS) {
    // A record already known to have news needs no second look.
    const pending = valid.filter((p) => !found.has(p.sfRecordId));
    if (pending.length === 0) break;
    let hits: Set<string>;
    try {
      hits = await newActivityIn(client, object, pending, ignoreIds);
    } catch (err) {
      if (!(err instanceof QueryTooLargeError)) throw err;
      hits = pending.length === 1 ? new Set([pending[0]!.sfRecordId]) : await newActivityPerRecord(client, object, pending, ignoreIds);
    }
    for (const id of hits) found.add(id);
  }
  return found;
}
