# Voicemail in Sam's Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Sam's call reaches voicemail, the seller's message (first name, street, callback number) plays in
Sam's ElevenLabs voice (Siren) instead of Twilio's stock Polly voice, and falls back to today's Polly message whenever
the Siren audio is not ready.

**Architecture:** As soon as Twilio accepts an outbound AI call, cti-api renders that call's voicemail text through
ElevenLabs' one-shot text-to-speech HTTP endpoint (16 kHz PCM). It converts the audio to clean phone audio
(phone-audio.ts: 3.4 kHz low-pass, 8 kHz μ-law, in a WAV file) and holds it in memory behind a random 256-bit URL
token. When answering-machine detection reports the beep, the AMD webhook redirects the call to
`<Pause/><Play>that URL</Play><Hangup/>` if the audio for exactly this text is ready (waiting up to 1.5 s for a render
still running). Otherwise it sends today's `<Pause/><Say Polly.Joanna-Neural>` TwiML. Twilio fetches the WAV from a
public GET route that answers 404 for any unknown or expired token.

**Tech Stack:** TypeScript (Node, ESM), Fastify 4, vitest, Twilio TwiML (`twilio.twiml.VoiceResponse`), ElevenLabs
REST, global `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-19-sam-booking-channels-routing-design.md` on branch
`origin/feat/sam-booking-channels-routing`, Part C, "Voicemail in Sam's voice" (build step 2). Read with
`git show origin/feat/sam-booking-channels-routing:docs/superpowers/specs/2026-10-19-sam-booking-channels-routing-design.md`.

## Facts this plan rests on (checked 2026-10-19)

