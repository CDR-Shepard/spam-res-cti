/**
 * Plan 1D write-back: one record's PATCH that survives field refusals. When Salesforce refuses particular fields (a
 * validation rule, a restricted value, a queue-owned Lead's Status), those fields are dropped and the rest is sent again, at
 * most `maxRetries` times. Refused field names are matched case-insensitively (D-22: the refusal uses the org's spelling).
 */
import type { SalesforceClient } from '@cti/salesforce';
import { throwIfNotARefusal } from './row-run.js';

export const FIELD_REFUSAL_RETRIES = 3;

export interface FieldRefusal {
  /** The patch key Salesforce refused (the org's spelling, as sent). */
  field: string;
  code: string;
}
export interface PatchResult {
  /** What was finally written, or null when nothing was. */
  sent: Record<string, unknown> | null;
  refusals: FieldRefusal[];
  /** A refusal that names no field we sent (a whole-record validation), or one more after the retries ran out. */
  recordError: { code: string; message: string } | null;
}

/** The fields to send, given the (lower-cased) names dropped so far and the refusals behind them. */
export type PatchBuilder = (dropped: ReadonlySet<string>, refusals: readonly FieldRefusal[]) => Record<string, unknown>;

export async function patchDroppingRefused(client: SalesforceClient, sobject: string, id: string, build: PatchBuilder, maxRetries = FIELD_REFUSAL_RETRIES): Promise<PatchResult> {
  const dropped = new Set<string>();
  const refusals: FieldRefusal[] = [];
  for (let attempt = 0; ; attempt += 1) {
    const fields = build(dropped, refusals);
    if (Object.keys(fields).length === 0) return { sent: null, refusals, recordError: null };
    const [result] = await client.updateRecords([{ sobject, id, fields }]);
    if (!result || result.success) return { sent: fields, refusals, recordError: null };
    for (const e of result.errors) throwIfNotARefusal(e.statusCode);
    const byLower = new Map(Object.keys(fields).map((k) => [k.toLowerCase(), k]));
    const named = result.errors.flatMap((e) => (e.fields ?? []).flatMap((f) => {
      const key = byLower.get(f.toLowerCase());
      return key !== undefined && !dropped.has(key.toLowerCase()) ? [{ field: key, code: e.statusCode }] : [];
    }));
    const first = result.errors[0] ?? { statusCode: 'UNKNOWN_ERROR', message: '' };
    if (named.length === 0 || attempt >= maxRetries) return { sent: null, refusals, recordError: { code: first.statusCode, message: first.message } };
    for (const n of named) {
      if (dropped.has(n.field.toLowerCase())) continue;
      dropped.add(n.field.toLowerCase());
      refusals.push(n);
    }
  }
}

/** A patch without the dropped (lower-cased) keys. */
export const without = (patch: Record<string, unknown>, dropped: ReadonlySet<string>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(patch).filter(([k]) => !dropped.has(k.toLowerCase())));
