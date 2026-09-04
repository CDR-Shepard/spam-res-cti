/**
 * Serves the built outreach-web bundle at / with a history-API fallback: any GET
 * that is not an API or health path returns index.html. index.html is never
 * cached; hashed assets are immutable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** index.html must never be cached — a deploy must be visible on the next load. */
export const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0';

export function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (path === '/api' || path.startsWith('/api/')) return true;
  return path === '/healthz' || path === '/readyz';
}

export async function registerSpa(app: FastifyInstance, dist: string): Promise<void> {
  if (!existsSync(join(dist, 'index.html'))) {
    app.log.warn({ dist }, 'outreach-web bundle not built — / will 503 until `npm run build:outreach`');
    app.get('/*', async (req, reply) => {
      if (isApiPath(req.url)) return reply.callNotFound();
      return reply.code(503).send({ error: 'outreach-web not built', code: 'SPA_NOT_BUILT' });
    });
    return;
  }
  await app.register(staticPlugin, {
    root: dist,
    prefix: '/',
    wildcard: false,
    decorateReply: false,
    setHeaders(reply, path: string) {
      if (path.endsWith('.html')) reply.setHeader('Cache-Control', NO_STORE);
      else if (/\.(?:js|css|woff2?|ttf|otf|png|jpg|svg|ico)$/.test(path)) reply.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
  const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || isApiPath(req.url)) {
      return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND', requestId: req.id });
    }
    return reply.header('Cache-Control', NO_STORE).type('text/html').send(indexHtml);
  });
}
