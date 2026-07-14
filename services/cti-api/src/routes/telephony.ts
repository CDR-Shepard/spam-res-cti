/**
 * Telephony routes:
 *   POST /telephony/token              → mint provider client token (auth required)
 *   POST /telephony/twilio/voice       → TwiML for outbound dial (called by Twilio)
 *   POST /telephony/twilio/status      → status callback receiver (called by Twilio)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import twilio from 'twilio';
import { resolveSession } from '../auth/session.js';
import { getProvider } from '../telephony/index.js';
import { getDb, schema } from '../db/index.js';
import { loadConfig } from '../config.js';
import { sha256 } from '../crypto.js';
import { dispatchAlert } from '../alerts.js';
import { pushRecordingLinkToTask } from '../salesforce/sync.js';
import {
  UUID_RE,
  TWILIO_CALL_SID_RE,
  TWILIO_RECORDING_MEDIA_RE,
  signedCallbackUrl,
} from '../telephony/webhooks.js';
import { bridgeTwiml, dialerConferenceTwiml } from '../dialer/twilio-telephony.js';


export async function registerTelephonyRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();

  app.post('/telephony/token', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const provider = getProvider();
    try {
      const token = await provider.createClientToken({
        userId: session.userId,
        identity: `rep_${session.userId.replace(/-/g, '')}`,
      });
      return token;
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  /**
   * TwiML endpoint Twilio fetches when the JS SDK calls device.connect({ To: '+1...' }).
   * The SDK's parameters arrive as POST fields. We answer with <Dial><Number>...</Number></Dial>.
   *
   * Signature-validated against TWILIO_AUTH_TOKEN.
   */
  app.post('/telephony/twilio/voice', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/voice`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) {
      // Always enforce the signature when an auth token is configured. The only
      // escape hatch is an explicit, deploy-impossible env flag — never NODE_ENV,
      // which left staging open to unauthenticated dialing.
      return reply.code(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    const body = req.body as Record<string, string>;

    // Power-dialer conference join (Plan 3/4): the rep's softphone calls
    // device.connect({ params: { DialerConference: '1' } }) to join its own
    // dialer conference so it can hear/talk to a call the engine has already
    // bridged there via TwilioDialerTelephony#bridgeToRep. This is additive —
    // it never touches the outbound-dial path below — and the conference is
    // derived from Twilio's own signed `From: client:rep_<userId>` identity,
    // not from anything the client supplies, so a rep can only join their own
    // conference.
    if (body.DialerConference) {
      const twiml = dialerConferenceTwiml(body.From ?? '');
      if (!twiml) {
        const VoiceResponse = twilio.twiml.VoiceResponse;
        const response = new VoiceResponse();
        response.say('Unable to identify rep for the dialer conference.');
        return reply.type('text/xml').send(response.toString());
      }
      return reply.type('text/xml').send(twiml);
    }

    const callId = body.CallId ?? '';
    const statusUrl = `${cfg.API_PUBLIC_URL}/telephony/twilio/status`;
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    const db = getDb();

    // Bind the dial to a firewall-approved call row. The renderer passes our
    // own call id (from POST /calls) as the CallId custom parameter; without a
    // valid, non-blocked, recent call here the line is rejected. This is what
    // stops a raw device.connect from dialing a number the firewall blocked or
    // a caller ID the firewall never gated — /voice is no longer a bypass.
    const call = callId
      ? await db.query.calls.findFirst({ where: eq(schema.calls.id, callId) })
      : null;
    if (!call) {
      twiml.say('This call was not authorized. Please dial from the application.');
      return reply.type('text/xml').send(twiml.toString());
    }
    const audit = call.preCallAuditId
      ? await db.query.preCallAudits.findFirst({ where: eq(schema.preCallAudits.id, call.preCallAuditId) })
      : null;
    if (!audit || audit.decision === 'BLOCK') {
      twiml.say('This call was blocked by the caller reputation firewall.');
      return reply.type('text/xml').send(twiml.toString());
    }
    if (Date.now() - call.createdAt.getTime() > 5 * 60 * 1000) {
      twiml.say('This call request has expired. Please try again.');
      return reply.type('text/xml').send(twiml.toString());
    }

    // Claim the call atomically: only the FIRST /voice for a still-queued call
    // proceeds. A Twilio retry or a replay within the 5-min window would
    // otherwise bridge a second outbound leg that the warmup counter (already
    // incremented once at POST /calls) never accounted for. Also persists the
    // parent CallSid so status callbacks correlate even if the renderer's PATCH
    // races or never lands.
    const claim = await db
      .update(schema.calls)
      .set({
        status: 'initiating',
        providerCallId: body.CallSid ?? call.providerCallId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.calls.id, call.id), eq(schema.calls.status, 'queued')))
      .returning({ id: schema.calls.id });
    if (claim.length === 0) {
      twiml.say('This call has already been placed.');
      return reply.type('text/xml').send(twiml.toString());
    }

    // Re-check the DID is still healthy at DIAL time. The firewall ran up to a
    // few minutes ago; an analytics-block webhook or the reputation worker may
    // have degraded the number since. Don't dial a number that just got paused.
    const did = await db.query.outboundNumbers.findFirst({
      where: and(
        eq(schema.outboundNumbers.orgId, call.orgId),
        eq(schema.outboundNumbers.e164, call.fromNumber),
      ),
    });
    if (!did || !did.active || did.health === 'spam_likely' || did.health === 'degraded') {
      twiml.say('The outbound number for this call is no longer available. Please try again.');
      return reply.type('text/xml').send(twiml.toString());
    }

    // Everything we dial comes from the audited call row — never client input.
    const callerId = call.fromNumber;
    const dest = call.normalizedToNumber;

    // Recording is on, but the automated recipient disclosure is OPT-IN per
    // campaign (recordingConsentMode='two_party'), NOT forced by recording. A
    // pre-bridge <Number url> disclosure plays to the callee before they're
    // connected, which adds a multi-second dead-air delay and clips the start of
    // the recording (esp. voicemails). For manual rep-initiated dialing the rep
    // gives the verbal disclosure instead; enable two_party only where an
    // automated announcement is specifically required.
    const recordCalls = cfg.TWILIO_RECORD_CALLS;
    const campaignKey = call.campaignKey ?? 'default';
    const campaign = await db.query.campaignConfigs.findFirst({
      where: and(
        eq(schema.campaignConfigs.orgId, call.orgId),
        eq(schema.campaignConfigs.key, campaignKey),
      ),
    });
    const needsDisclosure = campaign?.recordingConsentMode === 'two_party';

    const dial = twiml.dial({
      callerId,
      answerOnBridge: true,
      action: statusUrl,
      // Dual-channel = rep and prospect on separate tracks (clean for QA). The
      // recording is of the connected conversation only (record-from-answer).
      ...(recordCalls
        ? {
            record: 'record-from-answer-dual',
            recordingStatusCallback: `${cfg.API_PUBLIC_URL}/telephony/twilio/recording?callDbId=${call.id}`,
            recordingStatusCallbackEvent: ['completed'],
            recordingStatusCallbackMethod: 'POST',
          }
        : {}),
    } as never);
    // Put the disclosure on the dialed (recipient) leg via the <Number url>,
    // which runs before bridging so the RECIPIENT — not the rep — hears it, as
    // all-party-consent states require. A child-leg statusCallback gives us the
    // terminating leg's SipResponseCode / StirVerstat / duration reliably.
    dial.number(
      {
        statusCallback: statusUrl,
        statusCallbackEvent: ['completed'],
        ...(needsDisclosure
          ? { url: `${cfg.API_PUBLIC_URL}/telephony/twilio/disclosure?callDbId=${call.id}` }
          : {}),
      } as never,
      dest,
    );
    // recordingDisclosurePlayed is set by the /disclosure handler — Twilio only
    // fetches it once the callee ANSWERS, so the flag is a real audit signal, not
    // an optimistic guess on calls that never connect (and never record).
    return reply.type('text/xml').send(twiml.toString());
  });

  /**
   * Recipient-side recording disclosure, referenced from the <Number url> of an
   * outbound dial in two-party-consent campaigns. Runs on the called party's
   * leg before the call bridges, so the recipient hears the disclosure.
   */
  app.post('/telephony/twilio/disclosure', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = signedCallbackUrl(cfg.API_PUBLIC_URL, req);
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) {
      return reply.code(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    // Twilio requests this ONLY once the callee answers (it runs on the recipient
    // leg before bridging), so it's the accurate all-party-consent audit point.
    const q = req.query as { callDbId?: string };
    if (q.callDbId && UUID_RE.test(q.callDbId)) {
      await getDb()
        .update(schema.calls)
        .set({ recordingDisclosurePlayed: true, updatedAt: new Date() })
        .where(eq(schema.calls.id, q.callDbId));
    }
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.say(
      { voice: 'Polly.Joanna' as never },
      'This call may be recorded for quality and training purposes.',
    );
    return reply.type('text/xml').send(twiml.toString());
  });

  /**
   * Recording-completed callback for outbound + inbound-answered calls. Twilio
   * POSTs when the dual-channel recording finishes. We store the media URL and
   * attach the PUBLIC playback link (GET /recordings/:id) to the Salesforce Task.
   * The call is keyed by our own UUID passed in the callback URL; the request is
   * signature-validated, so that id is trustworthy.
   */
  app.post('/telephony/twilio/recording', async (req, reply) => {
    const empty = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    // Twilio signs the full callback URL INCLUDING the ?callDbId= query string —
    // validate against the live request URL, not a stripped path.
    const url = signedCallbackUrl(cfg.API_PUBLIC_URL, req);
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) return reply.code(403).send('Invalid signature');

    const body = req.body as Record<string, string>;
    const q = req.query as { callDbId?: string };
    if (!q.callDbId || !UUID_RE.test(q.callDbId)) return reply.type('text/xml').send(empty);
    const callSid = body.CallSid;
    if (!callSid || !TWILIO_CALL_SID_RE.test(callSid)) return reply.type('text/xml').send(empty);
    if (body.RecordingStatus && body.RecordingStatus !== 'completed') {
      return reply.type('text/xml').send(empty);
    }
    const recordingUrl =
      body.RecordingUrl && TWILIO_RECORDING_MEDIA_RE.test(body.RecordingUrl)
        ? `${body.RecordingUrl}.mp3`
        : null;
    if (!recordingUrl) return reply.type('text/xml').send(empty);

    const db = getDb();
    // Only set the recording URL — never touch status/duration (the status
    // callback owns those). Cross-check the Twilio CallSid against the row's
    // providerCallId as defence in depth: callDbId is NOT secret (it's embedded
    // in the public recording link we write to Salesforce), so a harvested id
    // must not be enough to repoint a call at an attacker-chosen recording.
    const updated = await db
      .update(schema.calls)
      .set({ recordingUrl, updatedAt: new Date() })
      .where(and(eq(schema.calls.id, q.callDbId), eq(schema.calls.providerCallId, callSid)))
      .returning({ id: schema.calls.id });
    if (updated.length === 0) {
      req.log.warn({ callDbId: q.callDbId }, 'recording_callsid_mismatch');
      return reply.type('text/xml').send(empty);
    }
    try {
      const result = await pushRecordingLinkToTask(q.callDbId);
      req.log.info({ callDbId: q.callDbId, result }, 'recording_attached');
    } catch (err) {
      req.log.warn({ err: (err as Error).message, callDbId: q.callDbId }, 'recording_sf_attach_failed');
    }
    return reply.type('text/xml').send(empty);
  });

  /**
   * Status callback receiver. Twilio POSTs as it transitions
   * queued/initiated/ringing/in-progress/completed/...
   */
  app.post('/telephony/twilio/status', async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/status`;
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    const body = req.body as Record<string, string>;

    // Validate the signature BEFORE persisting anything. The webhook body
    // carries PII (phone numbers, transcripts); an unsigned request must not be
    // able to write it to our DB or flood the events table. Always enforced
    // unless the explicit local-dev skip flag is set.
    if (!valid.valid && !cfg.TWILIO_SKIP_SIGNATURE_CHECK) {
      return reply.code(403).send('Invalid signature');
    }

    const externalId = `${body.CallSid ?? sha256(rawBody)}:${body.CallStatus ?? body.DialCallStatus ?? 'unknown'}`;

    const db = getDb();
    try {
      await db.insert(schema.providerWebhookEvents).values({
        provider: provider.name,
        externalId,
        signatureValid: valid.valid,
        headers: sanitizeHeaders(req.headers),
        body,
      });
    } catch (err) {
      // Already processed — idempotent ack.
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    const event = provider.normalizeWebhook(body);
    if (event) {
      // Correlate by the parent CallSid (what we persisted) OR ParentCallSid —
      // child-leg status callbacks (which carry the terminating leg's
      // SipResponseCode / StirVerstat / duration) arrive under the child sid
      // with the parent in ParentCallSid.
      const sids = [body.CallSid, body.ParentCallSid].filter((s): s is string => !!s);
      const call = sids.length
        ? await db.query.calls.findFirst({
            where: and(
              eq(schema.calls.provider, provider.name),
              sids.length === 1
                ? eq(schema.calls.providerCallId, sids[0]!)
                : or(...sids.map((s) => eq(schema.calls.providerCallId, s))),
            ),
          })
        : null;
      if (call) {
        const updates: Partial<typeof schema.calls.$inferInsert> = { updatedAt: new Date() };
        updates.status = event.status;
        if (event.durationSeconds != null) updates.durationSeconds = event.durationSeconds;
        if (event.recordingUrl) updates.recordingUrl = event.recordingUrl;
        if (event.startedAt) updates.startedAt = event.startedAt;
        if (event.answeredAt) updates.answeredAt = event.answeredAt;
        // STIR/SHAKEN attestation — Twilio sets StirVerstat="TN-Validation-Passed-A"
        // (or -B / -C / Failed-*). Pull the attestation letter for visibility.
        const verstat = body.StirVerstat;
        if (typeof verstat === 'string' && verstat.length > 0) {
          updates.shakenVerstat = verstat;
          const m = /Passed-([ABC])/i.exec(verstat) ?? /-([ABC])$/i.exec(verstat);
          if (m) updates.shakenAttestation = m[1]!.toUpperCase();
        }
        // Carrier analytics-BLOCK detection (FCC 8th Order, eff. Mar 25, 2026).
        // Be precise: a plain SIP 603 "Decline" is what a normal human reject
        // looks like, so degrading on `sip >= 603` mislabels healthy DIDs every
        // time someone declines. Only the call-blocking-specific signals count:
        //   - SIP 608 "Rejected" (RFC 8688) — the code carriers/analytics use
        //     to transparently signal an intermediary block.
        //   - Twilio's known spam/blocked error codes.
        //   - An explicit "blocked"/"spam" reason on a failed dial.
        // SIP 607 "Unwanted" (callee marked unwanted) is a softer signal — we
        // record it as a block reason but it also degrades, since repeated 607s
        // are exactly the recipient sentiment that drives labeling.
        const sipCode = Number(body.SipResponseCode ?? '0');
        const errorCode = body.ErrorCode ?? '';
        const dialStatus = body.DialCallStatus ?? '';
        const reason = body.Reason ?? '';
        const knownBlockErrorCodes = new Set(['30007', '30032', '32017']);
        const looksAnalyticsBlocked =
          sipCode === 608 ||
          sipCode === 607 ||
          knownBlockErrorCodes.has(errorCode) ||
          (dialStatus === 'failed' && /blocked|spam|labeled/i.test(reason));
        if (looksAnalyticsBlocked) {
          updates.analyticsBlocked = true;
          updates.analyticsBlockReason = `SIP ${sipCode || '?'} · err=${errorCode || '?'} · ${reason || dialStatus}`;
          // Degrade the DID's health immediately so rotation stops picking it
          // and the firewall blocks it. Scoped to the call's org (DIDs are keyed
          // on (orgId, e164), so an e164-only update could hit another tenant).
          if (call.fromNumber) {
            await db
              .update(schema.outboundNumbers)
              .set({ health: 'degraded', healthSource: 'analytics_block', healthUpdatedAt: new Date() })
              .where(
                and(
                  eq(schema.outboundNumbers.orgId, call.orgId),
                  eq(schema.outboundNumbers.e164, call.fromNumber),
                ),
              );
            await dispatchAlert(app.log, {
              kind: 'analytics_block_detected',
              severity: 'critical',
              orgId: call.orgId,
              message: `Carrier analytics-block on ${call.fromNumber} — DID degraded and removed from rotation`,
              context: { e164: call.fromNumber, sip: sipCode, errorCode, reason },
            });
          }
        }
        // Set baseline attestation on the first attested call for this DID.
        if (updates.shakenAttestation && call.fromNumber) {
          const outNum = await db.query.outboundNumbers.findFirst({
            where: and(
              eq(schema.outboundNumbers.orgId, call.orgId),
              eq(schema.outboundNumbers.e164, call.fromNumber),
            ),
          });
          if (outNum && !outNum.baselineAttestation) {
            await db
              .update(schema.outboundNumbers)
              .set({
                baselineAttestation: updates.shakenAttestation,
                baselineAttestationSetAt: new Date(),
              })
              .where(eq(schema.outboundNumbers.id, outNum.id));
          }
        }
        if (event.endedAt || event.status === 'completed' || event.status === 'failed' || event.status === 'no_answer' || event.status === 'busy' || event.status === 'canceled') {
          updates.endedAt = event.endedAt ?? new Date();
        }
        await db.update(schema.calls).set(updates).where(eq(schema.calls.id, call.id));
        await db.insert(schema.callEvents).values({
          callId: call.id,
          eventType: 'status',
          rawStatus: event.rawStatus,
          payload: body,
        });
      }
    }

    await db
      .update(schema.providerWebhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.providerWebhookEvents.externalId, externalId));

    return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
}

function sanitizeHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase().includes('cookie')) continue;
    if (k.toLowerCase() === 'authorization') continue;
    out[k] = v;
  }
  return out;
}
