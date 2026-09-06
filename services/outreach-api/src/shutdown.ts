export interface Stoppable { stop(): Promise<void> }
export interface Closable { close(): Promise<unknown> }

/**
 * Graceful shutdown: stop the job runner, then close the HTTP listener — the
 * listener closes even when `stop` rejects (a pg-boss drain that times out
 * must not leave the container waiting for SIGKILL with requests attached),
 * and that rejection is rethrown afterwards so it still reaches the log.
 */
export async function shutdown(runner: Stoppable, app: Closable): Promise<void> {
  try {
    await runner.stop();
  } finally {
    await app.close();
  }
}
