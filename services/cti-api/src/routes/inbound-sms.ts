/**
 * Inbound texts webhook — POST /telephony/twilio/sms.
 *
 * Reps' numbers receive texts that nothing used to handle (Twilio accepted them
 * with no SmsUrl and they were never seen). This route STORES each one and
 * answers at once; sms/inbound-text-worker.ts turns the stored row into a
 * Salesforce Task and an email alert for the rep, off the request path.
 *
 * Twilio number config: each IncomingPhoneNumber's `SmsUrl` should point at
 *   POST ${API_PUBLIC_URL}/telephony/twilio/sms
 *
 * Three rules shape everything here:
 *  - ALWAYS an empty `<Response/>` with a 200 once the signature checks out —
 *    duplicates, unknown numbers, and our own errors included. We never auto-
 *    reply, and a 500 would make Twilio retry a text we may already hold.
 *  - Idempotent on MessageSid: `inbound_messages.message_sid` is UNIQUE and the
 *    insert is ON CONFLICT DO NOTHING, so a retried webhook is a no-op. There is
 *    deliberately no provider_webhook_events copy: that inbox stores the whole
 *    request body, and the body is the private message.
 *  - The message body is NEVER logged — log lines carry the MessageSid only, and
 *    errors are reduced to name/code/message (a Postgres constraint error's
 *    `detail` quotes the failing row, body and all).
 *
 * A STOP (a carrier opt-out word as the whole message, or Twilio's own
 * OptOutType=STOP) to one of our numbers also puts the sender on `opt_outs`,
 * the do-not-call list the dialer and click-to-dial check: people text STOP to
 * the number that keeps CALLING them (2026-11-18: two did, and both were still
 * in dialer lists).
 * Design: docs/superpowers/specs/2026-09-25-inbound-texts-design.md.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { OutboundNumber } from '@cti/db';
import { normalize } from '@cti/phone';
import { loadConfig } from '../config.js';
import { getProvider } from '../telephony/index.js';
import { lastDialerForCaller, stickyAgentForCaller } from '../dialer/sticky.js';
import { chooseTextRecipient, isOptOutText } from '../sms/inbound-text.js';
import { aiCallbackRep } from '../ai-voice/number-pool.js';

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/** SM… for SMS, MM… for MMS. Anything else is not a Twilio message we can key on. */
const TWILIO_MESSAGE_SID_RE = /^(SM|MM)[0-9a-f]{32}$/i;

type Db = ReturnType<typeof getDb>;

/**
 * The row insert, idempotent on a replayed MessageSid. The bare
 * `onConflictDoNothing()` (repo convention) arbitrates on any unique index,
 * here `inbound_messages_message_sid_unique` — a FULL index, so a named target
 * would also work, but the bare form cannot regress into the 42P10 that a
 * partial index plus a named target causes. inbound-sms.test.ts pins the SQL.
 */
export function insertInboundMessage(db: Db, values: typeof schema.inboundMessages.$inferInsert) {
  return db
    .insert(schema.inboundMessages)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: schema.inboundMessages.id });
}

/**
 * The do-not-call row a STOP text writes. opt_outs is what the power dialer
 * (session start) and click-to-dial (the firewall) check before dialing. Bare
 * `onConflictDoNothing()`: opt_outs_org_e164_unique is a full index, and a
 * second STOP from someone already listed is a no-op.
 */
export function insertTextOptOut(db: Db, values: { orgId: string; e164: string; note: string }) {
  return db
    .insert(schema.optOuts)
    .values({ ...values, source: 'stop_keyword' })
    .onConflictDoNothing();
}

/** Only a real phone number can be dialed, so only a real one is worth listing. */
const DIALABLE_E164_RE = /^\+[1-9]\d{6,14}$/;

/** What the opt-out note says the person sent — a carrier keyword, never free text. */
function optOutKeyword(body: Record<string, string>): string | null {
  if (isOptOutText(body.Body)) return (body.Body ?? '').trim().toUpperCase();
  if ((body.OptOutType ?? '').toUpperCase() === 'STOP') return 'STOP (Twilio opt-out)';
  return null;
}

/**
 * Someone texting STOP to a number that keeps calling them is asking us to stop
 * calling. Written before the text itself so a failed text insert cannot lose
 * it, and on its own try so a failed opt-out never costs the text.
 */
async function recordOptOut(
  db: Db,
  owned: OutboundNumber,
  fromE164: string,
  keyword: string,
  log: FastifyBaseLogger,
  messageSid: string,
): Promise<void> {
  if (!DIALABLE_E164_RE.test(fromE164)) return;
  try {
    await insertTextOptOut(db, { orgId: owned.orgId, e164: fromE164, note: `Texted ${keyword} to ${owned.e164}` });
    log.info({ messageSid, numberId: owned.id }, 'inbound_sms_opt_out_recorded');
  } catch (err) {
    log.error({ messageSid, err: safeError(err) }, 'inbound_sms_opt_out_failed');
  }
}

/** An error reduced to what is safe to log: never `detail`, which can quote the stored row. */
export function safeError(err: unknown): { name?: string; code?: string; message: string } {
  if (!(err instanceof Error)) return { message: String(err).slice(0, 200) };
  const code = (err as { code?: unknown }).code;
  return { name: err.name, ...(typeof code === 'string' ? { code } : {}), message: err.message.slice(0, 500) };
}

