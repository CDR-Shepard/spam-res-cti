import type { FastifyRequest } from 'fastify';

/** OAuth redirect endpoints: their query string carries the one-time `code` and `state`. */
const CALLBACK_PATH = /\/callback$/;

/** The URL to log: the query string is dropped on OAuth callbacks so a code or state never reaches the logs. */
export function loggableUrl(url: string): string {
  const queryAt = url.indexOf('?');
  if (queryAt === -1) return url;
  const path = url.slice(0, queryAt);
  return CALLBACK_PATH.test(path) ? path : url;
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
