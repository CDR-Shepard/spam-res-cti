/**
 * Plan 1D write-back, Fix 1 (I-3): never overwrite a rep's newer value. The plan is frozen when it is built, so before every
 * PATCH (first attempt or any retry) the patched fields are read again. A field whose value is now neither the plan's
 * `before` nor already its `after` was edited since the plan: it is left alone and listed as "Not changed". The status
 * guard is re-checked against the same read: when a rep moved the Status or Stage, its companions (Rating, the reasons,
 * Next Follow-Up) stay too. Do-not-call flags always apply.
 */
import { soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { FIELD_API_NAME } from '../crm/field-map.js';
import type { Change } from './plan.js';
import { asText, currentOf } from './plan-values.js';
import { RecordGoneError } from './row-run.js';

/** A field the PATCH left alone because a rep changed it since the plan; `now` is its current value. */
export interface NotChanged {
  field: string;
  label: string;
  now: string | null;
}

/** The moves that go with the status: held when a rep moved the status. */
const STATUS_CLASS: ReadonlySet<Change['why']> = new Set(['status', 'follow_up']);

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const asInstant = (v: string): number => new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime();

/** Equal as Salesforce shows them: case-insensitive text, the same instant, or the same number. */
export function sameValue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  if (DATETIME.test(a) && DATETIME.test(b)) return asInstant(a) === asInstant(b);
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(Number(a)) && Number(a) === Number(b);
}

/** The record's current values of `names` (each a describe name); a record that is gone throws RecordGoneError. */
export async function readFresh(client: SalesforceClient, sobject: 'Lead' | 'Opportunity', id: string, names: readonly string[]): Promise<Record<string, unknown>> {
  const fields = [...new Set(names.filter((n) => FIELD_API_NAME.test(n) && n.toLowerCase() !== 'id'))];
  const rows = await client.query<Record<string, unknown>>(`SELECT ${['Id', ...fields].join(', ')} FROM ${sobject} WHERE Id = '${soqlEscape(id)}' LIMIT 1`);
  if (!rows[0]) throw new RecordGoneError('ENTITY_IS_DELETED');
  return rows[0];
}

/**
 * The patch less what a rep changed since the plan. `statusField` is the org's Status/StageName name (null when not
 * writable); `planStatus` is its value when the plan was built (undefined on rows planned before this was recorded).
 */
export function keepUnedited(i: {
  patch: Record<string, unknown>;
  changes: readonly Change[];
  fresh: Record<string, unknown>;
  statusField: string | null;
  planStatus: string | null | undefined;
}): { patch: Record<string, unknown>; notChanged: NotChanged[] } {
  const changeOf = (key: string): Change | undefined => i.changes.find((c) => c.field.toLowerCase() === key.toLowerCase());
  const now = (key: string): string | null => asText(currentOf(i.fresh, key));
  const edited = (key: string, c: Change): boolean => !sameValue(now(key), c.before) && !sameValue(now(key), c.after);
  const statusKey = i.statusField === null ? undefined : Object.keys(i.patch).find((k) => k.toLowerCase() === i.statusField!.toLowerCase());
  const statusChange = statusKey === undefined ? undefined : changeOf(statusKey);
  const statusMoved =
    statusKey !== undefined && statusChange !== undefined
      ? edited(statusKey, statusChange)
      : i.statusField !== null && i.planStatus !== undefined && !sameValue(now(i.statusField), i.planStatus);

  const patch: Record<string, unknown> = {};
  const notChanged: NotChanged[] = [];
  for (const [key, value] of Object.entries(i.patch)) {
    const c = changeOf(key);
    const flag = c?.why === 'dnc' && typeof value === 'boolean';
    if (c === undefined || flag || !(edited(key, c) || (statusMoved && STATUS_CLASS.has(c.why)))) {
      patch[key] = value;
      continue;
    }
    notChanged.push({ field: c.field, label: c.label, now: now(key) });
  }
  const order = (n: NotChanged): number => i.changes.findIndex((c) => c.field === n.field);
  return { patch, notChanged: [...notChanged].sort((x, y) => order(x) - order(y)) };
}
