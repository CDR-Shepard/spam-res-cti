# Protocol reference: Twilio Media Streams + OpenAI Realtime (checked 2026-10-04)

## Twilio `<Connect><Stream>` (bidirectional)
Docs: https://www.twilio.com/docs/voice/twiml/stream, https://www.twilio.com/docs/voice/media-streams/websocket-messages

```xml
<Response><Connect>
  <Stream url="wss://HOST/telephony/twilio/ai-voice/stream">
    <Parameter name="aiCallId" value="…"/><Parameter name="token" value="…"/>
  </Stream>
</Connect></Response>
```
- `url` does NOT support query strings; use `<Parameter>` (name+value < 500 chars each). One bidirectional stream per call. Twilio only continues past `</Connect>` when the server closes the WS.

From Twilio (all have `event`, `sequenceNumber`, `streamSid`; numbers arrive as strings):
- `connected` `{event:"connected", protocol:"Call", version:"1.0.0"}`
- `start` `{start:{streamSid, accountSid, callSid, tracks:["inbound"], customParameters:{...}, mediaFormat:{encoding:"audio/x-mulaw", sampleRate:8000, channels:1}}}`
- `media` `{media:{track:"inbound", chunk, timestamp /*ms since stream start, string*/, payload /*base64 μ-law*/}}`
- `mark` `{mark:{name}}` — sent when audio up to that mark has played (or immediately for all pending marks after a `clear`)
- `dtmf` `{dtmf:{track:"inbound_track", digit:"1"}}`
- `stop` `{stop:{accountSid, callSid}}`

To Twilio:
- `{event:"media", streamSid, media:{payload}}` (base64 μ-law 8 kHz, no headers)
- `{event:"mark", streamSid, mark:{name}}`
- `{event:"clear", streamSid}` — empties Twilio's playback buffer

Handshake signature: Twilio sends `X-Twilio-Signature` on the WS upgrade. Validate `twilio.validateRequest(authToken, sig, url, {})` where `url` is the exact `wss://` URL from the TwiML (do not convert to https). If it fails, also try `url + '/'`. Build the URL from configured public host, never the Host header.

```ts
fastify.get('/telephony/twilio/ai-voice/stream', {
  websocket: true,
  preValidation: async (req, reply) => {
    const sig = req.headers['x-twilio-signature'];
    const url = `${wssBase}/telephony/twilio/ai-voice/stream`;
    const ok = typeof sig === 'string' && (twilio.validateRequest(token, sig, url, {}) || twilio.validateRequest(token, sig, url + '/', {}));
    if (!ok) return reply.code(403).send();
  },
}, (socket, req) => { /* @fastify/websocket v10: socket is a ws WebSocket */ });
```

## OpenAI Realtime API (GA)
Docs: https://developers.openai.com/api/docs/guides/realtime-conversations

- Connect: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`, header `Authorization: Bearer $OPENAI_API_KEY` (no `OpenAI-Beta` header). Session limit 60 min.
- Models: `gpt-realtime-2.1` (current; reasoning; 128k), `gpt-realtime-2`, `gpt-realtime-2.1-mini`, `gpt-realtime-1.5`, `gpt-realtime` (2025-08-28), `gpt-realtime-mini`. 2.x: `session.reasoning.effort` ∈ `minimal|low|medium|high|xhigh`; guide recommends `low` for production voice agents. 2.x speaks short preambles while reasoning/calling tools.
- Voices: `alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar` (recommended: `marin`, `cedar`). Voice cannot change after audio was produced.

session.update:
```json
{"type":"session.update","session":{
  "type":"realtime","model":"gpt-realtime-2.1","output_modalities":["audio"],
  "instructions":"...","reasoning":{"effort":"low"},
  "audio":{
    "input":{"format":{"type":"audio/pcmu"},
             "noise_reduction":{"type":"near_field"},
             "transcription":{"model":"gpt-4o-mini-transcribe","language":"en"},
             "turn_detection":{"type":"semantic_vad","eagerness":"auto","create_response":true,"interrupt_response":true}},
    "output":{"format":{"type":"audio/pcmu"},"voice":"marin"}},
  "tools":[{"type":"function","name":"...","description":"...","parameters":{}}],
  "tool_choice":"auto"}}
