/**
 * The commit @cti/api (the AI voice server) is running, read from its public liveness probe over the private network
 * (the same CTI_INTERNAL_URL the signed AI call trigger uses). /healthz needs no signature and carries no secret.
 * The reader never throws: any failure is null, which the sidebar shows as "Calls unknown". The answer (a failure too)
 * is cached for 30 seconds and requests that arrive together share one fetch, so a down cti-api costs one 2 second
 * timeout per half minute, not one per page load.
 */
import { CtiBuildHealth, shortCommit } from '@cti/contracts';

export const CTI_VERSION_TIMEOUT_MS = 2_000;
export const CTI_VERSION_CACHE_MS = 30_000;

export interface CtiCommit {
  commit: string;
}

export interface CtiCommitReaderOptions {
  /** CTI_INTERNAL_URL: an origin only. Undefined when the service is not configured: the reader then answers null without a request. */
  baseUrl: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam: the clock the cache measures against. */
  now?: () => number;
}

async function fetchCommit(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<CtiCommit | null> {
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    const parsed = CtiBuildHealth.safeParse(await res.json());
    // Re-shortened here: only a commit sha (or 'dev') ever leaves this function, whatever cti-api sent.
    return parsed.success ? { commit: shortCommit(parsed.data.commit) } : null;
  } catch {
    return null;
  }
}

export function ctiCommitReader(options: CtiCommitReaderOptions): () => Promise<CtiCommit | null> {
  const { baseUrl, fetchImpl = fetch, timeoutMs = CTI_VERSION_TIMEOUT_MS, now = Date.now } = options;
  if (!baseUrl) return async () => null;
  const url = `${baseUrl.replace(/\/+$/, '')}/healthz`;
  let cached: { at: number; answer: CtiCommit | null } | null = null;
  let inFlight: Promise<CtiCommit | null> | null = null;

  return async () => {
    if (cached && now() - cached.at <= CTI_VERSION_CACHE_MS) return cached.answer;
    inFlight ??= fetchCommit(url, fetchImpl, timeoutMs)
      .then((answer) => {
        cached = { at: now(), answer };
        return answer;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
