/**
 * Inbound Twilio call handler.
 *
 * Why this exists: carrier anti-spam scanners (Hiya, T-Mobile Scam Shield, etc.)
 * reverse-call our outbound numbers to see if a real human-ish voice answers.
 * Numbers that never answer get flagged. By auto-greeting every inbound call
 * (with a personalized message if the caller is in our SF) we keep the
 * outbound caller-reputation clean AND capture missed leads.
 *
 * Twilio number config: each IncomingPhoneNumber's `VoiceUrl` should point at
 *   POST ${API_PUBLIC_URL}/telephony/twilio/inbound
 *
 * Recording done via `<Record action=…>` which POSTs us a callback when the
 * caller hangs up. The `transcribe=true` option triggers a separate
 * transcription callback to /telephony/twilio/inbound/transcription.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import twilio from 'twilio';
import { getDb, schema } from '../db/index.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../telephony/index.js';
import { findByPhone } from '../salesforce/client.js';
import { normalize } from '../phone.js';
import { sha256 } from '../crypto.js';

function defaultGreeting(matched: boolean, name?: string | null): string {
  if (matched && name) {
    return `Hi ${name.split(' ')[0]}, thanks for calling back. Please leave a message after the tone and someone will get right back to you.`;
  }
  if (matched) {
    return 'Thanks for calling back. Please leave a message after the tone and someone will get right back to you.';
  }
  return 'Hi, thanks for calling. We didn\'t recognize this number — please leave a brief message describing how we can help, and someone will reach out shortly.';
}

function sanitizeHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk.includes('cookie') || lk === 'authorization') continue;
    out[k] = v;
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWILIO_CALL_SID_RE = /^CA[a-f0-9]{32}$/i;
const TWILIO_RECORDING_URL_RE = /^https:\/\/api\.twilio\.com\//;

export async function registerInboundRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();

  app.post('/telephony/twilio/inbound', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    const body = req.body as Record<string, string>;
    // Reject unsigned requests BEFORE persisting the PII-bearing body. Always
    // enforced unless the explicit local-dev skip flag is set.
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) {
      return reply.code(403).send('Invalid signature');
    }
    const externalId = `inbound:${body.CallSid ?? sha256(rawBody)}`;

    const db = getDb();
    try {
      await db.insert(schema.providerWebhookEvents).values({
        provider: provider.name,
        externalId,
        signatureValid: valid.valid,
        headers: sanitizeHeaders(req.headers),
        body,
      });
    } catch {
      // Idempotent ack (duplicate webhook). Just continue to render TwiML.
    }

    const fromRaw = body.From ?? '';
    const toRaw = body.To ?? '';
    const callSid = body.CallSid ?? '';
    const normFrom = normalize(fromRaw)?.value?.e164 ?? fromRaw;
    const normTo = normalize(toRaw)?.value?.e164 ?? toRaw;

    // Look up which org owns this `To` number and read inbound config.
    const owned = await db.query.outboundNumbers.findFirst({
      where: eq(schema.outboundNumbers.e164, normTo),
    });
    if (!owned || !owned.inboundEnabled) {
      // Number isn't enabled for inbound. Politely answer + hang up so the
      // scanner still hears a human voice (better for reputation than
      // letting Twilio's default kick in).
      const t = new twilio.twiml.VoiceResponse();
      t.say({ voice: 'Polly.Joanna' as never }, 'Sorry, this line cannot accept inbound calls right now. Goodbye.');
      t.hangup();
      return reply.type('text/xml').send(t.toString());
    }

    // Try to match the caller in Salesforce. We pick any user in the org
    // with an active SF connection; for MVP single-user this is just our rep.
    let matched: { whoId?: string; whatId?: string; name?: string } | null = null;
    const sfConn = await db.query.salesforceConnections.findFirst({
      where: undefined,
    });
    if (sfConn) {
      try {
        const m = await findByPhone(sfConn.userId, normFrom);
        if (m?.whoId) matched = { whoId: m.whoId, whatId: m.whatId, name: m.name };
      } catch (err) {
        app.log.warn({ err }, 'inbound_sf_lookup_failed');
      }
    }

    // Insert the inbound call record so we can update with recording / transcript later.
    const [callRow] = await db
      .insert(schema.calls)
      .values({
        orgId: owned.orgId,
        userId: sfConn?.userId ?? '00000000-0000-0000-0000-00000000beef', // dev rep fallback
        provider: provider.name,
        providerCallId: callSid,
        fromNumber: fromRaw,
        toNumber: toRaw,
        normalizedToNumber: normTo,
        direction: 'inbound',
        status: 'in_progress',
        startedAt: new Date(),
        salesforceWhoId: matched?.whoId ?? null,
        salesforceWhatId: matched?.whatId ?? null,
        inboundCallerMatched: !!matched,
      })
      .returning({ id: schema.calls.id });
    const callDbId = callRow!.id;

    const greeting =
      (matched ? owned.inboundMatchedGreeting : owned.inboundGreeting) ??
      defaultGreeting(!!matched, matched?.name ?? null);

    const t = new twilio.twiml.VoiceResponse();
    t.say({ voice: 'Polly.Joanna' as never }, greeting);

    // If a forward number is configured AND the caller is matched, ring it
    // through (typical "VIP routing"). Otherwise record a voicemail.
    if (matched && owned.inboundForwardToE164) {
      const dial = t.dial({
        callerId: owned.e164,
        timeout: 25,
        answerOnBridge: true,
        action: `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/dial-result?callDbId=${encodeURIComponent(callDbId)}`,
        method: 'POST',
      });
      dial.number(owned.inboundForwardToE164);
    } else {
      // Record voicemail; transcribe if enabled. Twilio limits maxLength to 3600s.
      t.record({
        maxLength: Math.min(Math.max(owned.inboundRecordSeconds ?? 60, 10), 600),
        playBeep: true,
        timeout: 5,
        trim: 'trim-silence',
        recordingStatusCallback: `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/recording?callDbId=${encodeURIComponent(callDbId)}`,
        recordingStatusCallbackEvent: ['completed'],
        ...(owned.inboundTranscribe
          ? {
              transcribe: true,
              transcribeCallback: `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/transcription?callDbId=${encodeURIComponent(callDbId)}`,
            }
          : {}),
        action: `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/recording?callDbId=${encodeURIComponent(callDbId)}`,
      });
      t.say({ voice: 'Polly.Joanna' as never }, 'Thanks, your message has been received. Goodbye.');
      t.hangup();
    }

    await db
      .update(schema.providerWebhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.providerWebhookEvents.externalId, externalId));

    return reply.type('text/xml').send(t.toString());
  });

  // Recording-completed callback — Twilio POSTs after the voicemail finishes.
  app.post('/telephony/twilio/inbound/recording', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/recording`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) return reply.code(403).send('bad sig');

    const body = req.body as Record<string, string>;
    const q = req.query as { callDbId?: string };
    // Validate the callDbId is a UUID we wrote, not a value an attacker
    // crafted to overwrite arbitrary call rows.
    if (!q.callDbId || !UUID_RE.test(q.callDbId)) {
      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    // Cross-check the Twilio CallSid matches the providerCallId we stored for
    // that row — defence in depth in case signature validation is somehow
    // bypassed or the URL is replayed.
    const callSid = body.CallSid;
    if (!callSid || !TWILIO_CALL_SID_RE.test(callSid)) {
      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    const recordingUrl = body.RecordingUrl && TWILIO_RECORDING_URL_RE.test(body.RecordingUrl)
      ? `${body.RecordingUrl}.mp3`
      : null;
    const db = getDb();
    await db
      .update(schema.calls)
      .set({
        inboundVoicemailUrl: recordingUrl,
        recordingUrl: recordingUrl, // mirror to standard column
        endedAt: new Date(),
        status: 'completed',
        durationSeconds: body.RecordingDuration ? Number(body.RecordingDuration) : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.calls.id, q.callDbId), eq(schema.calls.providerCallId, callSid)));
    return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  // Transcription callback — fires asynchronously when Twilio finishes STT.
  app.post('/telephony/twilio/inbound/transcription', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/transcription`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) return reply.code(403).send('bad sig');

    const body = req.body as Record<string, string>;
    const q = req.query as { callDbId?: string };
    if (!q.callDbId || !UUID_RE.test(q.callDbId)) {
      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    const callSid = body.CallSid;
    if (!callSid || !TWILIO_CALL_SID_RE.test(callSid)) {
      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    const db = getDb();
    await db
      .update(schema.calls)
      .set({
        inboundTranscript: body.TranscriptionText ?? null,
        transcriptUrl: body.TranscriptionUrl ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.calls.id, q.callDbId), eq(schema.calls.providerCallId, callSid)));
    return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  // Dial-result callback — fires after a forwarded call (matched + VIP route).
  app.post('/telephony/twilio/inbound/dial-result', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/dial-result`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) return reply.code(403).send('bad sig');

    const body = req.body as Record<string, string>;
    const q = req.query as { callDbId?: string };
    if (q.callDbId && UUID_RE.test(q.callDbId)) {
      const callSid = body.CallSid;
      if (callSid && TWILIO_CALL_SID_RE.test(callSid)) {
        const db = getDb();
        await db
          .update(schema.calls)
          .set({
            status: body.DialCallStatus === 'completed' ? 'completed'
              : body.DialCallStatus === 'no-answer' ? 'no_answer'
              : body.DialCallStatus === 'busy' ? 'busy'
              : 'failed',
            durationSeconds: body.DialCallDuration ? Number(body.DialCallDuration) : undefined,
            endedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(schema.calls.id, q.callDbId), eq(schema.calls.providerCallId, callSid)));
      }
    }
    // No further TwiML — hang up
    return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });
}
