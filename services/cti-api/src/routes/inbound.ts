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
import { enqueueSyncForCall } from '../salesforce/sync.js';
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

/**
 * Twilio Client identity for a rep's softphone. MUST match the identity minted
 * in the Voice access token (routes/telephony.ts): `rep_<userId without dashes>`.
 */
function clientIdentity(userId: string): string {
  return `rep_${userId.replace(/-/g, '')}`;
}

/** Append the greeting + voicemail-record TwiML (shared by the direct-voicemail
 *  path and the ring-the-rep no-answer fallback). */
function appendVoicemail(
  t: InstanceType<typeof twilio.twiml.VoiceResponse>,
  cfg: ReturnType<typeof loadConfig>,
  owned: typeof schema.outboundNumbers.$inferSelect,
  callDbId: string,
  greeting: string,
): void {
  t.say({ voice: 'Polly.Joanna' as never }, greeting);
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
    // NOTE: no `action` — the recording is persisted out-of-band via
    // recordingStatusCallback. An `action` URL would (a) fire the recording
    // handler a second time and (b) discard the Say/Hangup below (Twilio drops
    // any verbs after <Record> once it hands control to the action URL).
  });
  t.say({ voice: 'Polly.Joanna' as never }, 'Thanks, your message has been received. Goodbye.');
  t.hangup();
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

    // Attribute the inbound call to the DID's owner, or — for an unassigned
    // reserve number — any user in the org. NEVER a synthetic UUID: that
    // violates the users FK and 500s the webhook, which Twilio plays to the
    // caller as "an application error has occurred".
    const handlerUserId =
      owned.assignedUserId ??
      (await db.query.users.findFirst({
        where: eq(schema.users.orgId, owned.orgId),
        columns: { id: true },
      }))?.id ??
      null;
    if (!handlerUserId) {
      const t = new twilio.twiml.VoiceResponse();
      t.say({ voice: 'Polly.Joanna' as never }, 'Thanks for calling. Please try again later.');
      t.hangup();
      return reply.type('text/xml').send(t.toString());
    }

    // Match the caller in Salesforce using the handler's OWN org-scoped SF
    // connection (never a global cross-org lookup).
    let matched: { whoId?: string; whatId?: string; name?: string } | null = null;
    const sfConn = await db.query.salesforceConnections.findFirst({
      where: eq(schema.salesforceConnections.userId, handlerUserId),
    });
    if (sfConn) {
      try {
        const m = await findByPhone(sfConn.userId, normFrom);
        // Accept any match — findByPhone can return a Deal__c hit with only a
        // whatId (no whoId), which we must not drop.
        if (m && (m.whoId || m.whatId)) matched = { whoId: m.whoId, whatId: m.whatId, name: m.name };
      } catch (err) {
        app.log.warn({ err }, 'inbound_sf_lookup_failed');
      }
    }

    // Insert the inbound call record so we can update with recording / transcript later.
    const [callRow] = await db
      .insert(schema.calls)
      .values({
        orgId: owned.orgId,
        userId: handlerUserId,
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

    const t = new twilio.twiml.VoiceResponse();

    // Ring the assigned rep's softphone (the CTI) so they can answer the callback
    // in the app. If they don't pick up or are offline, the dial-result handler
    // falls back to voicemail. Unassigned reserve numbers go straight to voicemail.
    if (owned.assignedUserId) {
      const dial = t.dial({
        // Show the CALLER's number on the rep's softphone, not the DID, so the
        // rep sees who's calling back.
        callerId: normFrom || fromRaw || undefined,
        timeout: 25,
        answerOnBridge: true,
        action: `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/dial-result?callDbId=${encodeURIComponent(callDbId)}`,
        method: 'POST',
      });
      dial.client({}, clientIdentity(owned.assignedUserId));
    } else {
      const greeting =
        (matched ? owned.inboundMatchedGreeting : owned.inboundGreeting) ??
        defaultGreeting(!!matched, matched?.name ?? null);
      appendVoicemail(t, cfg, owned, callDbId, greeting);
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
    // Log this inbound call to Salesforce as a Task on the matched record
    // (idempotent — the sync job is keyed by callId).
    await enqueueSyncForCall(q.callDbId);
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

  // Dial-result callback — fires after we ring the rep's softphone. If the rep
  // answered, mark the inbound call completed and log it. If they didn't answer
  // (offline / no pickup), fall back to voicemail on the same call.
  app.post('/telephony/twilio/inbound/dial-result', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound/dial-result`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) return reply.code(403).send('bad sig');

    const body = req.body as Record<string, string>;
    const q = req.query as { callDbId?: string };
    const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    if (!q.callDbId || !UUID_RE.test(q.callDbId)) {
      return reply.type('text/xml').send(hangup);
    }
    const db = getDb();
    const answered = (body.DialCallStatus ?? '') === 'completed';

    if (answered) {
      await db
        .update(schema.calls)
        .set({
          status: 'completed',
          durationSeconds: body.DialCallDuration ? Number(body.DialCallDuration) : undefined,
          endedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.calls.id, q.callDbId));
      // Log the answered inbound call to Salesforce as a Task.
      await enqueueSyncForCall(q.callDbId);
      return reply.type('text/xml').send(hangup);
    }

    // Rep didn't answer / is offline → voicemail fallback on the same call.
    const call = await db.query.calls.findFirst({ where: eq(schema.calls.id, q.callDbId) });
    const owned = call
      ? await db.query.outboundNumbers.findFirst({
          where: eq(schema.outboundNumbers.e164, call.normalizedToNumber),
        })
      : null;
    if (owned) {
      const t = new twilio.twiml.VoiceResponse();
      appendVoicemail(t, cfg, owned, q.callDbId, owned.inboundGreeting ?? defaultGreeting(false, null));
      return reply.type('text/xml').send(t.toString());
    }
    return reply.type('text/xml').send(hangup);
  });
}
