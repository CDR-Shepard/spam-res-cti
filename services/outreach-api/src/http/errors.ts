import type { FastifyReply } from 'fastify';

/** The one error envelope every route sends (see @cti/contracts ApiError). */
export function sendError(reply: FastifyReply, status: number, code: string, error: string, details?: unknown): FastifyReply {
  const body: Record<string, unknown> = { error, code, requestId: reply.request.id };
  if (details !== undefined) body.details = details;
  return reply.code(status).send(body);
}
