/**
 * Public, no-login recording playback.
 *
 *   GET /recordings/:callId?sig=<hmac>
 *
 * Streams a call's recording MP3 to anyone with the signed link — no Twilio and
 * no Salesforce login. The audio lives in Twilio behind HTTP Basic auth; we
 * fetch it with our server-side credentials and proxy the bytes. The signature
 * (HMAC of the call id, see recording-links.ts) makes links unguessable so
 * nobody can enumerate other calls' recordings. Range requests are forwarded so
 * the browser <audio> element can seek.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { loadConfig } from '../config.js';
import { verifyRecordingSig } from '../telephony/recording-links.js';
// Re-validate the stored URL points at Twilio before fetching — prevents this
// authenticated proxy from being pointed at an arbitrary host (SSRF). Shared
// with the write side so the two checks can't drift.
import { UUID_RE, TWILIO_RECORDING_MEDIA_RE } from '../telephony/webhooks.js';

export async function registerRecordingRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();

  app.get('/recordings/:callId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { callId } = req.params as { callId: string };
    const { sig } = req.query as { sig?: string };
    // Uniform 404 for bad id / bad sig — never reveal which call ids exist.
    if (!callId || !UUID_RE.test(callId) || !sig || !verifyRecordingSig(callId, sig, cfg.SESSION_SECRET)) {
      return reply.code(404).send('Not found');
    }

    const db = getDb();
    const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) });
    if (!call || !call.recordingUrl || !TWILIO_RECORDING_MEDIA_RE.test(call.recordingUrl)) {
      return reply.code(404).send('Not found');
    }
    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) {
      return reply.code(503).send('Recording backend not configured');
    }

    const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
    const range = req.headers.range;
    // Abort the upstream fetch if the listener navigates away mid-stream, so we
    // don't hold a Twilio connection open for an audio nobody's listening to.
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    let upstream: Response;
    try {
      upstream = await fetch(call.recordingUrl, {
        headers: { authorization: `Basic ${auth}`, ...(range ? { range } : {}) },
        signal: ac.signal,
      });
    } catch (err) {
      req.log.warn({ callId, err: (err as Error).message }, 'recording_fetch_error');
      return reply.code(502).send('Recording unavailable');
    }
    if (upstream.status >= 400 || !upstream.body) {
      // Drain the error body so the pooled connection to Twilio is released.
      await upstream.body?.cancel().catch(() => {});
      req.log.warn({ callId, status: upstream.status }, 'recording_fetch_failed');
      return reply.code(502).send('Recording unavailable');
    }

    reply.code(upstream.status); // 200 full, or 206 for a Range request
    reply.header('content-type', upstream.headers.get('content-type') ?? 'audio/mpeg');
    const len = upstream.headers.get('content-length');
    if (len) reply.header('content-length', len);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) reply.header('content-range', contentRange);
    reply.header('accept-ranges', 'bytes');
    reply.header('content-disposition', 'inline');
    // Sensitive audio: cache only in the requesting browser, never shared caches.
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(Readable.fromWeb(upstream.body as never));
  });
}