- **Endpoint:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_16000` serves
  `eleven_v4_turbo`.
  - The models page lists v4 Turbo only on the text-to-dialogue WebSocket, so it was tested directly: 200 `audio/pcm`.
  - A bogus `model_id` gets 400 `model_not_found`, so the model is validated, not silently replaced.
  - ElevenLabs' history records `eleven_v4_turbo` for each request.
  - `/v1/text-to-dialogue` also works, but the text-to-speech endpoint also takes the v2 models
    `AI_VOICE_ELEVENLABS_MODEL` could be set back to, so one code path covers every model.
- **Timing:** the default voicemail with made-up details is 186 characters and renders to 14.5 s of audio in
  3.1–3.5 s. Rendering after the beep would leave 3 s of dead air, so rendering starts while the phone rings.
- **Cost:** v4 Turbo bills about half a credit per character (a 96-character probe cost 48 credits), so about 95
  credits per call. The plan is Creator, 300,000 credits a month, about 8,000 used. Sam has made only test calls so
  far (16 in 30 days, 5 reached a machine).
- **Production:** `AI_VOICE_TTS=elevenlabs` with `ELEVENLABS_API_KEY` set; voice and model are the defaults (Siren
  `eXpIbVcVbLo8ZJQDlDnl`, `eleven_v4_turbo`).
- **Twilio `<Play>`:**
  - It accepts `audio/wav` and recommends lossless 8 kHz audio, which μ-law WAV is.
  - It caches media whenever the headers allow, so the route sends `Cache-Control: no-store`.
  - It sends no standard parameters (and no documented signature) when fetching, so the token in the URL is the
    only access control.

## Global Constraints

- Voice `cfg.AI_VOICE_ELEVENLABS_VOICE` (default Siren `eXpIbVcVbLo8ZJQDlDnl`), model `cfg.AI_VOICE_ELEVENLABS_MODEL`
  (default `eleven_v4_turbo`), `voice_settings: { stability: 0.5 }`, the live voice's setting (elevenlabs-dialogue.ts).
- The words are exactly `voicemailText(...)`, the editable template, unchanged. It keeps the AI-assistant wording,
  the first name, the street and the TCPA callback number. The only change for the voice is that phone numbers
  written `619-555-0142` are sent as `six one nine, five five five, zero one four two`, the way the live agent says
  them (`callback_number_spoken`). The `<Say>` fallback gets the text unchanged.
- Audio Twilio plays is phone-band only: `phone-audio.ts` low-pass at 3.4 kHz, 8 kHz G.711 μ-law (owner lesson
  2026-10-19).
- Fallback is today's `voicemailTwiml(text)`, byte for byte.
- Logs never contain the voicemail text, a first name, a street, the audio token or URL, or the API key; errors carry
  HTTP status and ElevenLabs' `detail.status` code only.
- Seller audio lives in memory only: never on disk, never in the database, gone after the call's registry lifetime
  (`(AI_VOICE_MAX_CALL_SECONDS + REGISTRY_MARGIN_SECONDS) * 1000` = 990 s by default).
- No migration. Nothing to set in Railway to ship: the new switch defaults on.
- Commits: `<type>(ai-voice): <description>`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  stage explicit paths only.
- Sam is a woman (she/her) and never claims to be a person (the template already says "an AI assistant").

## Decisions for the owner to check (my calls)

1. **Render while ringing, for every outbound call that has answering-machine detection** (as the design says). A
   call nobody answers still costs its ~95 credits. The cheaper option is to start when the call is answered:
   - It skips unanswered calls.
   - Answering machines play a greeting first, so the audio is usually still ready by the beep; when it isn't, the
     seller hears the Polly voice.
   - It is a one-line move (Task 3) if you prefer it.
2. **Wait at the beep:** up to 1.5 s for a render still running, then the Polly voice.
3. **Switch:** `AI_VOICE_VOICEMAIL_TTS` = `elevenlabs` (default) | `say`.
   - It is independent of `AI_VOICE_TTS` and needs only `ELEVENLABS_API_KEY`.
   - `say` brings back today's voicemail without touching the live voice.
   - If ElevenLabs credits run out, each voicemail falls back to the Polly voice by itself (logged as a warning).
4. **The audio URL** carries a random 256-bit token, not the call id. It works while the call can still be live
   (990 s), and at most 200 calls' audio is held at once (the oldest is dropped first).

## File map

| File | Change | Responsibility |
|---|---|---|
| `services/cti-api/src/config.ts` | modify | `AI_VOICE_VOICEMAIL_TTS` switch |
| `services/cti-api/src/ai-voice/phone-audio.ts` | modify | whole-clip 16 kHz PCM → phone μ-law; μ-law WAV container |
| `services/cti-api/src/ai-voice/elevenlabs-voicemail.ts` | create | one ElevenLabs HTTP render → phone WAV; numbers said digit by digit; config → renderer |
| `services/cti-api/src/ai-voice/voicemail-audio.ts` | create | per-call audio held in memory behind a token; the public GET route |
| `services/cti-api/src/ai-voice/twilio.ts` | modify | `VOICEMAIL_AUDIO_PATH`, `voicemailPlayTwiml(url)` |
| `services/cti-api/src/ai-voice/service.ts` | modify | start the render once Twilio accepts the call |
| `services/cti-api/src/ai-voice/routes-webhooks.ts` | modify | AMD: `<Play>` when ready, else `<Say>` |
| `services/cti-api/src/ai-voice/routes.ts` | modify | build one `VoicemailAudio`, hand it to start + webhooks, register the route |

## Review Focus

1. **ElevenLabs is slow or down when the beep comes.** The seller's voicemail must start within ~1.5 s in the Polly
   voice, never wait on Siren and never be silent (Task 2 test `pending past the wait → null`; Task 3 test
   `render fails → <Say>`).
2. **ElevenLabs answers 200 with no audio.** A JSON body, an empty body or a clip under half a second is a failure
   (Polly fallback), never a silent `<Play>` (Task 1 tests).
3. **Someone requests a guessed, malformed or expired audio URL.** The answer is the same 404 every time and reveals
   nothing about which calls exist (Task 2 route tests).
4. **Seller details in logs.** Across render, failure, fallback and serving, nothing logged contains the text, the
   first name or the token (Task 2 test `logs carry no text or token`).
5. **Renders that can never play cost credits.** These are a browser practice call (no AMD), a call Twilio refused,
   and a call the gate blocked; none may render (Task 3 service tests).

---

### Task 1: Render a voicemail in Siren as phone audio

**Files:**
- Modify: `services/cti-api/src/config.ts` (next to `AI_VOICE_ELEVENLABS_MODEL`)
- Modify: `services/cti-api/src/ai-voice/phone-audio.ts`
- Create: `services/cti-api/src/ai-voice/elevenlabs-voicemail.ts`
- Test: `services/cti-api/src/ai-voice/phone-audio.test.ts`, `services/cti-api/src/ai-voice/elevenlabs-voicemail.test.ts`

**Interfaces:**
- Consumes: `phoneDownsampler()`, `muLaw()` (phone-audio.ts); `ElevenLabsSettings` (elevenlabs-socket.ts);
  `phoneForms(e164)` (prompt-context.ts); `BridgeLog`.
- Produces:
  - `phoneAudio(pcm16le: Buffer): Buffer`: a whole 16 kHz clip → 8 kHz μ-law (one `phoneDownsampler`).
  - `muLawWav(ulaw: Buffer): Buffer`: the μ-law WAV file.
  - `type RenderVoicemail = (text: string) => Promise<Buffer>`: resolves to a μ-law WAV, rejects on any failure.
  - `spokenPhoneNumbers(text: string): string`
  - `renderElevenLabsVoicemail(s: ElevenLabsSettings, fetchImpl?: typeof fetch): RenderVoicemail`
  - `voicemailVoiceFor(cfg: Pick<AppConfig, 'AI_VOICE_VOICEMAIL_TTS' | 'ELEVENLABS_API_KEY' | 'AI_VOICE_ELEVENLABS_VOICE' | 'AI_VOICE_ELEVENLABS_MODEL'>, log: BridgeLog, fetchImpl?: typeof fetch): RenderVoicemail | null`
  - Constants: `ELEVENLABS_HTTP = 'https://api.elevenlabs.io/v1'`, `VOICEMAIL_RENDER_TIMEOUT_MS = 15_000`,
    `MIN_VOICEMAIL_PCM_BYTES = 16_000` (half a second of 16 kHz PCM).

- [ ] **Step 1: Write the failing tests**

`phone-audio.test.ts` (add):
```ts
describe('muLawWav', () => {
  it('wraps μ-law in a WAV Twilio plays: format 7, mono, 8 kHz, 8-bit, fact + data chunks', () => {
    const wav = muLawWav(Buffer.from([1, 2, 3, 4]));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect([wav.readUInt32LE(16), wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34), wav.readUInt16LE(36)])
      .toEqual([18, 7, 1, 8000, 8000, 1, 8, 0]);
    expect(wav.toString('ascii', 38, 42)).toBe('fact');
    expect([wav.readUInt32LE(42), wav.readUInt32LE(46)]).toEqual([4, 4]);
    expect(wav.toString('ascii', 50, 54)).toBe('data');
    expect(wav.readUInt32LE(54)).toBe(4);
    expect([...wav.subarray(58)]).toEqual([1, 2, 3, 4]);
  });
  it('pads an odd data chunk to an even length (RIFF word alignment), counted in RIFF size but not the data size', () => {
    const wav = muLawWav(Buffer.from([9, 9, 9]));
    expect(wav.readUInt32LE(54)).toBe(3);
    expect(wav.length).toBe(58 + 4);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });
});
describe('phoneAudio', () => {
  it('turns a whole 16 kHz clip into half as many μ-law bytes; silence stays μ-law silence', () => {
    const out = phoneAudio(Buffer.alloc(32_000)); // 1 s of 16 kHz silence
    expect(out.length).toBe(8_000);
    expect(out.every((b) => b === muLaw(0))).toBe(true);
  });
});
```

`elevenlabs-voicemail.test.ts` (new; fake `fetch` returns `new Response(body, { status, headers })` and records
`url` + `init`):
- `it('asks ElevenLabs text-to-speech for 16 kHz PCM in Siren on v4 Turbo, with numbers said digit by digit')`:
  for `'Hi Jane. You can reach us at 619-555-0142.'` the URL is
  `https://api.elevenlabs.io/v1/text-to-speech/eXpIbVcVbLo8ZJQDlDnl?output_format=pcm_16000`, method `POST`,
  headers `xi-api-key: 'k-test'` and `content-type: application/json`, and the JSON body equals
  `{ text: 'Hi Jane. You can reach us at six one nine, five five five, zero one four two.', model_id: 'eleven_v4_turbo', voice_settings: { stability: 0.5 } }`;
  `init.signal` is an `AbortSignal`.
