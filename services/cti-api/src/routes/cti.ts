/**
 * Serves the built cti-web bundle (Salesforce Open CTI softphone) at /cti/*.
 * Sets iframe-permissive headers so Salesforce Lightning can embed us.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where vite drops the built cti-web bundle. */
const CTI_DIST = resolve(__dirname, '../../../../apps/cti-web/dist');

const IFRAME_ALLOWED_ANCESTORS = [
  "'self'",
  'https://*.lightning.force.com',
  'https://*.salesforce.com',
  'https://*.visualforce.com',
  'https://*.force.com',
].join(' ');

export async function registerCtiRoutes(app: FastifyInstance): Promise<void> {
  if (!existsSync(CTI_DIST)) {
    app.log.warn(
      { dist: CTI_DIST },
      'cti-web bundle not built — /cti will 404 until you run `npm run build` in apps/cti-web',
    );
    app.get('/cti/*', async (_req, reply) => {
      return reply.code(503).send({
        error: 'cti-web not built yet',
        hint: 'Run `npm --workspace apps/cti-web run build`',
      });
    });
    return;
  }

  await app.register(staticPlugin, {
    root: CTI_DIST,
    prefix: '/cti/',
    decorateReply: false,
    setHeaders(reply, path: string) {
      // Allow Salesforce Lightning to iframe us.
      // Removing X-Frame-Options entirely (browser already supports CSP frame-ancestors).
      (reply as unknown as { removeHeader?: (n: string) => void }).removeHeader?.('x-frame-options');
      reply.setHeader(
        'Content-Security-Policy',
        `frame-ancestors ${IFRAME_ALLOWED_ANCESTORS};`,
      );
      // index.html must never be cached — JS/CSS are content-hashed so they're
      // fine to cache aggressively, but index.html *references* those hashes
      // and needs to stay fresh, or Salesforce will keep loading yesterday's
      // bundle even after a deploy.
      if (path.endsWith('.html')) {
        reply.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        reply.setHeader('Pragma', 'no-cache');
        reply.setHeader('Expires', '0');
      } else if (/\.(?:js|css|woff2?|ttf|otf|png|jpg|svg)$/.test(path)) {
        // Content-hashed assets: cache forever, immutable.
        reply.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  // SPA fallback: any unmatched /cti/* path serves index.html.
  app.get('/cti', async (_req, reply) => reply.redirect('/cti/'));
}
