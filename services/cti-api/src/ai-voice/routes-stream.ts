/**
 * The Twilio media-stream WebSocket: `GET /telephony/twilio/ai-voice/stream`.
 *
 * `@fastify/websocket` (v10, Fastify 4) is registered inside its own
 * encapsulated scope here, so its hooks and decorators touch no other route,
 * and it only ever sees upgrades for the stream path (streamOnlyUpgrades).
 *
 * The upgrade is refused (403) unless `X-Twilio-Signature` validates against
 * the exact wss:// URL our TwiML names — built from API_PUBLIC_URL, never the
 * Host header (also accepting a trailing slash, as Twilio sometimes signs
 * it). `TWILIO_SKIP_SIGNATURE_CHECK` is honoured for local development only.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import twilio from 'twilio';
import type { AppConfig } from '../config.js';
import { runStreamSession, type StreamSessionDeps } from './stream-session.js';
import { STREAM_PATH, streamWssUrl } from './twilio.js';
import { wsToBridgeSocket } from './ws-adapter.js';

/** Does the upgrade carry Twilio's signature over our own wss:// stream URL? */
export function validStreamSignature(
  cfg: Pick<AppConfig, 'API_PUBLIC_URL' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_SKIP_SIGNATURE_CHECK'>,
  signature: unknown,
): boolean {
  if (cfg.TWILIO_SKIP_SIGNATURE_CHECK) return true;
  if (typeof signature !== 'string' || !signature || !cfg.TWILIO_AUTH_TOKEN) return false;
  const url = streamWssUrl(cfg.API_PUBLIC_URL);
  return (
    twilio.validateRequest(cfg.TWILIO_AUTH_TOKEN, signature, url, {}) ||
    twilio.validateRequest(cfg.TWILIO_AUTH_TOKEN, signature, `${url}/`, {})
  );
}

const pathOf = (url: string | undefined): string => (url ?? '').split('?')[0] ?? '';

/**
 * The plugin listens to EVERY upgrade on the shared http server and routes it
 * through Fastify — an upgrade to any other route would then get a normal
 * response on a socket nobody closes (leaking it and stalling shutdown).
 * Instead it listens on a private emitter, and only upgrades for the stream
 * path are forwarded there. Any other upgrade gets Node's default (the socket
 * is destroyed) unless some other upgrade listener exists to take it.
 */
function streamOnlyUpgrades(scope: FastifyInstance): EventEmitter {
  const upgrades = new EventEmitter();
  const server = scope.server;
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (pathOf(req.url) === STREAM_PATH) upgrades.emit('upgrade', req, socket, head);
    else if (server.listenerCount('upgrade') === 1) socket.destroy();
  };
  server.on('upgrade', onUpgrade);
  scope.addHook('onClose', (_instance, done) => {
    server.removeListener('upgrade', onUpgrade);
    done();
  });
  return upgrades;
}

export async function registerAiVoiceStreamRoute(
  app: FastifyInstance,
  deps: (req: FastifyRequest) => StreamSessionDeps,
): Promise<void> {
  await app.register(async (scope) => {
    const upgrades = streamOnlyUpgrades(scope);
    await scope.register(websocket, { options: { server: upgrades as unknown as HttpServer } });
    scope.get(
      STREAM_PATH,
      {
        websocket: true,
        preValidation: async (req, reply) => {
          if (!validStreamSignature(deps(req).cfg, req.headers['x-twilio-signature'])) {
            req.log.warn('ai-voice: stream upgrade with a bad signature');
            return reply.code(403).send();
          }
        },
      },
      (socket, req) => {
        void runStreamSession(wsToBridgeSocket(socket), deps(req));
      },
    );
  });
}
