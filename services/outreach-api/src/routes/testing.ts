/**
 * The Testing page's routes, admins only (plan docs/superpowers/plans/2026-10-16-inbound-agent-testing.md): the org's list of
 * test phones (the phones that get test calls from the AI phone agent, and that get the agent when they call one of its
 * numbers), and the newest inbound test calls with the agent's numbers to dial. cti-api answers the calls and writes the
 * `ai_calls` rows; this file reads them, and owns the list in `ai_test_phones` (strict E.164, unique per org, at most
 * TEST_PHONES_MAX). Phone numbers and labels are never logged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AddTestPhoneRequest,
  INBOUND_TEST_CALLS_SHOWN,
  InboundCallDetails,
  TEST_PHONES_MAX,
  type InboundTestCall,
  type InboundTestCallsResponse,
  type TestPhone,
  type TestPhonesResponse,
} from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { toE164 } from '@cti/phone';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

export const NOT_A_PHONE_WORDS = "That doesn't look like a phone number";
export const ALREADY_LISTED_WORDS = 'That phone is already on the list';
export const LIST_FULL_WORDS = `The list is full (${TEST_PHONES_MAX} phones) — remove one first`;
export const LABEL_TOO_LONG_WORDS = 'Keep the label to 60 characters or fewer';

const phones = schema.aiTestPhones;
const calls = schema.aiCalls;
const PhoneParams = z.object({ id: z.string().uuid() });

type AddOutcome = { kind: 'added'; id: string } | { kind: 'duplicate' } | { kind: 'full' };

/** The org's phones as the page lists them (the adder's email, oldest first), or just the one `id`. */
const phoneRows = (db: Db, orgId: string, id?: string) =>
  db
    .select({ id: phones.id, e164: phones.e164, label: phones.label, addedByEmail: schema.users.email, createdAt: phones.createdAt })
    .from(phones)
    .leftJoin(schema.users, eq(schema.users.id, phones.addedBy))
    .where(id ? and(eq(phones.orgId, orgId), eq(phones.id, id)) : eq(phones.orgId, orgId))
    .orderBy(asc(phones.createdAt), asc(phones.id));

const toTestPhone = (r: Awaited<ReturnType<typeof phoneRows>>[number]): TestPhone => ({ ...r, createdAt: r.createdAt.toISOString() });

/**
 * Adds a phone unless it is already listed or the list is full. The check and the insert run in one transaction under a
 * per-org advisory lock, so adds at the same moment cannot take the list past its limit; a duplicate is reported before a
 * full list (that phone is on it already).
 */
async function addPhone(db: Db, orgId: string, userId: string, e164: string, label: string): Promise<AddOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai_test_phones:${orgId}`}, 0))`);
    const rows = await tx.select({ e164: phones.e164 }).from(phones).where(eq(phones.orgId, orgId));
    if (rows.some((r) => r.e164 === e164)) return { kind: 'duplicate' } as const;
    if (rows.length >= TEST_PHONES_MAX) return { kind: 'full' } as const;
    const [inserted] = await tx.insert(phones).values({ orgId, e164, label, addedBy: userId }).returning({ id: phones.id });
    return { kind: 'added', id: inserted!.id } as const;
  });
}

/** Which sentence a refused body comes to: a too-long label has its own; anything else is "not a phone number". */
function refusedBody(error: z.ZodError): { code: string; words: string } {
  const onlyLabel = error.issues.length > 0 && error.issues.every((i) => i.path[0] === 'label');
  return onlyLabel ? { code: 'INVALID_LABEL', words: LABEL_TOO_LONG_WORDS } : { code: 'INVALID_PHONE', words: NOT_A_PHONE_WORDS };
}