- `it('resolves to a phone WAV: 1 s of PCM → 8,000 μ-law bytes after the 58-byte header')`: 200,
  `audio/pcm`, 32,000 bytes → result length 8,058, `'RIFF'`, format tag 7.
- `it.each([[401, 'application/json', '{"detail":{"status":"quota_exceeded","message":"x"}}', /401 quota_exceeded/], [200, 'application/json', '{}', /not audio/], [200, 'audio/pcm', '', /too short/], [200, 'audio/pcm', Buffer.alloc(15_998), /too short/]])('rejects %s %s (%#)')`:
  the promise rejects matching the regex, and `String(err)` does not contain `'Jane'`.
- `it('rejects when fetch throws (timeout, network) without the text in the error')`.
- `spokenPhoneNumbers`:
  - `'Call 619-555-0142 or 858-555-0199.'` → `'Call six one nine, five five five, zero one four two or eight five eight, five five five, zero one nine nine.'`
  - text without a number → unchanged
  - `'Ref 1619-555-01423'` (part of a longer run) → unchanged
- `voicemailVoiceFor`:
  - `AI_VOICE_VOICEMAIL_TTS: 'say'` → `null`.
  - `'elevenlabs'` without a key → `null`, and `log.warn` called once.
  - `'elevenlabs'` with a key → a function whose call hits the URL above.

