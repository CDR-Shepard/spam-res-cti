/**
 * Every Task the CTI creates in Salesforce carries a marker naming what created
 * it, so reports can tell CTI-written activity from anything a person typed.
 *
 * The field is `CTI_Origin__c` on Activity (migration: Salesforce metadata, not
 * a DB migration). A blank value means "a person, or another system, made this".
 *
 * Field-level security is the catch. The CTI writes Tasks through each rep's own
 * OAuth session, so a rep whose profile/permission set cannot see
 * `CTI_Origin__c` gets `INVALID_FIELD: No such column` — the SAME error shape as
 * an org where the field was never deployed. Neither case may cost the rep their
 * task, so both creation paths retry without the marker. See
 * `isInvalidFieldError` / `withoutCtiOrigin`.
 */

/** API name of the marker field on Activity (Task). */
export const CTI_ORIGIN_FIELD = 'CTI_Origin__c';

/**
 * The values the CTI stamps. Keep these stable — Salesforce reports and list
 * views filter on the literal text, so renaming one silently empties them.
 * Max 64 characters (the field's length).
 */
export const CTI_ORIGIN = {
  /** Rolled-forward follow-up written by the power dialer's rollover worker. */
  followUp: 'Power Dialer Follow-Up',
  /** Call record logged against a Lead/Contact/Opportunity after a dial. */
  callLog: 'Call Log',
} as const;

export type CtiOrigin = (typeof CTI_ORIGIN)[keyof typeof CTI_ORIGIN];

/**
 * True when a Salesforce error payload reports an unknown/invisible field.
 *
 * Salesforce answers a create referencing a field the running user cannot see
 * with a 400 whose body is an ARRAY of `{ errorCode, message }`. The code is
 * `INVALID_FIELD` — and, on some endpoints, `INVALID_FIELD_FOR_INSERT_UPDATE` —
 * hence `startsWith` rather than equality.
 *
 * Deliberately tolerant of shape: the body may be a single object rather than an
 * array when the request never reached the row layer.
 */
export function isInvalidFieldError(json: unknown): boolean {
  const entries = Array.isArray(json) ? json : [json];
  return entries.some((e) => {
    const code = (e as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && code.startsWith('INVALID_FIELD');
  });
}

/**
 * A copy of `fields` without the marker. Used for the one retry that follows an
 * `INVALID_FIELD` rejection, so the task itself still gets created. Returns a
 * new object; the input is never mutated.
 */
export function withoutCtiOrigin<T extends Record<string, unknown>>(
  fields: T,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== CTI_ORIGIN_FIELD) rest[k] = v;
  }
  return rest;
}
