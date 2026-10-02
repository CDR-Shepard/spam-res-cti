/**
 * Console-safe error summaries shared by the Salesforce workers. `errorText`
 * is the full text (500 chars) for a row's last_error column; the two
 * summaries are what may reach a log line — Salesforce errorCodes, an HTTP
 * status, a Postgres SQLSTATE or an error class, never a message body
 * (Salesforce echoes field values such as phone numbers on some codes).
 */
export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

const SF_ERROR_FALLBACK = 'Salesforce error (see last_error)';

/**
 * Console-safe summary of a Salesforce error (M3, final review, THIS worker
 * only — the sibling workers' identical pattern is a separate ticket).
 * `errorText()` embeds client.ts's raw `JSON.stringify(res.json)`, and
 * Salesforce echoes field VALUES back on a few error codes — notably
 * STRING_TOO_LONG on Subject, which here contains the call's formatted phone
 * number. Logs get only the Salesforce errorCode(s) (and an HTTP status, when
 * the message happens to carry one) — never the raw body. `last_error` keeps
 * the full text via `errorText()` for hand repair; nothing about that changes.
 */
export function sfErrorSummary(err: unknown): string {
  const message = errorText(err);
  // Only "(404): " — a status always precedes a colon in this codebase's error
  // messages (client.ts, followup-worker.ts). Without the colon, a phone
  // number's area code — e.g. "(619) 555-9999" — would misread as a status.
  const status = message.match(/\((\d{3})\):/)?.[1];
  const codes = [...new Set([...message.matchAll(/"errorCode"\s*:\s*"([A-Za-z_]+)"/g)].map((m) => m[1]))];
  const parts: string[] = [];
  if (status) parts.push(`status=${status}`);
  if (codes.length) parts.push(`errorCodes=${codes.join(',')}`);
  return parts.length ? parts.join(' ') : SF_ERROR_FALLBACK;
}

/**
 * guarded()'s catch-all sees database errors too, and nothing wrote
 * `last_error` on that path — so no pointer to it. A Postgres error is named by
 * its SQLSTATE (its message can quote a value, e.g. invalid input syntax); a
 * Salesforce-shaped error keeps its errorCode summary; anything else, only its
 * class. Never a message on the console.
 */
export function unexpectedErrorSummary(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `pg=${code}`;
  const sf = sfErrorSummary(err);
  if (sf !== SF_ERROR_FALLBACK) return sf;
  return err instanceof Error ? err.name : typeof err;
}
