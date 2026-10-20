/**
 * What a log line may say about a caught error: its name, and its `code` when it is a string (a Postgres or
 * Node error code). Never the message: an error from the database, Resend or a parser can quote the address,
 * the subject or a field of the payload it choked on, and seller data is PII.
 */
export function describeError(err: unknown): { errorName: string; errorCode?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return { errorName: err instanceof Error ? err.name : typeof err, ...(typeof code === 'string' ? { errorCode: code } : {}) };
}
