import type { FastifyRequest } from 'fastify';

/** OAuth redirect endpoints: their query string carries the one-time `code` and `state`. */
const CALLBACK_PATH = /\/callback$/;

/** The unsubscribe link's token (the whole credential for a seller's opt-out) is the last path segment. */
const UNSUBSCRIBE_PATH = /^(\/api\/email\/unsubscribe\/)[^/?#]*/;

/**
 * The URL to log: the query string is dropped on OAuth callbacks so a code or state never reaches the logs,
 * and an unsubscribe link's token is replaced by `:token`.
 */
export function loggableUrl(url: string): string {
  const redacted = url.replace(UNSUBSCRIBE_PATH, '$1:token');
  const queryAt = redacted.indexOf('?');
  if (queryAt === -1) return redacted;
  const path = redacted.slice(0, queryAt);
  return CALLBACK_PATH.test(path) ? path : redacted;
}

/** Fastify's default `req` log shape with `loggableUrl` applied. */
export function serializeRequest(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: loggableUrl(req.url),
    version: req.headers['accept-version'],
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