- [ ] **Step 2: Run them to see them fail**

Run: `cd services/cti-api && npx vitest run src/ai-voice/phone-audio.test.ts src/ai-voice/elevenlabs-voicemail.test.ts`
Expected: FAIL (`muLawWav` / `phoneAudio` not exported; `elevenlabs-voicemail.js` missing).

- [ ] **Step 3: Implement**

- `config.ts`: `AI_VOICE_VOICEMAIL_TTS: z.enum(['elevenlabs', 'say']).default('elevenlabs')`. Its doc comment says what
  each value does and that `elevenlabs` without `ELEVENLABS_API_KEY` uses `<Say>` with a warning.
- `phone-audio.ts`: `phoneAudio` = `phoneDownsampler().push(pcm)`. `muLawWav` writes the header asserted above:
  - `fmt ` chunk of 18 bytes, `cbSize` 0
  - `fact` chunk holding the sample count
  - `data`, plus a zero pad byte when the length is odd
- `elevenlabs-voicemail.ts`:
  - `spokenPhoneNumbers` replaces `/(?<!\d)(\d{3})-(\d{3})-(\d{4})(?!\d)/g` with `phoneForms('+1' + digits)?.spoken`,
    keeping the match when that is null.
  - `renderElevenLabsVoicemail` sends the request asserted above, with `signal: AbortSignal.timeout(VOICEMAIL_RENDER_TIMEOUT_MS)`.
    It rejects with `Error('ElevenLabs voicemail <status> <detail.status>')` when not ok (read `detail.status` from the
    JSON body if parsable). It also rejects `'ElevenLabs voicemail: not audio (<content-type>)'` and
    `'ElevenLabs voicemail: too short (<bytes> bytes)'`. On success it resolves `muLawWav(phoneAudio(pcm))`.
  - `voicemailVoiceFor` mirrors `externalVoiceFor`'s shape (elevenlabs-tts.ts).

- [ ] **Step 4: Run the tests to see them pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Review, then commit**

Fresh code review of the diff (typescript-reviewer); fix Critical/High. Then:
```bash
git add services/cti-api/src/config.ts services/cti-api/src/ai-voice/phone-audio.ts services/cti-api/src/ai-voice/phone-audio.test.ts services/cti-api/src/ai-voice/elevenlabs-voicemail.ts services/cti-api/src/ai-voice/elevenlabs-voicemail.test.ts
git commit -m "feat(ai-voice): render a voicemail in Siren as phone audio"
```

---

### Task 2: Hold each call's voicemail audio and serve it to Twilio