/** The AI agent's numbers a tester can dial: this org's ai_pool numbers that take inbound calls. */
const aiNumbersOf = async (db: Db, orgId: string): Promise<string[]> => {
  const rows = await db
    .select({ e164: schema.outboundNumbers.e164 })
    .from(schema.outboundNumbers)
    .where(and(eq(schema.outboundNumbers.orgId, orgId), eq(schema.outboundNumbers.kind, 'ai_pool'), eq(schema.outboundNumbers.inboundEnabled, true)))
    .orderBy(asc(schema.outboundNumbers.e164));
  return rows.map((r) => r.e164);
};

/** The newest inbound calls of the org, with the list's label for each caller. The saved details a row does not parse into are `{}`. */
async function recentInboundCalls(db: Db, orgId: string): Promise<InboundTestCall[]> {
  const rows = await db
    .select({
      id: calls.id,
      callerE164: calls.toE164,
      callerLabel: phones.label,
      aiNumber: calls.fromE164,
      status: calls.status,
      outcome: calls.outcome,
      startedAt: calls.startedAt,
      createdAt: calls.createdAt,
      durationSeconds: calls.durationSeconds,
      qualification: calls.qualification,
    })
    .from(calls)
    .leftJoin(phones, and(eq(phones.orgId, calls.orgId), eq(phones.e164, calls.toE164)))
    .where(and(eq(calls.orgId, orgId), eq(calls.direction, 'inbound')))
    .orderBy(desc(calls.createdAt), desc(calls.id))
    .limit(INBOUND_TEST_CALLS_SHOWN);
  return rows.map(({ qualification, startedAt, createdAt, ...row }) => {
    const details = InboundCallDetails.safeParse(qualification);
    return { ...row, startedAt: (startedAt ?? createdAt).toISOString(), details: details.success ? details.data : {} };
  });
}

export async function registerTestingRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  /** The admin's tenant, or null once the 401/403 has been sent. */
  const adminOrg = async (req: FastifyRequest, reply: FastifyReply): Promise<{ orgId: string; userId: string } | null> => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return null;
    return { orgId: ctx.orgId, userId: ctx.session.userId };
  };

  app.get('/testing/phones', async (req, reply) => {
    const who = await adminOrg(req, reply);
    if (!who) return reply;
    return { phones: (await phoneRows(db, who.orgId)).map(toTestPhone) } satisfies TestPhonesResponse;
  });

  app.post('/testing/phones', async (req, reply) => {
    const who = await adminOrg(req, reply);
    if (!who) return reply;
    const body = AddTestPhoneRequest.safeParse(req.body ?? null);
    if (!body.success) {
      const { code, words } = refusedBody(body.error);
      return sendError(reply, 400, code, words);
    }
    const e164 = toE164(body.data.phone);
    if (!e164) return sendError(reply, 400, 'INVALID_PHONE', NOT_A_PHONE_WORDS);
    const added = await addPhone(db, who.orgId, who.userId, e164, body.data.label);
    if (added.kind === 'duplicate') return sendError(reply, 409, 'PHONE_ALREADY_LISTED', ALREADY_LISTED_WORDS);
    if (added.kind === 'full') return sendError(reply, 400, 'LIST_FULL', LIST_FULL_WORDS);
    const [row] = await phoneRows(db, who.orgId, added.id);
    return reply.code(201).send(toTestPhone(row!));
  });

  app.delete('/testing/phones/:id', async (req, reply) => {
    const who = await adminOrg(req, reply);
    if (!who) return reply;
    const params = PhoneParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'NOT_FOUND', 'No such phone on the list.');
    const removed = await db.delete(phones).where(and(eq(phones.id, params.data.id), eq(phones.orgId, who.orgId))).returning({ id: phones.id });
    if (removed.length === 0) return sendError(reply, 404, 'NOT_FOUND', 'No such phone on the list.');
    return reply.code(204).send();
  });

  app.get('/testing/inbound-calls', async (req, reply) => {
    const who = await adminOrg(req, reply);
    if (!who) return reply;
    const [aiNumbers, recent] = await Promise.all([aiNumbersOf(db, who.orgId), recentInboundCalls(db, who.orgId)]);
    return { aiNumbers, calls: recent } satisfies InboundTestCallsResponse;
  });
}