```
- `server_vad` options: `threshold`, `prefix_padding_ms`, `silence_duration_ms`. `semantic_vad`: `eagerness` (`low|medium|high|auto`).
- `audio/pcmu` both sides → Twilio payloads pass straight through, no transcoding.

Client → server: `input_audio_buffer.append{audio}`, `conversation.item.create{item}`, `response.create`, `response.cancel`, `conversation.item.truncate{item_id, content_index:0, audio_end_ms}` (error if `audio_end_ms` exceeds generated audio — clamp).

Server → client: `session.created`, `session.updated`, `input_audio_buffer.speech_started|speech_stopped|committed`, `response.created`, `response.output_item.added`, `response.output_audio.delta{item_id, delta}`, `response.output_audio.done`, `response.output_audio_transcript.delta|done{transcript}`, `response.function_call_arguments.delta|done`, `response.done{response:{output:[...]}}`, `conversation.item.input_audio_transcription.delta|completed{transcript}`, `error`, `rate_limits.updated`.

Tool calls: on `response.done`, each `response.output[i]` with `type:"function_call"` has `name`, `call_id`, `arguments` (JSON string). Reply `conversation.item.create{item:{type:"function_call_output", call_id, output:"<string>"}}` then `response.create`.

Barge-in: with `interrupt_response: true` the server cancels its response when VAD hears the caller, but over WebSocket you must stop playback (Twilio `clear`) and send `conversation.item.truncate` yourself.

Speak first: `conversation.item.create{item:{type:"message", role:"user", content:[{type:"input_text", text:"..."}]}}` then `response.create`.

## Twilio sample's barge-in algorithm (twilio-samples/speech-assistant-openai-realtime-api-node)
- Track `latestMediaTimestamp` = latest inbound `media.timestamp`.
- On each `response.output_audio.delta`: forward `media` to Twilio; if first delta of this response set `responseStartTimestampTwilio = latestMediaTimestamp`; remember `lastAssistantItem = item_id`; send a `mark` and push onto `markQueue`.
- On Twilio `mark`: shift `markQueue`.
- On `input_audio_buffer.speech_started` with non-empty `markQueue` and a `lastAssistantItem`: `audio_end_ms = latestMediaTimestamp - responseStartTimestampTwilio` → `conversation.item.truncate`; send `clear`; reset queue and both variables.
(The sample is Fastify 5 / @fastify/websocket 11; we use Fastify 4 → @fastify/websocket ^10.0.1 (peer fastify ^4.16), ws ^8.18. Handler `(socket, req)`.)

## Outbound call with async AMD
```ts
client.calls.create({ to, from, twiml, timeout: 30,
  machineDetection: 'DetectMessageEnd', asyncAmd: 'true',
  asyncAmdStatusCallback, asyncAmdStatusCallbackMethod: 'POST',
  machineDetectionSpeechThreshold: 1900, machineDetectionSpeechEndThreshold: 1400,
  statusCallback, statusCallbackEvent: ['initiated','ringing','answered','completed'], statusCallbackMethod: 'POST' });
```
- `twiml` max 4000 chars, beats `url`.
- `DetectMessageEnd`: `human` early; machines report after the beep: `machine_end_beep | machine_end_silence | machine_end_other`; also `fax`, `unknown`. AMD callback body: `CallSid`, `AccountSid`, `AnsweredBy`, `MachineDetectionDuration`.
- Pattern: start the stream immediately; do not let the model speak first; on `machine_end_*` → `calls(sid).update({ twiml: '<Response><Say>…</Say><Hangup/></Response>' })` (deterministic; ends the stream).

## Transfer
`client.calls(callSid).update({ twiml: '<Response><Dial>…</Dial></Response>' })` replaces `<Connect><Stream>`; Twilio sends `stop` and closes the WS. Close the OpenAI socket then.

## Costs
- OpenAI gpt-realtime-2.1: audio in $32 / cached $0.40 / out $64 per 1M tokens (rough: ~$0.10/min of conversation). mini models ~3× cheaper.
- Twilio: Media Streams $0.0044/min, US outbound $0.014/min, AMD $0.0075/call.
