/**
 * Settles with `work`, or rejects with the signal's reason as soon as it aborts. The work itself
 * keeps running (the Salesforce reads carry their own request timeouts); only the caller stops waiting.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    // A rejection after the race was lost lands here and is ignored, never unhandled.
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
