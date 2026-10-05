/**
 * A missing object or field (no Chatter, no EmailMessage, no Skip on Dialer), or one the
 * integration user may not read, degrades research and is recorded. An outage, a timeout or
 * an auth failure is thrown, so the whole research is retried later instead of producing a
 * plan from half the data.
 */
import type { ResearchSource, ResearchSourceSummary } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';

const MISSING = new Set(['INVALID_TYPE', 'INVALID_FIELD', 'NOT_FOUND', 'MALFORMED_QUERY', 'INVALID_QUERY_FILTER_OPERATOR']);
const DENIED = new Set(['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'API_DISABLED_FOR_ORG', 'FUNCTIONALITY_NOT_ENABLED']);

/** Throttling and "try again" answers: not a property of the org, so they must not be recorded as a degraded source. */
const TRANSIENT = new Set(['REQUEST_LIMIT_EXCEEDED', 'SERVER_UNAVAILABLE', 'UNABLE_TO_LOCK_ROW', 'QUERY_TIMEOUT', 'CONCURRENT_REQUESTS_LIMIT_EXCEEDED']);

export interface SourceRead<T> {
  summary: ResearchSourceSummary;
  items: T[];
}

export function salesforceErrorCode(err: SalesforceApiError): string | null {
  const first: unknown = Array.isArray(err.body) ? err.body[0] : err.body;
  const code = (first as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === 'string' ? code : null;
}

export function classifyReadError(err: unknown): { status: 'missing' | 'denied' | 'error'; note: string } {
  if (!(err instanceof SalesforceApiError) || err.status === 0 || err.status >= 500) throw err;
  const code = salesforceErrorCode(err) ?? `HTTP_${err.status}`;
  if (err.status === 408 || err.status === 429 || TRANSIENT.has(code)) throw err;
  if (MISSING.has(code)) return { status: 'missing', note: code };
  if (DENIED.has(code)) return { status: 'denied', note: code };
  return { status: 'error', note: code };
}

export async function readSource<T>(source: ResearchSource, read: () => Promise<{ items: T[]; truncated: boolean }>): Promise<SourceRead<T>> {
  try {
    const { items, truncated } = await read();
    return { items, summary: { source, status: 'ok', count: items.length, truncated, note: null } };
  } catch (err) {
    const { status, note } = classifyReadError(err);
    return { items: [], summary: { source, status, count: 0, truncated: false, note } };
  }
}

export const skippedSource = (source: ResearchSource, note: string): ResearchSourceSummary => ({ source, status: 'skipped', count: 0, truncated: false, note });
