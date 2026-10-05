/**
 * cti-api listens on '::' (plan 1C): dual-stack, so the public edge and Railway's
 * healthcheck (IPv4) reach it exactly as before, and Railway's private network (IPv6-only
 * DNS in older environments) can reach the internal AI call routes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { LISTEN_HOST, listenOptions } from './listen.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('listen host', () => {
  it("is '::' on the configured port (PORT handling is unchanged: config maps PORT to API_PORT)", () => {
    expect(LISTEN_HOST).toBe('::');
    expect(listenOptions(4000)).toEqual({ port: 4000, host: '::' });
  });

  it('accepts IPv4 and IPv6 clients on one socket (the /healthz probe over both)', async () => {
    app = Fastify();
    app.get('/healthz', async () => ({ ok: true }));
    await app.listen(listenOptions(0));
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    expect(address.address).toBe('::');
    for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
      const res = await fetch(`http://${host}:${address.port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  });
});