**Files:**
- Create: `services/cti-api/src/ai-voice/voicemail-audio.ts`
- Modify: `services/cti-api/src/ai-voice/twilio.ts` (path constant only)
- Test: `services/cti-api/src/ai-voice/voicemail-audio.test.ts`

**Interfaces:**
- Consumes: `RenderVoicemail` (Task 1); `AI_VOICE_TWILIO_PREFIX` (twilio.ts); `BridgeLog`.
- Produces:
  - `VOICEMAIL_AUDIO_PATH = \`${AI_VOICE_TWILIO_PREFIX}/voicemail\`` (twilio.ts)
  - `VOICEMAIL_READY_WAIT_MS = 1_500`, `VOICEMAIL_MAX_HELD = 200`
  - ```ts
    export interface VoicemailAudio {
      /** Start rendering this call's voicemail in the background; never throws; a second call for the same id is ignored. */
      prepare(aiCallId: string, text: string): void;
      /** The play URL when audio for exactly `text` is ready, waiting up to `waitMs` for a render still running; else null. */
      playUrl(aiCallId: string, text: string, waitMs?: number): Promise<string | null>;
      /** The WAV behind a token, or null (unknown, expired, not ready, failed). */
      wav(token: string): Buffer | null;
    }
    export function createVoicemailAudio(o: { render: RenderVoicemail; apiPublicUrl: string; ttlMs: number; log: BridgeLog; maxHeld?: number }): VoicemailAudio;
    export function registerVoicemailAudioRoute(app: FastifyInstance, audio: VoicemailAudio): void;
    ```
  - URL shape: `${apiPublicUrl}${VOICEMAIL_AUDIO_PATH}/${token}`, where `token = randomBytes(32).toString('hex')` is
    made at `prepare`.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`; `render` is a `vi.fn` returning deferred promises;
  the log spy collects every call's arguments)

- `it('serves the rendered audio at an unguessable URL once ready')`: `prepare(A, 'Hi Jane')`, resolve with `WAV_A`,
  then `playUrl(A, 'Hi Jane')` matches
  `/^https:\/\/api\.test\/telephony\/twilio\/ai-voice\/voicemail\/[0-9a-f]{64}$/`, the URL contains no `A`, and
  `wav(tokenOf(url))` equals `WAV_A`.
- `it('renders once per call')`: `prepare` twice → `render` called once.
- `it('another text gets no audio (never the wrong words)')`: ready for `'Hi Jane'`; `playUrl(A, 'Hi Bob')` → `null`.
- `it('a render still running at the beep: waits up to the limit, then null')`: pending; `playUrl(A, t, 1_500)`
  advanced 1,500 ms → `null`. Resolving afterwards changes nothing already returned.
- `it('a render that finishes within the wait is used')`: resolve at 400 ms → URL.
- `it('a failed render: null, and a warning with the call id only')`: reject `Error('ElevenLabs voicemail 401 quota_exceeded')`
  → `playUrl` null; `log.warn` called with `{ aiCallId: A, err: 'ElevenLabs voicemail 401 quota_exceeded' }`.
- `it('an unknown call: null at once')`.
- `it('expires after ttlMs')`: ready; advance `ttlMs` → `wav(token)` null and `playUrl` null.
- `it('holds at most maxHeld calls, dropping the oldest')`: `maxHeld: 2`, three calls → the first's token gives null,
  the others still serve.
- `it('two calls never share audio')`: distinct tokens, each serves its own WAV.
- `it('logs carry no text or token')`: run a success, a failure and a fallback; `JSON.stringify(allLogArgs)` contains
  neither `'Jane'` nor any token.
- Route (`Fastify()` + `registerVoicemailAudioRoute`, `app.inject`):
  - A ready token → 200, `content-type` `audio/wav`, `cache-control` `no-store`, body equal to the WAV.
  - `it.each` over an unknown 64-hex token, `'nothex'`, a 63-char token, an expired token, and a pending token: each
    gets 404 with the identical body `'Not found'`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd services/cti-api && npx vitest run src/ai-voice/voicemail-audio.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `voicemail-audio.ts`

- Two `Map`s: `aiCallId → { text, token, state: 'pending' | 'ready' | 'failed', wav?, done: Promise<void> }` and
  `token → aiCallId`. Entries are replaced, never mutated, as in registry.ts.
- Each entry has an unref'd expiry timer of `ttlMs`.
- Over `maxHeld`, drop the oldest (Map insertion order).
- `prepare` catches everything; `render` failures become `state: 'failed'` with a `warn`.
- Success logs `info { aiCallId, ms, bytes } 'ai-voice: voicemail audio ready'`.
- `playUrl` races `done` against a `waitMs` timer, which is cleared afterwards.
- The route validates `/^[0-9a-f]{64}$/` before looking anything up.

- [ ] **Step 4: Run the tests to see them pass**

Run: same command. Expected: PASS.

- [ ] **Step 5: Review, then commit**

Fresh code review (typescript-reviewer + security-reviewer: public route, token, memory bound); fix Critical/High.
```bash
git add services/cti-api/src/ai-voice/voicemail-audio.ts services/cti-api/src/ai-voice/voicemail-audio.test.ts services/cti-api/src/ai-voice/twilio.ts
git commit -m "feat(ai-voice): hold each call's voicemail audio and serve it to Twilio"
```

---

### Task 3: Play it on the call

**Files:**
- Modify: `services/cti-api/src/ai-voice/twilio.ts` (`voicemailPlayTwiml`)
- Modify: `services/cti-api/src/ai-voice/service.ts` (`StartDeps.voicemail`, prepare after placement)
- Modify: `services/cti-api/src/ai-voice/routes-webhooks.ts` (`WebhookDeps.voicemail`, `onAmd`)
- Modify: `services/cti-api/src/ai-voice/routes.ts` (wiring)
- Test: `services/cti-api/src/ai-voice/twilio.test.ts`, `service.test.ts`, `routes.test.ts`

**Interfaces:**
- Consumes: `VoicemailAudio`, `createVoicemailAudio`, `registerVoicemailAudioRoute`, `VOICEMAIL_READY_WAIT_MS`
  (Task 2); `voicemailVoiceFor` (Task 1); `voicemailText`, `logTemplateError`, `localTimeFor`; `REGISTRY_MARGIN_SECONDS`.
- Produces:
  - `voicemailPlayTwiml(audioUrl: string): string`: `<Pause length="1"/><Play>{url}</Play><Hangup/>`.
  - `StartDeps.voicemail?: Pick<VoicemailAudio, 'prepare'> | null`
  - `WebhookDeps.voicemail?: Pick<VoicemailAudio, 'playUrl'> | null`
  - `AiVoiceDeps.voicemail?: VoicemailAudio | null`

- [ ] **Step 1: Write the failing tests**

- `twilio.test.ts`: `voicemailPlayTwiml('https://api.test/telephony/twilio/ai-voice/voicemail/' + 'a'.repeat(64))`
  equals `'<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Play>https://api.test/telephony/twilio/ai-voice/voicemail/aaaa…</Play><Hangup/></Response>'`
  (the full 64 `a`s).
- `service.test.ts` (deps get `voicemail: { prepare: vi.fn() }`):
  - `it('starts the voicemail render once Twilio has the call, with the exact voicemail text')`: a record call →
    `prepare` called once with `(aiCallId, voicemailText({ ...entry.prompt, localTime: 'x' }))`; the record's first
    name is in the text. The call registers before `prepare`, and `prepare` runs after `placeCall`.
  - `it('no render for a browser practice call (it has no answering-machine detection)')`.
  - `it('no render when Twilio refuses the call')` (`twilio.failPlace = true`).
  - `it('no render for a call the gate blocks')`.
  - `it('a prepare that throws does not fail the call')`: `prepare` throws → result `{ ok: true }`.
- `routes.test.ts`, new `describe('AMD voicemail in Sam's voice')`. Build with `voicemail: createVoicemailAudio({ render, apiPublicUrl: API, ttlMs: 60_000, log: silentLog })`;
  `liveCall()`; then `voicemail.prepare(ID, voicemailText({ ...getActiveCall(ID)!.prompt, localTime: 'x' }))`.
  - Ready → the AMD `machine_end_beep` redirect's TwiML contains `<Pause length="1"/><Play>https://api.test/telephony/twilio/ai-voice/voicemail/`
    and no `<Say`; the outcome is `voicemail`; a `GET` of that URL returns 200 `audio/wav` with the WAV.
  - `render` rejects → the TwiML has `<Say voice="Polly.Joanna-Neural">Hi Jane, this is Alex` and outcome `voicemail`.
  - Without a `voicemail` dep (the existing build), the existing voicemail test still passes unchanged.

- [ ] **Step 2: Run them to see them fail**

Run: `cd services/cti-api && npx vitest run src/ai-voice/twilio.test.ts src/ai-voice/service.test.ts src/ai-voice/routes.test.ts`
Expected: FAIL (`voicemailPlayTwiml` missing; `prepare` never called; TwiML still `<Say>`).

- [ ] **Step 3: Implement**

- `twilio.ts`: add `voicemailPlayTwiml` next to `voicemailTwiml`, built with `VoiceResponse`.
- `service.ts`:
  - Lift the registry entry's `prompt` into a `const`.
  - Right after the successful `placeCall` and `updateActiveCall`, when `kind !== 'practice_browser'`, call
    `deps.voicemail?.prepare(aiCallId, voicemailText({ ...prompt, localTime: localTimeFor(gate.toE164, now) }, logTemplateError(deps.log)))`.
  - Wrap that call in `try/catch` and log a warning, so a failing `prepare` never fails the call.
  - (Decision 1's alternative, rendering at answer, would move this call into `onStatus` for `in-progress`.)
- `routes-webhooks.ts` `onAmd`, after `claimClose` + `silence` + `text`:
  - `const url = (await deps.voicemail?.playUrl(row.id, text, VOICEMAIL_READY_WAIT_MS)) ?? null`
  - Redirect with `url ? voicemailPlayTwiml(url) : voicemailTwiml(text)`.
  - Log `info { aiCallId, voice: url ? 'elevenlabs' : 'say' } 'ai-voice: voicemail left'`.
  - The failure path is unchanged.
- `routes.ts` `defaultDeps`:
  - `voicemailVoiceFor(cfg, log)`; when non-null, `createVoicemailAudio({ render, apiPublicUrl: cfg.API_PUBLIC_URL, ttlMs: (cfg.AI_VOICE_MAX_CALL_SECONDS + REGISTRY_MARGIN_SECONDS) * 1000, log })`.
  - Pass `voicemail` to `registerAiVoiceWebhooks` and to `startDeps`.
  - `if (deps.voicemail) registerVoicemailAudioRoute(app, deps.voicemail)`.
  - Add the GET route to the header comment's route list.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `cd services/cti-api && npx vitest run && npm run typecheck`
Expected: all tests pass (the count is today's plus the new ones), and `tsc` reports no errors.

- [ ] **Step 5: Review, then commit**

Fresh code review of the task diff; fix Critical/High.
```bash
git add services/cti-api/src/ai-voice/twilio.ts services/cti-api/src/ai-voice/twilio.test.ts services/cti-api/src/ai-voice/service.ts services/cti-api/src/ai-voice/service.test.ts services/cti-api/src/ai-voice/routes-webhooks.ts services/cti-api/src/ai-voice/routes.ts services/cti-api/src/ai-voice/routes.test.ts
git commit -m "feat(ai-voice): voicemails play in Sam's voice, Polly when the audio isn't ready"
```

---

## Live check (no seller is ever called)

- [ ] A scratchpad script (not committed) runs the real `renderElevenLabsVoicemail` on
  `voicemailText` with made-up details:
  - first name "Jordan", agent "Sam", company "GG Homes"
  - address "1234 Maple St, San Diego, CA 92101"
  - callback number "+16195550142"
  It writes the exact WAV Twilio would receive to `/Users/cdrshepard/outreach-agent/sam-voicemail-sample.wav` for the
  owner to listen to. The key is read from Railway into memory only.
- [ ] A test call to the owner's own phone happens only if the owner asks for it.
- [ ] Whole-branch review (code-reviewer on the full `git diff origin/main...HEAD`) before anything is pushed.
- [ ] Nothing goes to `main` without the owner's explicit OK. After deploy, the first real voicemail's log line reads
  `voice: 'elevenlabs'`.
