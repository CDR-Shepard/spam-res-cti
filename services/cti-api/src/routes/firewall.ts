import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { evaluate } from '../firewall/index.js';
import { getDb } from '../db/index.js';
import { normalize } from '../phone.js';

const Body = z.object({
  toNumber: z.string().min(1),
  fromNumber: z.string().optional(),
  campaignKey: z.string().optional(),
  recipientTimezone: z.string().optional(),
  /** Salesforce record id (Lead/Contact); used to look up address → TZ.
   *  15- or 18-char alphanumeric (SF Id format). */
  recipientRecordId: z
    .string()
    .regex(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/, 'Invalid Salesforce id')
    .optional(),
});

export async function registerFirewallRoutes(app: FastifyInstance): Promise<void> {
  app.post('/firewall/precall', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const db = getDb();
    const requestId = req.id;
    const result = await evaluate(db, {
      orgId: session.orgId,
      userId: session.userId,
      toNumberRaw: parsed.data.toNumber,
      fromNumber: parsed.data.fromNumber,
      campaignKey: parsed.data.campaignKey,
      recipientTimezone: parsed.data.recipientTimezone,
      recipientRecordId: parsed.data.recipientRecordId,
      requestId,
    });
    return result;
  });

  app.post('/firewall/normalize', async (req, reply) => {
    const parsed = z.object({ value: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return normalize(parsed.data.value);
  });
}