function toE164(raw: string): string {
  return normalize(raw)?.value?.e164 ?? raw;
}

/** A routing lookup that fails degrades to "no rep from this rule", never a lost webhook. */
async function orNone(
  lookup: () => Promise<string | null>,
  log: FastifyBaseLogger,
  rule: string,
  messageSid: string,
): Promise<string | null> {
  try {
    return await lookup();
  } catch (err) {
    log.warn({ messageSid, rule, err: safeError(err) }, 'inbound_sms_route_lookup_failed');
    return null;
  }
}

/**
 * Who the text goes to. Only pool numbers consult the callback rules, and the
 * last-dialer lookup only runs when there is no sticky rep — a conversation
 * beats a dial, exactly as for a callback (routes/inbound.ts).
 */
async function recipientFor(
  db: Db,
  owned: OutboundNumber,
  fromE164: string,
  log: FastifyBaseLogger,
  messageSid: string,
): Promise<string | null> {
  if (owned.kind === 'ai_pool') {
    const aiRep = await orNone(() => aiCallbackRep(db, owned.orgId, fromE164, owned.e164), log, 'ai_callback', messageSid);
    return chooseTextRecipient(owned, null, null, aiRep);
  }
  if (owned.kind !== 'dialer_pool') return chooseTextRecipient(owned, null, null);
  const sticky = await orNone(() => stickyAgentForCaller(db, owned.orgId, fromE164, owned.e164), log, 'sticky', messageSid);
  const lastDialer = sticky
    ? null
    : await orNone(() => lastDialerForCaller(db, owned.orgId, fromE164, owned.e164), log, 'last_dialer', messageSid);
  return chooseTextRecipient(owned, sticky, lastDialer);
}

function parseNumMedia(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `storeText: false` (the INBOUND_TEXTS kill switch) records a STOP and nothing
 * else: no text row, so no Task or alert follows.
 */
async function storeInboundText(
  db: Db,
  body: Record<string, string>,
  log: FastifyBaseLogger,
  { storeText }: { storeText: boolean } = { storeText: true },
): Promise<void> {
  const messageSid = body.MessageSid ?? '';
  if (!TWILIO_MESSAGE_SID_RE.test(messageSid)) {
    log.warn({ messageSid: messageSid.slice(0, 64) }, 'inbound_sms_bad_message_sid');
    return;
  }
  const fromE164 = toE164(body.From ?? '');
  const toNumber = toE164(body.To ?? '');

  const owned = await db.query.outboundNumbers.findFirst({ where: eq(schema.outboundNumbers.e164, toNumber) });
  if (!owned) {
    log.info({ messageSid, to: toNumber }, 'inbound_sms_unknown_number');
    return;
  }

  const keyword = optOutKeyword(body);
  if (keyword) await recordOptOut(db, owned, fromE164, keyword, log, messageSid);
  if (!storeText) return;

  const userId = await recipientFor(db, owned, fromE164, log, messageSid);
  const inserted = await insertInboundMessage(db, {
    orgId: owned.orgId,
    messageSid,
    fromE164,
    toE164: owned.e164,
    body: body.Body ?? '',
    numMedia: parseNumMedia(body.NumMedia),
    userId,
    // No rep → nothing to do, ever. Stored anyway so the backfill and the
    // runbook can see the text arrived.
    status: userId ? 'pending' : 'skipped',
    backfill: false,
    receivedAt: new Date(),
  });
  log.info(
    { messageSid, numberId: owned.id, userId, duplicate: inserted.length === 0 },
    userId ? 'inbound_sms_stored' : 'inbound_sms_skipped_no_rep',
  );
}

export async function registerInboundSmsRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();

  app.post('/telephony/twilio/sms', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/sms`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    // Reject unsigned requests BEFORE storing the PII-bearing body. Always
    // enforced unless the explicit local-dev skip flag is set.
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) {
      return reply.code(403).send('Invalid signature');
    }
    const body = (req.body ?? {}) as Record<string, string>;
    // Kill switch (config.ts INBOUND_TEXTS): answer as usual, store no text, so
    // turning it back on never bursts a backlog of alerts. Twilio keeps the text;
    // the backfill script can recover it. A STOP is still recorded — the switch
    // silences alerts, never an opt-out — and only a STOP touches the database.
    if (cfg.INBOUND_TEXTS === 'off') {
      req.log.info({ messageSid: (body.MessageSid ?? '').slice(0, 64) }, 'inbound_sms_disabled');
      if (optOutKeyword(body)) {
        try {
          await storeInboundText(getDb(), body, req.log, { storeText: false });
        } catch (err) {
          req.log.error({ messageSid: (body.MessageSid ?? '').slice(0, 64), err: safeError(err) }, 'inbound_sms_opt_out_failed');
        }
      }
      return reply.type('text/xml').send(EMPTY_TWIML);
    }
    try {
      await storeInboundText(getDb(), body, req.log);
    } catch (err) {
      // Swallowed on purpose: Twilio retries a 5xx, and we cannot tell a failed
      // insert from one that landed and failed afterwards. The log line is how
      // an operator finds it (and the backfill can recover it by MessageSid).
      req.log.error({ messageSid: (body.MessageSid ?? '').slice(0, 64), err: safeError(err) }, 'inbound_sms_store_failed');
    }
    return reply.type('text/xml').send(EMPTY_TWIML);
  });
}
